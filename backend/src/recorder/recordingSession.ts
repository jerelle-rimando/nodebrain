import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserContext, Page } from 'playwright-core';
import {
  SITE_LOGIN_PROVIDER,
  type RecordingState, type RecordingStatus, type RecordingResult, type RecordingDraft,
  type RecordedValueChoice, type SaveRecordingRequest,
  type WorkflowStepAction, type WorkflowStepFingerprint, type WorkflowSignal,
} from '../../shared-types';
import { getDataDir, dbTransaction } from '../db/database';
import {
  getSiteAgentBySiteKey, createSiteAgent, updateSiteAgent, createWorkflow, createVersion, createField,
  type StepInput,
} from '../db/workflowRepository';
import { createCredential, updateCredential, getCredentialById } from '../vault/credentialVault';
import { launchBrowser, closeBrowser, type LaunchedBrowser } from './browserLauncher';
import { siteBrowserHolder } from '../browser/siteBrowserLock';
import { PAGE_SCRIPT, RECORDER_BINDING, PILL_HOST_ID, SET_COUNT_FN } from './pageScript';
import { factsForRef, redactSnapshot, type SnapshotFacts } from './ariaSnapshot';
import { siteKeyFromUrl, siteNameFromKey, siteKeyToFolderName } from './siteIdentity';
import { guessName, valueRows, templateLocator, templateFingerprint, fieldKeyFor, type DraftStep } from './reviewDraft';

// One recording: the user does a task in a real browser window while
// Playwright's recorder reports each action. No model is involved.
//
// Per action NodeBrain keeps:
//   - Playwright's selector (primary locator; 27/29 re-found on fresh loads
//     and after a browser restart in the 2026-11 check),
//   - its own fingerprint, merged from the page's event-time record
//     (pageScript.ts) and the action's aria snapshot (ariaSnapshot.ts),
//   - the aria snapshot itself, written to disk on Done (redacted).
//
// Typed passwords never become step values: they go to the vault as a site
// login, and the step points at it (value_source 'credential').

export const recorderEvents = new EventEmitter();

// What Playwright's programmatic recorder ("api" mode) reports per action.
interface RecorderAction {
  name: string;
  selector?: string;
  ref?: string;
  ariaSnapshot?: string;
  url?: string;
  text?: string;
  key?: string;
  modifiers?: number;
  button?: string;
  clickCount?: number;
  position?: { x: number; y: number };
  options?: string[];
  files?: string[];
}

// What pageScript.ts sends at event time.
interface PageRecord {
  kind: 'click' | 'input' | 'change' | 'keydown';
  key?: string;
  detail?: number;
  docId: string;
  elementId: number;
  ts: number; // when NodeBrain received it
  pageTs: number; // when it happened, by the page's clock (same machine)
  fp: {
    tag?: string; inputType?: string; autocomplete?: string; nameAttr?: string; testId?: string;
    label?: string; placeholder?: string; urlPath?: string; origin?: string; framePath?: string[]; title?: string;
    names?: string[]; optionLabels?: string[];
  };
  page: Page;
  consumed: boolean;
  // Effects (navigation, dialog, popup) seen before the action arrived.
  pendingSignals?: WorkflowSignal[];
}

interface CapturedStep {
  action: WorkflowStepAction;
  recorderName: string;
  locator?: string;
  fingerprint: WorkflowStepFingerprint;
  facts: SnapshotFacts;
  pageAlias: string;
  origin?: string;
  args: Record<string, unknown>;
  value?: string; // plaintext recorded value; never a password or saved username
  usesSavedLogin?: 'username' | 'password';
  record?: PageRecord;
  signals: WorkflowSignal[];
  snapshot?: string;
  ref?: string;
  at: number;
  // When the person acted (page clock, same machine): orders mouse-down
  // picks, which are reported 500 ms late, among the other steps.
  eventTs: number;
  // Built from a mouse-down pick (pageScript.ts), not reported by Playwright.
  picked?: boolean;
  opening?: boolean; // the page load NodeBrain did to start; not counted in the pill
}

type RecorderSink = {
  actionAdded: (page: Page, action: RecorderAction) => void;
  actionUpdated: (page: Page, action: RecorderAction) => void;
  signalAdded: (page: Page, signal: unknown) => void;
};
type RecordingContext = BrowserContext & {
  _startRecording?: (params: { language: string }, sink: RecorderSink) => Promise<void>;
  _stopRecording?: () => Promise<void>;
};

const PASSWORD_NAME = /\b(password|passcode|passphrase|pwd|pin)\b/i;
const USERNAME_HINT = /\b(user(name)?|e-?mail|login|account|user ?id|member ?id)\b/i;
const SAVED_RESULT_TTL_MS = 60 * 60 * 1000;

const sessions = new Map<string, RecordingSession>();

export class RecordingError extends Error {}

export async function startRecording(url: string): Promise<RecordingStatus> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RecordingError("That doesn't look like a web address. Try something like https://example.com.");
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RecordingError('Recording works on web pages only (addresses starting with http:// or https://).');
  }
  const siteKey = siteKeyFromUrl(parsed.href);
  pruneSessions();
  if (siteBrowserHolder(siteKey)) {
    throw new RecordingError(`A workflow is running on ${siteKey} right now. Wait for it to finish, then start recording.`);
  }
  for (const s of sessions.values()) {
    if (s.siteKey === siteKey && (s.state === 'recording' || s.state === 'saving')) {
      throw new RecordingError(`A recording for ${siteKey} is already open. Finish or throw away that one first.`);
    }
  }
  const session = new RecordingSession(parsed.href, siteKey);
  sessions.set(session.id, session);
  try {
    await session.start();
  } catch (err) {
    sessions.delete(session.id);
    throw err;
  }
  return session.status();
}

export function getRecording(id: string): RecordingStatus | null {
  return sessions.get(id)?.status() ?? null;
}

export function listRecordings(): RecordingStatus[] {
  pruneSessions();
  return [...sessions.values()].map((s) => s.status());
}

export async function finishRecording(id: string): Promise<RecordingStatus> {
  const s = sessions.get(id);
  if (!s) throw new RecordingError('That recording is no longer open.');
  await s.finish();
  return s.status();
}

// Saves a recording that's waiting on the review screen.
export async function saveRecording(id: string, req: SaveRecordingRequest): Promise<RecordingStatus> {
  const s = sessions.get(id);
  if (!s) throw new RecordingError('That recording is no longer open.');
  await s.saveReview(req);
  return s.status();
}

export async function discardRecording(id: string): Promise<RecordingStatus> {
  const s = sessions.get(id);
  if (!s) throw new RecordingError('That recording is no longer open.');
  await s.discard();
  return s.status();
}

function pruneSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.endedAt && now - s.endedAt > SAVED_RESULT_TTL_MS) sessions.delete(id);
  }
}

class RecordingSession {
  readonly id = uuidv4();
  readonly siteName: string;
  readonly profileDir: string;
  state: RecordingState = 'recording';
  endedAt?: number;
  private error?: string;
  private result?: RecordingResult;
  private draft?: RecordingDraft;
  private launched?: LaunchedBrowser;
  private steps: CapturedStep[] = [];
  private records: PageRecord[] = [];
  private aliases = new Map<Page, string>();
  private queue: Promise<void> = Promise.resolve();
  private finishing?: Promise<void>;
  // Set the moment Done or discard is pressed: new pill commands are ignored.
  private stopping = false;
  private discarding = false;

  // Actions and page records already in flight when Done is pressed are
  // still processed while saving; discarding drops them.
  private accepting(): boolean {
    return !this.discarding && (this.state === 'recording' || this.state === 'saving');
  }
  // Sign-in typed during the recording. Held in memory only until Done
  // (then encrypted into the vault) or discard (then dropped).
  private password?: string;
  private username?: string;
  private secretRefs = new Set<string>();

  constructor(readonly startUrl: string, readonly siteKey: string) {
    this.siteName = siteNameFromKey(siteKey);
    this.profileDir = path.join(getDataDir(), 'browser-profiles', siteKeyToFolderName(siteKey));
  }

  status(): RecordingStatus {
    return {
      id: this.id, siteKey: this.siteKey, siteName: this.siteName, startUrl: this.startUrl,
      state: this.state, stepCount: this.stepCount(), error: this.error, draft: this.draft, result: this.result,
    };
  }

  private stepCount(): number {
    return this.steps.filter((s) => !s.opening).length;
  }

  async start(): Promise<void> {
    this.launched = await launchBrowser(this.profileDir, this.startUrl);
    const context = this.launched.context as RecordingContext;
    if (typeof context._startRecording !== 'function') {
      await closeBrowser(this.launched);
      throw new RecordingError("This copy of NodeBrain can't record yet: its browser library is too old.");
    }
    await context.exposeBinding(RECORDER_BINDING, (source, msg) => this.onPageMessage(source.page, msg));
    await context.addInitScript(PAGE_SCRIPT);

    for (const p of context.pages()) this.watchPage(p);
    context.on('page', (p) => {
      this.watchPage(p);
      const opener = this.records.length ? this.records[this.records.length - 1].page : undefined;
      if (opener) this.signalFromInteraction(opener, { name: 'popup', popupAlias: this.aliasOf(p) });
    });
    this.launched.browser.on('disconnected', () => {
      if (this.state === 'recording' && !this.stopping) {
        this.state = 'browser_closed';
        recorderEvents.emit('recording:browser_closed', this.status());
      }
    });

    await context._startRecording({ language: 'playwright-test' }, {
      actionAdded: (page, action) => this.enqueue(() => this.onAction('added', page, action)),
      actionUpdated: (page, action) => this.enqueue(() => this.onAction('updated', page, action)),
      // Not seen over CDP in testing; navigation/popup/dialog signals are
      // collected from page events instead (watchPage).
      signalAdded: () => {},
    });

    const page = context.pages()[0] ?? (await context.newPage());
    this.markNextNavigateAsOpening = true;
    await page.goto(this.startUrl, { timeout: 60_000 }).catch(() => {
      // A slow site still opens; the user can wait or reload. The recorder
      // keeps listening either way.
    });
    await page.bringToFront().catch(() => {});
  }

  private markNextNavigateAsOpening = false;

  private aliasOf(page: Page): string {
    let alias = this.aliases.get(page);
    if (!alias) {
      alias = this.aliases.size === 0 ? 'page' : `popup${this.aliases.size}`;
      this.aliases.set(page, alias);
    }
    return alias;
  }

  private watchPage(page: Page): void {
    this.aliasOf(page);
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || !this.accepting()) return;
      this.signalFromInteraction(page, { name: 'navigation', url: frame.url() });
    });
    // A listener stops Playwright from auto-dismissing dialogs; the person
    // answers them in the window as usual.
    page.on('dialog', () => {
      if (this.accepting()) this.signalFromInteraction(page, { name: 'dialog' });
    });
  }

  // Navigations, dialogs and popups belong to the interaction that caused
  // them. The page's event-time record reaches NodeBrain before the effect
  // does (it's sent from the click listener, before the site's own handler
  // runs), while the recorder's action can arrive after it: a confirm()
  // blocks the page until it's answered. So the signal goes on the most
  // recent record from the last few seconds, and through it on the step
  // that record is (or will be) paired with. No recent record means the
  // person caused it some other way (typing an address, an alert on page
  // load), and the recorder logs that itself.
  private signalFromInteraction(page: Page, signal: WorkflowSignal): void {
    const cutoff = Date.now() - 3_000;
    let rec: PageRecord | undefined;
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.ts < cutoff) break;
      if (r.page === page && r.kind !== 'input') { rec = r; break; }
    }
    if (!rec) return;
    const step = this.steps.find((s) => s.record === rec);
    const target = step ? step.signals : (rec.pendingSignals ??= []);
    if (!target.some((s) => s.name === signal.name)) target.push(signal);
  }

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      console.error('[recorder] could not process an action:', err);
    });
  }

  private onPageMessage(page: Page, msg: unknown): unknown {
    if (!msg || typeof msg !== 'object') return undefined;
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'hello':
        return { count: this.stepCount() };
      case 'done':
        void this.finish();
        return undefined;
      case 'discard':
        void this.discard();
        return undefined;
      case 'pick':
        if (this.accepting()) this.enqueue(() => this.onPick(page, m));
        return undefined;
      case 'event': {
        if (!this.accepting()) return undefined;
        const kind = m.kind;
        if (kind !== 'click' && kind !== 'input' && kind !== 'change' && kind !== 'keydown') return undefined;
        this.records.push({
          kind, key: typeof m.key === 'string' ? m.key : undefined,
          detail: typeof m.detail === 'number' ? m.detail : undefined,
          docId: typeof m.docId === 'string' ? m.docId : '',
          elementId: typeof m.elementId === 'number' ? m.elementId : -1,
          ts: Date.now(), pageTs: typeof m.ts === 'number' ? m.ts : Date.now(),
          fp: (m.fp && typeof m.fp === 'object' ? m.fp : {}) as PageRecord['fp'],
          page, consumed: false,
        });
        const cutoff = Date.now() - 15_000;
        this.records = this.records.filter((r) => r.ts >= cutoff || !r.consumed).slice(-300);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // Pairs a recorder action with the page's event-time record for the same
  // element: same page, compatible event, preferring a record whose element
  // text matches the accessible name in the snapshot. Waits briefly, since
  // the two arrive over separate channels.
  private async matchRecord(page: Page, action: RecorderAction, facts: SnapshotFacts): Promise<PageRecord | undefined> {
    const kinds: Record<string, PageRecord['kind'][]> = {
      click: ['click'], check: ['click', 'change'], uncheck: ['click', 'change'],
      fill: ['input'], select: ['change'], setInputFiles: ['change'], press: ['keydown'],
    };
    const wanted = kinds[action.name];
    if (!wanted) return undefined;
    const name = facts.name?.toLowerCase();
    const fits = (r: PageRecord): boolean => {
      const t = r.fp.inputType;
      switch (action.name) {
        case 'select': return r.fp.tag === 'select';
        case 'fill': return r.fp.tag !== 'select' && !['checkbox', 'radio', 'file', 'submit', 'button'].includes(t ?? '');
        case 'setInputFiles': return t === 'file';
        case 'check': case 'uncheck': return r.fp.tag !== 'input' || t === 'checkbox' || t === 'radio';
        case 'press': return r.key === action.key;
        default: return true;
      }
    };
    const pick = (): PageRecord | undefined => {
      const recent = Date.now() - 10_000;
      const candidates = this.records.filter((r) => !r.consumed && r.page === page && r.ts >= recent
        && wanted.includes(r.kind) && fits(r));
      if (!candidates.length) return undefined;
      if (name) {
        const byName = candidates.find((r) => (r.fp.names ?? []).some((n) => {
          const t = n.toLowerCase();
          return t === name || t.includes(name) || name.includes(t);
        }));
        if (byName) return byName;
      }
      // Playwright reports actions in the order they happened, sometimes
      // well after the fact on large pages; the oldest unclaimed event is
      // this action's.
      return candidates[0];
    };
    let found = pick();
    for (let i = 0; i < 6 && !found; i++) {
      await new Promise((r) => setTimeout(r, 50));
      found = pick();
    }
    if (found) this.consume(found);
    return found;
  }

  // Uses up every earlier event from the same element, so a field's leftover
  // events (its change on leaving it) can't be paired with a later step.
  private consume(rec: PageRecord): void {
    for (const r of this.records) {
      if (sameElement(r, rec) && r.ts <= rec.ts) r.consumed = true;
    }
    rec.consumed = true;
  }

  private async onAction(kind: 'added' | 'updated', page: Page, action: RecorderAction): Promise<void> {
    if (!this.accepting()) return;
    if (action.selector?.includes(PILL_HOST_ID)) return; // a click on our own pill
    if (['openPage', 'closePage'].includes(action.name) || action.name.startsWith('assert')) return;

    const last = this.steps[this.steps.length - 1];

    // Typing arrives as one fill updated per keystroke. A mouse-down pick may
    // have been slotted in after the field being typed into; skip past it.
    const lastRecorded = [...this.steps].reverse().find((s) => !s.picked);
    if (kind === 'updated' && lastRecorded && lastRecorded.recorderName === action.name) {
      await this.updateStep(lastRecorded, page, action);
      return;
    }
    if (kind === 'updated' && last && last.recorderName === action.name) {
      await this.updateStep(last, page, action);
      return;
    }

    // Pressing Enter (or Space) on a form makes the browser fire a click on
    // the submit button with detail 0. Replaying both would submit twice.
    if (action.name === 'click' && action.clickCount === 0 && last?.action === 'press'
        && (last.args.key === 'Enter' || last.args.key === ' ') && Date.now() - last.at < 2000) {
      return;
    }

    const step = await this.buildStep(page, action);
    if (!step) return;
    // No page event to time it by: it follows the previous recorded step.
    const prevRecorded = [...this.steps].reverse().find((s) => !s.picked);
    if (!step.record && prevRecorded) step.eventTs = Math.min(step.eventTs, prevRecorded.eventTs + 1);
    // Goes ahead of any mouse-down pick that happened after it (picks are
    // reported 500 ms late, so one may already be in the list).
    let at = this.steps.length;
    while (at > 0 && this.steps[at - 1].picked && this.steps[at - 1].eventTs > step.eventTs) at--;
    this.steps.splice(at, 0, step);
    this.pushCount();
    recorderEvents.emit('recording:step', { id: this.id, stepCount: this.stepCount() });
  }

  // An option chosen on mouse-down (see pageScript.ts). Playwright reported
  // nothing for it, so NodeBrain builds the step: a role locator with the
  // option's exact name, which is how Playwright itself would name a
  // role=option element, plus nth when several options share that name.
  private async onPick(page: Page, m: Record<string, unknown>): Promise<void> {
    if (!this.accepting()) return;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const role = str(m.role);
    const name = str(m.name);
    if (!role || !name || !/^[a-z]+$/.test(role)) return;
    const ordinal = typeof m.ordinal === 'number' ? m.ordinal : 0;
    const sameCount = typeof m.sameCount === 'number' ? m.sameCount : 1;
    const fp = (m.fp && typeof m.fp === 'object' ? m.fp : {}) as PageRecord['fp'];
    const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const scope = m.inListbox === true ? 'internal:role=listbox >> ' : '';
    const locator = `${scope}internal:role=${role}[name="${escaped}"s]` + (sameCount > 1 ? ` >> nth=${ordinal}` : '');
    // Lists are often appended at the end of the page (Select2), where the
    // nearest heading is unrelated; the opener's section heading is the right one.
    const opener = [...this.steps].reverse().find((s) => s.pageAlias === this.aliasOf(page) && !s.picked);
    const heading = (opener && opener.action !== 'navigate' ? opener.fingerprint.heading : undefined) ?? str(m.heading);
    const facts: SnapshotFacts = { role, name, heading, container: str(m.container), ordinal };
    const record: PageRecord = {
      kind: 'click', docId: str(m.docId) ?? '', elementId: typeof m.elementId === 'number' ? m.elementId : -1,
      ts: Date.now(), pageTs: typeof m.ts === 'number' ? m.ts : Date.now(), fp, page, consumed: true,
    };
    const step: CapturedStep = {
      action: 'click',
      recorderName: 'click',
      locator,
      fingerprint: this.fingerprintOf(facts, record),
      facts,
      record,
      pageAlias: this.aliasOf(page),
      origin: fp.origin ?? safeOrigin(page.url()),
      args: { button: 'left', modifiers: 0, clickCount: 1, selectsOn: 'mousedown' },
      signals: [],
      at: Date.now(),
      eventTs: record.pageTs,
      picked: true,
    };
    // Reported 500 ms after the fact: put it back where it happened.
    let i = this.steps.length;
    while (i > 0 && this.steps[i - 1].eventTs > step.eventTs) i--;
    this.steps.splice(i, 0, step);
    this.pushCount();
    recorderEvents.emit('recording:step', { id: this.id, stepCount: this.stepCount() });
  }

  private async buildStep(page: Page, action: RecorderAction): Promise<CapturedStep | undefined> {
    const facts = factsForRef(action.ariaSnapshot, action.ref);
    const record = await this.matchRecord(page, action, facts);
    const base = {
      recorderName: action.name,
      locator: action.selector,
      facts,
      record,
      fingerprint: this.fingerprintOf(facts, record),
      pageAlias: this.aliasOf(page),
      origin: record?.fp.origin ?? safeOrigin(page.url()),
      signals: [...(record?.pendingSignals ?? [])] as WorkflowSignal[],
      snapshot: action.ariaSnapshot,
      ref: action.ref,
      at: Date.now(),
      eventTs: record?.pageTs ?? Date.now(),
    };

    switch (action.name) {
      case 'navigate': {
        const opening = this.markNextNavigateAsOpening;
        this.markNextNavigateAsOpening = false;
        // The recorder logs typed addresses as their own step. If that page
        // load was also pinned on a recent interaction, it wasn't caused by it.
        for (const s of this.steps.slice(-3)) {
          s.signals = s.signals.filter((sig) => !(sig.name === 'navigation' && sig.url === action.url));
        }
        return { ...base, action: 'navigate', locator: undefined, origin: safeOrigin(action.url ?? ''), args: { url: action.url }, opening };
      }
      case 'click':
        return {
          ...base, action: 'click',
          args: { button: action.button ?? 'left', modifiers: action.modifiers ?? 0, clickCount: action.clickCount ?? 1,
                  ...(action.position ? { position: action.position } : {}) },
        };
      case 'press':
        return { ...base, action: 'press', args: { key: action.key, modifiers: action.modifiers ?? 0 } };
      case 'check':
      case 'uncheck':
        return { ...base, action: action.name, args: {} };
      case 'select': {
        const values = action.options ?? [];
        const labels = record?.fp.optionLabels ?? [];
        return {
          ...base, action: 'select',
          args: { optionValues: values, optionLabels: labels, matchBy: labels.length === values.length && labels.length ? 'label' : 'value' },
          value: labels.length === values.length && labels.length ? labels.join(', ') : values.join(', '),
        };
      }
      case 'setInputFiles':
        return { ...base, action: 'upload', args: { fileNames: action.files ?? [] } };
      case 'fill': {
        const step: CapturedStep = { ...base, action: 'fill', args: {} };
        await this.applyFillValue(step, page, action);
        return step;
      }
      default:
        return undefined;
    }
  }

  private async updateStep(step: CapturedStep, page: Page, action: RecorderAction): Promise<void> {
    step.snapshot = action.ariaSnapshot ?? step.snapshot;
    step.ref = action.ref ?? step.ref;
    if (action.selector) step.locator = action.selector;
    if (action.name === 'navigate' && action.url) {
      step.args = { ...step.args, url: action.url };
      step.origin = safeOrigin(action.url);
    }
    if (action.name === 'fill') {
      // Drain the extra keystroke records for this element.
      if (step.record) {
        for (const r of this.records) {
          if (sameElement(r, step.record)) r.consumed = true;
        }
      }
      await this.applyFillValue(step, page, action);
    }
  }

  private async applyFillValue(step: CapturedStep, page: Page, action: RecorderAction): Promise<void> {
    const text = action.text ?? '';
    if (step.usesSavedLogin === 'password' || (await this.isPasswordField(step, page, action))) {
      step.usesSavedLogin = 'password';
      step.value = undefined;
      this.password = text;
      if (action.ref) this.secretRefs.add(action.ref);
      if (step.ref) this.secretRefs.add(step.ref);
      this.markUsername(step);
      return;
    }
    if (step.usesSavedLogin === 'username') {
      this.username = text;
      return;
    }
    step.value = text;
  }

  // Any one signal is enough: the field's own type attribute (read by
  // Playwright, outside the page's scripts), the page record's type or
  // autocomplete, or a password-like name. Errs toward treating it as one.
  private async isPasswordField(step: CapturedStep, page: Page, action: RecorderAction): Promise<boolean> {
    const fp = step.record?.fp;
    if (fp?.inputType === 'password') return true;
    if (fp?.autocomplete && /password/i.test(fp.autocomplete)) return true;
    const names = [step.facts.name, fp?.label, fp?.placeholder, fp?.nameAttr].filter(Boolean) as string[];
    if (names.some((n) => PASSWORD_NAME.test(n))) return true;
    if (action.selector) {
      const type = await page.locator(action.selector).first()
        .getAttribute('type', { timeout: 500 }).catch(() => null);
      if (type?.toLowerCase() === 'password') return true;
    }
    return false;
  }

  // When a password is typed, the closest earlier fill on the same page that
  // looks like a username or email becomes the saved login's username.
  private markUsername(passwordStep: CapturedStep): void {
    if (this.steps.some((s) => s.usesSavedLogin === 'username')) return;
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s === passwordStep) continue;
      if (s.pageAlias !== passwordStep.pageAlias || s.action === 'navigate') break;
      if (s.action !== 'fill' || s.usesSavedLogin) continue;
      const fp = s.record?.fp;
      const looksLikeUser = fp?.inputType === 'email'
        || (fp?.autocomplete && /username|email/i.test(fp.autocomplete))
        || [s.facts.name, fp?.label, fp?.placeholder, fp?.nameAttr].some((n) => n && USERNAME_HINT.test(n));
      if (looksLikeUser) {
        s.usesSavedLogin = 'username';
        this.username = s.value;
        s.value = undefined;
      }
      return;
    }
  }

  private fingerprintOf(facts: SnapshotFacts, record?: PageRecord): WorkflowStepFingerprint {
    return fingerprintFromFacts(facts, record?.fp);
  }

  private pushCount(): void {
    const n = this.stepCount();
    const context = this.launched?.context;
    if (!context) return;
    for (const p of context.pages()) {
      // A string expression: the backend's tsconfig has no DOM types.
      p.evaluate(`window[${JSON.stringify(SET_COUNT_FN)}] && window[${JSON.stringify(SET_COUNT_FN)}](${n})`).catch(() => {});
    }
  }

  private async stopWatching(browserOpen = this.state !== 'browser_closed'): Promise<void> {
    const context = this.launched?.context as RecordingContext | undefined;
    if (context && browserOpen) {
      await context._stopRecording?.().catch(() => {});
    }
    await this.queue;
  }

  // Done: stop watching, close the window, and hold everything for the
  // review screen. Nothing is written until saveReview().
  async finish(): Promise<void> {
    if (this.finishing) return this.finishing;
    if (this.state !== 'recording' && this.state !== 'browser_closed') return;
    this.stopping = true;
    this.finishing = (async () => {
      const browserOpen = this.state !== 'browser_closed';
      this.state = 'finishing';
      await this.stopWatching(browserOpen);
      if (this.launched && browserOpen) await closeBrowser(this.launched);
      if (this.stepCount() === 0) {
        this.state = 'empty';
        this.endedAt = Date.now();
        this.forgetSecrets();
      } else {
        this.draft = this.buildDraft();
        this.state = 'review';
      }
      recorderEvents.emit('recording:finished', this.status());
    })();
    return this.finishing;
  }

  // The state becomes 'discarded' only once the window is closed, so a
  // caller that sees it can rely on the browser being gone. From review,
  // the window is already closed and nothing has been written.
  async discard(): Promise<void> {
    if (this.state === 'review') {
      this.discarding = true;
      this.clearAll();
      this.state = 'discarded';
      recorderEvents.emit('recording:discarded', this.status());
      return;
    }
    if (this.finishing) return this.finishing;
    if (this.state !== 'recording' && this.state !== 'browser_closed') return;
    this.stopping = true;
    this.discarding = true;
    this.finishing = (async () => {
      const browserOpen = this.state !== 'browser_closed';
      await this.stopWatching(browserOpen);
      if (this.launched && browserOpen) await closeBrowser(this.launched);
      this.clearAll();
      this.state = 'discarded';
      recorderEvents.emit('recording:discarded', this.status());
    })();
    return this.finishing;
  }

  private clearAll(): void {
    this.steps = [];
    this.records = [];
    this.draft = undefined;
    this.forgetSecrets();
    this.endedAt = Date.now();
  }

  private forgetSecrets(): void {
    this.password = undefined;
    this.username = undefined;
    this.secretRefs.clear();
    for (const s of this.steps) s.snapshot = undefined;
    this.records = [];
  }

  private draftSteps(): DraftStep[] {
    return this.steps.map((s, i) => ({
      stepKey: `s${i + 1}`,
      action: s.action,
      locator: s.locator,
      fingerprint: s.fingerprint,
      value: s.value,
      usesSavedLogin: s.usesSavedLogin,
      opening: s.opening,
      pageAlias: s.pageAlias,
      pageTitle: s.record?.fp.title,
      snapshot: s.snapshot,
    }));
  }

  private buildDraft(): RecordingDraft {
    const steps = this.draftSteps();
    return {
      siteKey: this.siteKey,
      stepCount: this.stepCount(),
      suggestedName: guessName(steps, this.siteName, this.siteKey, fallbackName()),
      values: valueRows(steps),
      steps: this.steps.map((s, i) => ({
        stepKey: steps[i].stepKey,
        position: i,
        action: s.action,
        description: describe(s),
        value: s.usesSavedLogin ? undefined : s.value,
        usesSavedLogin: s.usesSavedLogin,
      })),
      usesSavedLogin: this.password !== undefined,
    };
  }

  // Save from the review screen. On failure the recording stays in review
  // so the person can try again; nothing partial is left behind.
  async saveReview(req: SaveRecordingRequest): Promise<void> {
    if (this.state !== 'review' || !this.draft) {
      throw new RecordingError(this.state === 'saved' ? 'This workflow is already saved.' : 'This recording is no longer waiting to be saved.');
    }
    const rows = new Map(this.draft.values.map((v) => [v.stepKey, v]));
    const choices = new Map<string, RecordedValueChoice>();
    for (const c of req.values) {
      const row = rows.get(c.stepKey);
      if (!row) throw new RecordingError(`Step ${c.stepKey} has no value to choose for.`);
      if (c.mode === 'changes' && !row.canChange) {
        throw new RecordingError(`"${row.value}" can't change between runs yet.`);
      }
      // A clicked option that can't become a value slot keeps its text in
      // the click itself, so it can't be stored encrypted either.
      if (c.secret && row.kind === 'option-click' && !row.canChange) {
        throw new RecordingError(`"${row.value}" can't be kept secret.`);
      }
      choices.set(c.stepKey, c);
    }
    const name = req.name.replace(/\s+/g, ' ').trim() || this.draft.suggestedName;
    this.state = 'saving';
    try {
      this.result = this.save(name, choices);
      this.state = 'saved';
      this.error = undefined;
      this.endedAt = Date.now();
      this.draft = undefined;
      this.forgetSecrets();
      recorderEvents.emit('recording:saved', this.status());
    } catch (err) {
      this.state = 'review';
      this.error = "The workflow couldn't be saved. Nothing was changed. Try again.";
      console.error('[recorder] save failed:', err);
      throw new RecordingError(this.error);
    }
  }

  // Writes everything in one transaction; snapshot files are written first
  // and removed again if the transaction fails.
  private save(name: string, choices: Map<string, RecordedValueChoice>): RecordingResult {
    const draft = this.draft!;
    const dsteps = this.draftSteps();
    const rows = new Map(draft.values.map((v) => [v.stepKey, v]));
    const choiceFor = (key: string): RecordedValueChoice => {
      const row = rows.get(key)!;
      return choices.get(key) ?? { stepKey: key, mode: row.defaultMode, secret: false };
    };

    // Values marked secret are redacted from every snapshot, like the
    // password. A username isn't secret, and replacing it everywhere would
    // also wipe matching page text ("Admin" menus).
    const secrets = this.password ? [this.password] : [];
    for (const row of draft.values) if (choiceFor(row.stepKey).secret && row.value) secrets.push(row.value);
    const secretRefs = [...this.secretRefs];

    const snapshotDir = path.join(getDataDir(), 'workflow-snapshots', uuidv4());
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPaths: (string | undefined)[] = this.steps.map((s, i) => {
      if (!s.snapshot) return undefined;
      const file = path.join(snapshotDir, `${dsteps[i].stepKey}.yaml`);
      fs.writeFileSync(file, redactSnapshot(s.snapshot, secrets, secretRefs), 'utf8');
      return file;
    });

    try {
      return dbTransaction(() => {
        let siteAgent = getSiteAgentBySiteKey(this.siteKey)
          ?? createSiteAgent({ siteKey: this.siteKey, name: this.siteName, startUrl: this.startUrl, profileDir: this.profileDir });
        if (!siteAgent.profileDir) siteAgent = updateSiteAgent(siteAgent.id, { profileDir: this.profileDir }) ?? siteAgent;

        let savedLogin = false;
        if (this.password !== undefined) {
          const payload = JSON.stringify({ ...(this.username !== undefined ? { username: this.username } : {}), password: this.password });
          const existing = siteAgent.credentialId ? getCredentialById(siteAgent.credentialId) : null;
          if (existing && existing.provider === SITE_LOGIN_PROVIDER) {
            updateCredential(existing.id, payload);
          } else {
            const cred = createCredential(
              `${this.siteName} sign-in`, SITE_LOGIN_PROVIDER, payload,
              `Saved while recording on ${this.siteKey}`, safeOrigin(this.startUrl),
            );
            siteAgent = updateSiteAgent(siteAgent.id, { credentialId: cred.id }) ?? siteAgent;
          }
          savedLogin = true;
        }

        const workflow = createWorkflow({ siteAgentId: siteAgent.id, name });

        // Every value marked "Changes" becomes an input field, in step order.
        const usedKeys = new Set<string>();
        const fieldIds = new Map<string, string>();
        for (const row of draft.values) {
          const choice = choiceFor(row.stepKey);
          if (choice.mode !== 'changes') continue;
          const field = createField(workflow.id, {
            key: fieldKeyFor(row.label, usedKeys),
            label: row.label,
            kind: row.kind === 'text' ? 'text' : 'option',
            secret: choice.secret,
            recordedValue: row.value,
            required: true,
            position: fieldIds.size,
          });
          fieldIds.set(row.stepKey, field.id);
        }

        const inputs: StepInput[] = this.steps.map((s, i) => {
          const key = dsteps[i].stepKey;
          const input: StepInput = {
            stepKey: key,
            position: i,
            action: s.action,
            locator: s.locator,
            fingerprint: s.fingerprint,
            pageAlias: s.pageAlias,
            origin: s.origin,
            args: s.args,
            signals: s.signals,
            snapshotPath: snapshotPaths[i],
          };
          if (s.usesSavedLogin) {
            input.valueSource = 'credential';
            input.valueTarget = 'text';
            input.credentialPart = s.usesSavedLogin;
            return input;
          }
          const row = rows.get(key);
          if (!row) return input; // a click or navigation: nothing to vary
          const choice = choiceFor(key);
          const fieldId = fieldIds.get(key);
          const source: Partial<StepInput> = fieldId
            ? { valueSource: 'field', fieldId }
            : { valueSource: 'literal', literalValue: row.value, literalSecret: choice.secret };

          if (row.kind === 'option-click') {
            // A clicked option carries its value in the locator. Plain
            // "Always this" keeps the click exactly as recorded; otherwise
            // the option's name becomes the value slot, so the value (secret
            // or not) isn't baked into the locator.
            if (!fieldId && !choice.secret) return input;
            const template = templateLocator(s.locator, s.fingerprint.name ?? '');
            if (!template) {
              throw new Error(`step ${key}: option can't be turned into a value slot`);
            }
            return {
              ...input, ...source, valueTarget: 'locator', locator: template,
              fingerprint: templateFingerprint(s.fingerprint, row.value),
            };
          }
          if (row.kind === 'option') {
            // A secret choice keeps none of the recorded option text in args.
            const args = choice.secret ? { matchBy: s.args.matchBy === 'label' ? 'label' : 'value' } : s.args;
            return { ...input, ...source, valueTarget: 'option', args };
          }
          return { ...input, ...source, valueTarget: 'text' };
        });

        const version = createVersion(workflow.id, { reason: 'recorded' }, inputs);
        return {
          siteAgent,
          workflow: { ...workflow, currentVersionId: version.id },
          version,
          steps: draft.steps,
          savedLogin,
          fieldCount: fieldIds.size,
        };
      });
    } catch (err) {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      throw err;
    }
  }
}

// A step's fingerprint: the aria snapshot's facts merged with the page's own
// record of the element (pageScript.ts). Also used by workflow repair, so a
// repaired step is described the same way as a recorded one.
export function fingerprintFromFacts(facts: SnapshotFacts, fp?: PageRecord['fp']): WorkflowStepFingerprint {
  const out: WorkflowStepFingerprint = {
    role: facts.role,
    name: facts.name,
    label: fp?.label,
    placeholder: fp?.placeholder,
    nameAttr: fp?.nameAttr,
    testId: fp?.testId,
    tag: fp?.tag,
    inputType: fp?.inputType,
    autocomplete: fp?.autocomplete,
    heading: facts.heading,
    landmark: facts.landmark,
    container: facts.container,
    urlPath: fp?.urlPath,
    ordinal: facts.ordinal,
    framePath: fp?.framePath,
  };
  for (const k of Object.keys(out) as (keyof WorkflowStepFingerprint)[]) if (out[k] === undefined) delete out[k];
  return out;
}

export type PageElementFacts = PageRecord['fp'];

function fallbackName(): string {
  return `Recorded ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function safeOrigin(url: string): string | undefined {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? undefined : o;
  } catch {
    return undefined;
  }
}

function describe(s: CapturedStep): string {
  const unnamed: Record<string, string> = {
    combobox: 'a dropdown', listbox: 'a list', checkbox: 'a checkbox', radio: 'an option', switch: 'a switch',
    spinbutton: 'a number field', searchbox: 'a search box', textbox: 'a text field',
  };
  const what = s.fingerprint.name || s.fingerprint.label || s.fingerprint.placeholder
    || (s.facts.role && unnamed[s.facts.role]) || 'a field';
  const roleWord: Record<string, string> = { button: 'button', link: 'link', checkbox: 'checkbox', radio: 'option', tab: 'tab', option: 'option', menuitem: 'menu item' };
  const kind = s.facts.role ? roleWord[s.facts.role] : undefined;
  switch (s.action) {
    case 'navigate': {
      const url = String(s.args.url ?? '');
      return s.opening ? `Opened ${shortUrl(url)}` : `Went to ${shortUrl(url)}`;
    }
    case 'click':
      return s.fingerprint.name ? `Clicked "${s.fingerprint.name}"${kind ? ` ${kind}` : ''}` : 'Clicked on the page';
    case 'fill':
      if (s.usesSavedLogin === 'password') return `Typed your password into ${what}`;
      if (s.usesSavedLogin === 'username') return `Typed your saved sign-in name into ${what}`;
      return s.value ? `Typed "${s.value}" into ${what}` : `Cleared ${what}`;
    case 'select':
      return `Chose "${s.value ?? ''}" in ${what}`;
    case 'press':
      return `Pressed ${s.args.key === ' ' ? 'Space' : String(s.args.key)}`;
    case 'check':
      return `Ticked ${what}`;
    case 'uncheck':
      return `Unticked ${what}`;
    case 'upload': {
      const files = (s.args.fileNames as string[] | undefined) ?? [];
      return `Attached ${files.join(', ') || 'a file'}`;
    }
    default:
      return s.action;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url;
  }
}

function sameElement(a: PageRecord, b: PageRecord): boolean {
  return a.page === b.page && a.docId === b.docId && a.elementId === b.elementId;
}
