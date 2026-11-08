import type { Locator, Page } from 'playwright-core';
import type { PageActivity } from './pageActivity';
import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type WorkflowStep, type WorkflowStepFingerprint,
} from '../../shared-types';

// Finds the element a recorded step acts on. No model, no guessing:
//   1. the saved locator (Playwright's selector from recording time);
//   2. if that matches nothing, or more than one element, the fingerprint:
//      test id, role + accessible name, label, placeholder, name attribute,
//      narrowed by the nearest heading and the recorded position (ordinal),
//      and only on the page path the step was recorded on.
// Either way it must come down to exactly one element; anything else is a
// miss and the run stops.

export type FindResult =
  | { found: true; locator: Locator; resolvedBy: 'primary' | 'fallback'; how: string; note?: string }
  | { found: false; reason: string; tried: string[]; ambiguous?: boolean };

export interface FindOptions {
  value?: string; // goes into {{value}} in the locator and fingerprint
  // The value recorded for this step. A position (nth=) in a value-bound
  // locator belongs to the recorded value; it is kept only when they match.
  recordedValue?: string;
  primaryTimeoutMs: number;
  fallbackTimeoutMs: number;
  signal?: AbortSignal; // the run was stopped: give up at once
  // The page's activity (pageActivity.ts). With it, the wait for the saved
  // locator ends early once the page has settled: see SETTLED_MS.
  activity?: PageActivity;
}

const POLL_MS = 200;
// The saved locator is waited for until the page settles, not for the whole
// primaryTimeoutMs: once the step has waited this long and the page has been
// quiet this long (loaded, no requests, no nodes added or removed), the
// element isn't coming, and the fingerprint is tried at once. A page still
// loading or busy gets the full timeout, as before.
export const SETTLED_MS = 2_000;
const NTH = /\s*>>\s*nth=(-?\d+)\s*$/;

// Playwright's quoted selector strings escape backslash and double quote.
// A value with a quote in it would otherwise end the string early and break
// (or change) the selector.
export function escapeForSelector(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// The recorder's templates come from Playwright's own selectors, whose
// `[name="..."i]` means "contains, ignoring case". For a value given at run
// time that would let "Rhode" click "Rhode Island". So the slot is made an
// exact match (`"s`) first; an exact match ignoring case is the fallback's job.
export function fillTemplate(locator: string, value: string): string {
  const exact = locator.split(`"${WORKFLOW_VALUE_PLACEHOLDER}"i`).join(`"${WORKFLOW_VALUE_PLACEHOLDER}"s`);
  return exact.split(WORKFLOW_VALUE_PLACEHOLDER).join(escapeForSelector(value));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Fingerprint strings hold the plain value (they aren't selectors).
export function fillFingerprint(fp: WorkflowStepFingerprint, value: string | undefined): WorkflowStepFingerprint {
  if (value === undefined) return fp;
  const out: WorkflowStepFingerprint = { ...fp };
  for (const k of Object.keys(out) as (keyof WorkflowStepFingerprint)[]) {
    const v = out[k];
    if (typeof v === 'string' && v.includes(WORKFLOW_VALUE_PLACEHOLDER)) {
      (out as Record<string, unknown>)[k] = v.split(WORKFLOW_VALUE_PLACEHOLDER).join(value);
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Exactly one element, or why not. When several match but only one is
// visible (a hidden mobile copy of a menu), the visible one counts.
async function single(locator: Locator): Promise<{ one?: Locator; count: number }> {
  const count = await locator.count().catch(() => 0);
  if (count === 1) return { one: locator, count };
  if (count > 1) {
    const visible = locator.filter({ visible: true });
    if ((await visible.count().catch(() => 0)) === 1) return { one: visible, count };
  }
  return { count };
}

// Text of the last heading before the element in document order: what the
// recorder stored as the fingerprint's heading.
const NEAREST_HEADING = (el: any): string | null => {
  const doc = el.ownerDocument;
  const heads = doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]');
  let last: string | null = null;
  for (const h of heads) {
    // 4 = DOCUMENT_POSITION_FOLLOWING: el comes after h.
    if (h.compareDocumentPosition(el) & 4) last = (h.textContent || '').replace(/\s+/g, ' ').trim();
    else break;
  }
  return last;
};

function pathOf(url: string): string | undefined {
  try { return new URL(url).pathname; } catch { return undefined; }
}

interface Candidate { how: string; locator: Locator; byRoleName?: boolean }

function candidates(page: Page, fp: WorkflowStepFingerprint, valueBound = false): Candidate[] {
  const out: Candidate[] = [];
  if (fp.testId) out.push({ how: 'test id', locator: page.getByTestId(fp.testId) });
  if (fp.role && fp.name) {
    const role = fp.role as Parameters<Page['getByRole']>[0];
    out.push({ how: 'role and name', locator: page.getByRole(role, { name: fp.name, exact: true }), byRoleName: true });
    // A value typed for the run may differ only in case ("ohio" for "Ohio").
    // Still the whole name, never part of it.
    if (valueBound) {
      out.push({
        how: 'role and name, ignoring case',
        locator: page.getByRole(role, { name: new RegExp(`^${escapeRegExp(fp.name.trim())}$`, 'i') }),
        byRoleName: true,
      });
    }
  }
  if (fp.label) out.push({ how: 'label', locator: page.getByLabel(fp.label, { exact: true }) });
  if (fp.placeholder) out.push({ how: 'placeholder', locator: page.getByPlaceholder(fp.placeholder, { exact: true }) });
  if (fp.nameAttr) {
    const tag = fp.tag && /^[a-z]+$/i.test(fp.tag) ? fp.tag : '';
    out.push({ how: 'name attribute', locator: page.locator(`${tag}[name="${escapeForSelector(fp.nameAttr)}"]`) });
  }
  return out;
}

async function tryFallback(
  page: Page, fp: WorkflowStepFingerprint, useOrdinal: boolean, valueBound: boolean,
): Promise<{ hit?: Candidate & { locator: Locator }; ambiguous: boolean }> {
  let ambiguous = false;
  for (const c of candidates(page, fp, valueBound)) {
    const { one, count } = await single(c.locator);
    if (one) return { hit: { ...c, locator: one }, ambiguous: false };
    if (count <= 1) continue;
    // Several: narrow by the nearest heading, then by recorded position.
    let pool: Locator[] = [];
    for (let i = 0; i < count; i++) pool.push(c.locator.nth(i));
    if (fp.heading) {
      const under: Locator[] = [];
      for (const l of pool) {
        const h = await l.evaluate(NEAREST_HEADING).catch(() => null);
        if (h === fp.heading) under.push(l);
      }
      if (under.length === 1) return { hit: { ...c, locator: under[0], how: `${c.how} under "${fp.heading}"` }, ambiguous: false };
      if (under.length > 1) pool = under;
    }
    if (useOrdinal && c.byRoleName && fp.ordinal !== undefined && pool.length === count && fp.ordinal < count) {
      return { hit: { ...c, locator: c.locator.nth(fp.ordinal), how: `${c.how}, number ${fp.ordinal + 1} of ${count}` }, ambiguous: false };
    }
    ambiguous = true;
  }
  return { ambiguous };
}

export async function findElement(page: Page, step: WorkflowStep, opts: FindOptions): Promise<FindResult> {
  const tried: string[] = [];
  const valueBound = step.valueTarget === 'locator';
  const positionStale = valueBound && opts.value !== undefined && opts.value !== opts.recordedValue;
  const fp = fillFingerprint(step.fingerprint, valueBound ? opts.value : undefined);

  // 1. The saved locator.
  let primary = step.locator;
  let note: string | undefined;
  if (primary && valueBound) {
    if (opts.value === undefined) return { found: false, reason: 'no value for this step', tried };
    primary = fillTemplate(primary, opts.value);
    // nth=K picked the recorded value out of several with the same name.
    // A different value has its own duplicates, or none, so K means nothing.
    if (positionStale && NTH.test(primary)) {
      primary = primary.replace(NTH, '');
      note = 'Ignored the recorded position: it was for a different value.';
    }
  }

  let ambiguousPrimary = false;
  let settled = false; // the wait above ended because the page went quiet
  if (primary) {
    tried.push('saved locator');
    const loc = page.locator(primary);
    const start = Date.now();
    const deadline = start + opts.primaryTimeoutMs;
    for (;;) {
      const { one, count } = await single(loc);
      if (one) return { found: true, locator: one, resolvedBy: 'primary', how: 'saved locator', note };
      // Still more than one after a moment: the page has settled, waiting won't help.
      if (count > 1 && Date.now() - start > 1500) { ambiguousPrimary = true; break; }
      if (Date.now() >= deadline || opts.signal?.aborted) break;
      if (opts.activity && Date.now() - start >= SETTLED_MS && (await opts.activity.quietMs()) >= SETTLED_MS) {
        settled = true;
        break;
      }
      await sleep(POLL_MS);
    }
  }

  // 2. The fingerprint. Only on the page the step was recorded on: the same
  // role and name on another page is a different element.
  const here = pathOf(page.url());
  if (fp.urlPath && here !== undefined && here !== fp.urlPath) {
    return {
      found: false, tried,
      reason: ambiguousPrimary ? 'several elements match' : 'not found on this page',
    };
  }
  // A settled page won't change while the fingerprint is tried: one pass.
  const deadline = Date.now() + (settled ? 0 : opts.fallbackTimeoutMs);
  let ambiguous = ambiguousPrimary;
  for (;;) {
    const r = await tryFallback(page, fp, !positionStale, valueBound);
    if (r.hit) {
      return { found: true, locator: r.hit.locator, resolvedBy: 'fallback', how: r.hit.how, note };
    }
    ambiguous = ambiguous || r.ambiguous;
    if (Date.now() >= deadline || opts.signal?.aborted) break;
    await sleep(POLL_MS);
  }
  for (const c of candidates(page, fp, valueBound)) tried.push(c.how);
  return { found: false, tried, ambiguous, reason: ambiguous ? 'several elements match' : 'not found' };
}
