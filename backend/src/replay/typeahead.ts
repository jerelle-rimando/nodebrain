import type { Locator } from 'playwright-core';
import type { PageActivity } from './pageActivity';

// Typeahead fields (a text box with a suggestion list: "What state is your
// business in?"). A recording saves picking from one as typing the text and
// then either pressing Enter in the box, or clicking an option in the list.
//
// Typing at replay speed races the page. Playwright's fill puts the whole
// text in at once, and the widget re-filters its list afterwards, on its own
// schedule. Measured on simplybusiness.com (2026-11-11): for ~30 ms after
// fill('Florida') the list still held all 51 states with Alabama highlighted,
// and the highlighted option kept the same id (P0-2-option-0) when it
// changed to Florida. The replay pressed Enter ~20 ms after the fill and got
// Alabama in 10 runs of 10.
//
// So two things happen around a pick:
//   1. before Enter: wait until the highlighted option is what was typed,
//      or the list has stopped changing (waitForList);
//   2. after the pick: read the box back and compare it to the value meant
//      (readBack). A mismatch stops the run. The wait in 1 is only a
//      courtesy: on a slow enough page it will lose a race, and 2 is what
//      keeps a wrong value from going any further.

// The box's live state, read in the page. Option lists are often in a shadow
// root (simplybusiness.com's is) and linked by aria-activedescendant or
// aria-controls ids, which document.getElementById doesn't see into.
//
// No named functions inside: the dev server (tsx/esbuild) wraps them in a
// __name() helper that doesn't exist in the page, and the call throws.
const LIST_STATE = (el: any): { value: string | null; active: string | null; list: string } => {
  const doc = el.ownerDocument;
  const ids: string[] = [];
  const ad = el.getAttribute('aria-activedescendant');
  if (ad) ids.push(ad);
  for (const id of `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/)) if (id) ids.push(id);
  // Every root an id could be in: the document, then each open shadow root.
  const roots: any[] = [doc];
  if (ids.some((id) => !doc.getElementById(id))) {
    for (let i = 0; i < roots.length; i++) {
      for (const n of roots[i].querySelectorAll('*')) if (n.shadowRoot) roots.push(n.shadowRoot);
    }
  }
  const found = new Map<string, any>();
  for (const id of ids) {
    for (const r of roots) { const hit = r.getElementById?.(id); if (hit) { found.set(id, hit); break; } }
  }
  let active = ad ? found.get(ad) ?? null : null;
  let listbox: any = null;
  for (const id of ids) {
    const n = id === ad ? null : found.get(id);
    if (n) { listbox = n.matches('[role=listbox]') ? n : n.querySelector('[role=listbox]') ?? n; break; }
  }
  listbox ??= active?.closest('[role=listbox]') ?? null;
  const options: any[] = listbox ? Array.from(listbox.querySelectorAll('[role=option]')) : [];
  if (!active && listbox) active = listbox.querySelector('[role=option][aria-selected=true]');
  const texts = [active, ...options.slice(0, 30)].map((n) =>
    n ? String(n.getAttribute('aria-label') || n.textContent || '').replace(/\s+/g, ' ').trim() : null);
  return {
    value: typeof el.value === 'string' ? el.value : null,
    active: texts[0],
    list: `${options.length}:${texts.slice(1).join('\u0001')}`,
  };
};

// A text box that offers a list to pick from.
const IS_TYPEAHEAD = (el: any): boolean => {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return false;
  return el.getAttribute('role') === 'combobox'
    || /^(list|both)$/i.test(el.getAttribute('aria-autocomplete') ?? '')
    || el.getAttribute('aria-haspopup') === 'listbox';
};

export async function isTypeahead(el: Locator): Promise<boolean> {
  return el.evaluate(IS_TYPEAHEAD).catch(() => false);
}

// Same choice: case and runs of spaces don't count ("florida" picks Florida).
export function sameValue(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

// The highlighted option is offering the value: its text is the value, or
// starts with it ("Roofing" + its description "Installs, repairs…" on
// simplybusiness.com, where options carry a second line). Only for deciding
// the list has caught up, never for passing a pick: readBack is exact.
export function offers(optionText: string, value: string): boolean {
  const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  const v = norm(value);
  return v !== '' && norm(optionText).startsWith(v);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const LIST_WAIT_MAX_MS = 5_000;
// The list counts as settled once it and the page have both been still this
// long: longer than the usual typeahead debounce (150–300 ms), so a search
// that hasn't started its request yet isn't mistaken for a settled list.
export const LIST_STILL_MS = 1_000;
const POLL_MS = 50;

export interface ListWait {
  // The highlighted option once the wait ended (null: the box has none).
  active: string | null;
  how: 'matched' | 'settled' | 'timed out';
  waitedMs: number;
}

// Waits until the list shows what was typed: its highlighted option offers
// the value. Ends sooner when nothing is highlighted, or when the list and the
// page have both been still for LIST_STILL_MS (a value that isn't an option
// name, like a partial "Tex"); and at LIST_WAIT_MAX_MS whatever happens.
export async function waitForList(
  el: Locator, value: string, opts: { activity?: PageActivity; signal?: AbortSignal; maxMs?: number } = {},
): Promise<ListWait> {
  const start = Date.now();
  const max = opts.maxMs ?? LIST_WAIT_MAX_MS;
  let last: string | undefined;
  let stillSince = start;
  let active: string | null = null;
  for (;;) {
    // Unreadable (the box is being re-rendered, or the page script failed):
    // nothing to match, so only the stillness rule below can end the wait.
    const s = await el.evaluate(LIST_STATE).catch(() => null);
    const waitedMs = Date.now() - start;
    active = s?.active ?? null;
    if (active !== null && offers(active, value)) return { active, how: 'matched', waitedMs };
    const sig = s ? `${s.value}\u0002${s.active}\u0002${s.list}` : 'unreadable';
    if (sig !== last) { last = sig; stillSince = Date.now(); }
    const still = Date.now() - stillSince >= LIST_STILL_MS
      && (!opts.activity || (await opts.activity.quietMs()) >= LIST_STILL_MS);
    if (still) return { active, how: 'settled', waitedMs };
    if (waitedMs >= max || opts.signal?.aborted) return { active, how: 'timed out', waitedMs };
    await sleep(POLL_MS);
  }
}

export type ReadBack = { ok: true; shown: string } | { ok: false; shown: string | null };

// What the box shows after the pick, compared with the value meant. Widgets
// often write the choice into the box a moment after the key or click, so a
// match is waited for briefly; anything else at the end is a mismatch.
// shown is null when the box couldn't be read (gone from the page).
export async function readBack(el: Locator, intended: string, timeoutMs = 2_000): Promise<ReadBack> {
  const deadline = Date.now() + timeoutMs;
  let shown: string | null = null;
  for (;;) {
    shown = await el.inputValue({ timeout: 500 }).catch(() => null);
    if (shown !== null && sameValue(shown, intended)) return { ok: true, shown };
    if (Date.now() >= deadline) return { ok: false, shown };
    await sleep(100);
  }
}
