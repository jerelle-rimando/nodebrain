import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Locator, Page } from 'playwright-core';
import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type SiteAgent, type Workflow, type WorkflowField, type WorkflowRun, type WorkflowRunStep,
  type WorkflowRunStatus, type WorkflowRunTrigger, type WorkflowStep, type WorkflowStepResolvedBy,
} from '../../shared-types';
import { getDataDir } from '../db/database';
import {
  getWorkflowById, getSiteAgentById, updateSiteAgent, getFieldsByWorkflow, getStepsByVersion, getStepLiteralValue,
  getFieldRecordedValue, createRun, updateRunStatus, addRunStep, getRunById, getRunSteps, setRunStepScreenshot, setRunFinalScreenshot,
} from '../db/workflowRepository';
import { getCredentialValue } from '../vault/credentialVault';
import { launchBrowser, closeBrowser, minimizeWindow, BrowserNotFoundError, type LaunchedBrowser } from '../recorder/browserLauncher';
import { listRecordings } from '../recorder/recordingSession';
import { siteKeyToFolderName } from '../recorder/siteIdentity';
import { captureSiteLook, isDefaultSiteName, siteIconFile } from '../recorder/siteLook';
import { claimSiteBrowser, releaseSiteBrowser, siteBrowserHolder } from '../browser/siteBrowserLock';
import { requestTakeControl } from '../browser/takeControl';
import { fillTemplate, findElement, SETTLED_MS } from './elementFinder';
import { trackActivity } from './pageActivity';
import { isTypeahead, offers, readBack, sameValue, waitForList, LIST_STILL_MS } from './typeahead';
import { describeErrors, lastingNewErrors, readPageErrors, type PageError } from './pageErrors';
import { takeFinalPicture } from './finalPicture';
import { onAnotherPageFor, pathOf, type PlaceNow } from './pagePath';

// Replays a saved workflow in the person's browser, step by step, with no
// model in the loop. Each step's element is found by its saved locator, else
// its fingerprint (elementFinder.ts); a step that can't be found stops the
// run as needs_attention with the step recorded, and nothing is guessed or
// skipped. Two deliberate skips: a sign-in the profile doesn't need (see
// signInBlocks), and a step the person marked optional ("This doesn't always
// appear") whose element isn't on the page this time.
//
// Secrets (saved passwords, secret literals, secret field values) are read
// in memory when their step runs. They are never written to a run row, a run
// step row or a log line: everything written goes through redact().

export const replayEvents = new EventEmitter();

export class RunStartError extends Error {}

// The most a step waits for its saved locator, then its fingerprint. Both
// end early once the page has settled (elementFinder.ts SETTLED_MS): only a
// page still loading or busy waits the full time.
const PRIMARY_TIMEOUT_MS = 15_000; // page loads and slow widgets
const FALLBACK_TIMEOUT_MS = 3_000; // the page has had its 15 s by then
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 60_000;
const SIGN_IN_CHECK_MS = 15_000;
// An optional step (a consent dialog, a cookie banner) follows the same
// settled-page rule as any step; these shorter limits only matter on a page
// that never goes quiet, where an ordinary step would wait the full 18 s.
const OPTIONAL_PRIMARY_TIMEOUT_MS = 6_000;
const OPTIONAL_FALLBACK_TIMEOUT_MS = 1_000;
// After the last step, before the run counts as done: at least the minimum,
// then until the page has been quiet (no requests going, nothing added or
// removed) for FINAL_QUIET_MS, but never more than the maximum. A site that
// checks the last step with its server answers after its request returns;
// a fixed 1 s missed Pie's "A valid class code is required" (2026-11-16 run:
// marked done 1.0 s after its last step).
const FINAL_MIN_WAIT_MS = 1_000;
const FINAL_QUIET_MS = 1_500;
const FINAL_MAX_WAIT_MS = 10_000;
// What the run view says under an optional step that was skipped.
const OPTIONAL_SKIPPED_TEXT = "Wasn't on the page this time. It doesn't always appear, so NodeBrain carried on.";
const OPTIONAL_MARKED_TEXT = "You said this doesn't always appear, so NodeBrain skipped it and carried on.";
// A step whose page didn't show up, where the person pointed at what to do
// on the page that showed instead (repair.ts saveRepair, the 'alternative' fix).
const ALTERNATIVE_TEXT = "This page didn't show up this time. You showed NodeBrain what to do on the one that did, so it did that instead.";
const BY_HAND_TEXT = 'You did this step yourself in the browser.';

// The run-step texts that mean "an optional step wasn't there, so it was
// left out" (not a sign-in the profile didn't need, not a stop).
export function isOptionalSkip(row: { status: WorkflowRunStep['status']; error?: string }): boolean {
  return row.status === 'skipped'
    && (row.error === OPTIONAL_SKIPPED_TEXT || row.error === OPTIONAL_MARKED_TEXT || row.error === ALTERNATIVE_TEXT);
}

// How long a pointed-at step (one a repair added) waits after its click for
// the page to start going somewhere else. The recording never saw that click,
// so there's no recorded navigation to wait for; without this, the next step
// was judged 2.2 s after "Skip for now" on HubSpot while the old address was
// still showing (run cbbd709f, s12, 2026-11-22).
const POINTED_NAV_WAIT_MS = 3_000;

// A pick from a list the step before opened (Replay.listOpenerFor): how long
// the opener has to show its list as closed before it's opened again, how
// long clicking it may take, and how long the choice is then waited for.
const LIST_CLOSED_GRACE_MS = 1_000;
const LIST_REOPEN_CLICK_MS = 5_000;
const LIST_REOPEN_TIMEOUT_MS = 5_000;

type OpenerState = 'open' | 'closed' | 'unknown' | 'none';
// reopened: the opener was clicked again for this step. openNow: whether
// its list was open when the choice was finally not found.
interface ListCheck { reopened: boolean; openNow?: OpenerState }

// A control with no open/closed facts still counts as the opener when the
// choice was recorded as a list item: its state just can't be read.
const LIST_ITEM_ROLES = new Set(['option', 'menuitem', 'menuitemradio', 'menuitemcheckbox']);
function listState(state: OpenerState, step: WorkflowStep): OpenerState {
  if (state !== 'none') return state;
  const fp = step.fingerprint;
  const item = (fp.role && LIST_ITEM_ROLES.has(fp.role)) || !!fp.container
    || /internal:role=(option|menuitem|menuitemradio|menuitemcheckbox)\b/.test(step.locator ?? '');
  return item ? 'unknown' : 'none';
}

// Whether the list a control opens is showing as open, from its own
// aria-expanded (or that of a wrapper up to 3 levels out, or a child).
async function expandState(loc: Locator): Promise<OpenerState> {
  const facts = await loc.evaluate((el: any) => {
    let s = el.hasAttribute('aria-expanded') ? el : null;
    for (let n = el.parentElement, d = 0; !s && n && d < 3; n = n.parentElement, d++) {
      if (n.hasAttribute('aria-expanded')) s = n;
    }
    if (!s) s = el.querySelector('[aria-expanded]');
    const popup = (s ?? el).getAttribute('aria-haspopup') ?? el.getAttribute('aria-haspopup');
    return {
      expanded: s ? String(s.getAttribute('aria-expanded')) : null,
      popup: !!popup && popup !== 'false',
      combobox: (el.getAttribute('role') ?? '') === 'combobox',
    };
  }, undefined, { timeout: 1_000 }).catch(() => null);
  if (!facts) return 'none';
  if (facts.expanded === 'true') return 'open';
  if (facts.expanded === 'false') return 'closed';
  return facts.popup || facts.combobox ? 'unknown' : 'none';
}

interface ActiveRun {
  runId: string;
  siteKey: string;
  controller: AbortController;
  launched?: LaunchedBrowser;
  closing?: Promise<void>;
  // The window opens minimized. Once it has come forward (a pause for the
  // person, "Show the browser", a repair), the run's end brings NodeBrain
  // back in front of where it was.
  shown?: boolean;
}

const active = new Map<string, ActiveRun>();

// Closes the run's window once. Stop and the run's own cleanup can both ask
// at the same moment (a Stop during a pause or a repair wait ends the wait at
// once), and two overlapping closeBrowser calls on one connection hang: the
// second never settles, so the run would never release its site.
function closeRunBrowser(entry: ActiveRun): Promise<void> {
  if (!entry.launched) return Promise.resolve();
  entry.closing ??= closeBrowser(entry.launched).catch(() => {});
  return entry.closing;
}

// How long a stopped run keeps its window open for a repair. Its saved
// sign-in and secret inputs stay in memory for as long as it waits.
const REPAIR_HOLD_MS = 30 * 60_000;

// A run waiting, window open, for the person to point at a step's element.
// Read by replay/repair.ts; everything else about the run stays private.
// How a held run carries on:
//   retry: the step was shown where it is now; it runs again.
//   skip: it was marked as not always appearing; the run moves past it.
//   alternative: its page didn't show up, and the person pointed at what to
//     do on the page that did; that's a new step right after it (stepKey),
//     which runs next. The stopped step itself is left out this time.
//   byHand: the person does the step in the browser (Take Control); the run
//     moves past it once they press Done.
export type RepairResume =
  | { then: 'retry' | 'skip' | 'byHand' }
  | { then: 'alternative'; stepKey: string };

export interface RepairHold {
  // 'missing': nothing found, nothing done. 'action': found, but the click
  // or typing failed, so part of it may have happened.
  kind: 'missing' | 'action';
  runId: string;
  workflowId: string;
  versionId: string; // the version the stopped step belongs to
  siteKey: string;
  step: WorkflowStep;
  steps: WorkflowStep[];
  fieldsById: Map<string, WorkflowField>;
  page: Page;
  value?: string; // this run's value for the step (may be secret: memory only)
  recordedValue?: string;
  signal: AbortSignal;
  redact: (text: string) => string;
  // Carry on, with a fixed version's steps (the same ones for byHand).
  resume: (steps: WorkflowStep[], how: RepairResume) => void;
  release: () => void; // stop waiting: the run ends as needs_attention
  // The Fix screen's "Show the page": brings the window forward and takes
  // the picture of where it stopped, which isn't taken while it's minimized.
  takePicture: () => Promise<boolean>;
}

const holds = new Map<string, RepairHold>();

export function getRepairHold(runId: string): RepairHold | undefined {
  return holds.get(runId);
}

const OPEN_RECORDING_STATES = new Set(['recording', 'browser_closed', 'finishing', 'saving']);

// ── Starting ────────────────────────────────────────────────────────────────

// Checks the inputs, writes the run row and starts the browser in the
// background. Returns the run as soon as it exists; progress arrives as
// run:step and run:finished events. `inputs` is keyed by field key and may
// hold secret values: those stay in memory for this run only.
export function startRun(
  workflowId: string, inputs: Record<string, string>, trigger: WorkflowRunTrigger = 'manual',
): WorkflowRun {
  const workflow = getWorkflowById(workflowId);
  if (!workflow) throw new RunStartError("That workflow doesn't exist anymore.");
  if (!workflow.currentVersionId) throw new RunStartError('That workflow has no steps to run yet.');
  const site = getSiteAgentById(workflow.siteAgentId);
  if (!site) throw new RunStartError("The site this workflow belongs to doesn't exist anymore.");

  const fields = getFieldsByWorkflow(workflowId);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of Object.keys(inputs)) {
    if (!byKey.has(key)) throw new RunStartError(`This workflow has no input called "${key}".`);
  }
  for (const f of fields) {
    if (f.required && (inputs[f.key] === undefined || inputs[f.key] === '')) {
      throw new RunStartError(`Fill in "${f.label}" before starting.`);
    }
  }

  const holder = siteBrowserHolder(site.siteKey);
  if (holder) throw new RunStartError(`Another workflow is already running on ${site.siteKey}. Wait for it to finish.`);
  if (listRecordings().some((r) => r.siteKey === site.siteKey && OPEN_RECORDING_STATES.has(r.state))) {
    throw new RunStartError(`A recording is open for ${site.siteKey}. Finish it or throw it away first.`);
  }

  const run = createRun(workflowId, trigger, inputs);
  claimSiteBrowser(site.siteKey, run.id);
  const entry: ActiveRun = { runId: run.id, siteKey: site.siteKey, controller: new AbortController() };
  active.set(run.id, entry);
  replayEvents.emit('run:started', run);

  const replay = new Replay(run, workflow, site, fields, { ...inputs }, entry);
  void replay.execute()
    .catch((err) => {
      console.error('[replay] run crashed:', replay.redact(err instanceof Error ? err.message : String(err)));
      replay.finish('failed', { error: 'Something went wrong inside NodeBrain while running this workflow.' });
    })
    .finally(async () => {
      await closeRunBrowser(entry);
      releaseSiteBrowser(site.siteKey, run.id);
      active.delete(run.id);
    });
  return run;
}

// Stops a run: ends a pause if there is one, and closes the browser so a step
// in progress stops too.
export function cancelRun(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  void closeRunBrowser(entry);
  return true;
}

export function getRunDetail(runId: string): { run: WorkflowRun; steps: WorkflowRunStep[] } | null {
  const run = getRunById(runId);
  return run ? { run, steps: getRunSteps(runId) } : null;
}

export function markRunBrowserShown(runId: string): void {
  const entry = active.get(runId);
  if (entry) entry.shown = true;
}

export function isRunActive(runId: string): boolean {
  return active.has(runId);
}

// ── Sign-in detection ───────────────────────────────────────────────────────

// A sign-in block: the steps that type a saved sign-in, the clicks into
// those same boxes, and the click or key press that submits them. A site's
// profile usually stays signed in after the first run, so a workflow
// recorded signed-out lands past the sign-in page when replayed. Those steps
// are then skipped as a block, not failed.
interface SignInBlock { start: number; end: number; anchor: number }

export function signInBlocks(steps: WorkflowStep[]): SignInBlock[] {
  const blocks: SignInBlock[] = [];
  let i = 0;
  while (i < steps.length) {
    if (steps[i].valueSource !== 'credential') { i++; continue; }
    const anchor = i;
    const alias = steps[i].pageAlias;
    const boxes = new Set<string>();
    let start = i;
    let end = i;
    let j = i;
    // Walk forward through the block, collecting sign-in boxes; a submit
    // followed shortly by another credential step (username, Next, password)
    // continues it.
    while (j < steps.length) {
      const s = steps[j];
      if (s.pageAlias !== alias || s.action === 'navigate') break;
      if (s.valueSource === 'credential') {
        if (s.locator) boxes.add(s.locator);
        end = j; j++; continue;
      }
      const intoBox = s.locator !== undefined && boxes.has(s.locator) && s.action === 'click';
      if (intoBox) { end = j; j++; continue; }
      if (s.action === 'click' || s.action === 'press') {
        end = j; // the submit
        const next = steps.slice(j + 1, j + 4).findIndex((n) => n.valueSource === 'credential');
        if (next >= 0) { j = j + 1 + next; continue; }
        break;
      }
      break;
    }
    // Clicks into the first box just before it belong to the block too.
    const first = steps[anchor].locator;
    while (start > 0 && steps[start - 1].action === 'click' && steps[start - 1].locator === first
           && steps[start - 1].pageAlias === alias) start--;
    blocks.push({ start, end, anchor });
    i = end + 1;
  }
  return blocks;
}

// ── One run ─────────────────────────────────────────────────────────────────

type StepOutcome =
  | { ok: true }
  // repairable: the step's element wasn't found (or wasn't the only match),
  // so nothing was done to the page and the person can point at it instead.
  // actionFailed: it was found, but clicking or typing into it failed. The
  // person can do it by hand from the held window, or point at another one.
  | { ok: false; status: WorkflowRunStatus; error: string; repairable?: boolean; actionFailed?: boolean };

interface ResolvedValue { value?: string; recordedValue?: string; shownOnPage: boolean }

interface TypeaheadBox {
  pageAlias: string;
  locator: string; // the saved locator, to recognise later steps on the same box
  el: Locator; // where it was found this run
  what: string; // "the "What state is your business in?" dropdown"
  typed?: string; // the text the last fill put in (may be secret: memory only)
  moved: boolean; // a key other than the pick was pressed after the typing
  secret: boolean;
}

interface Pick {
  kind: 'key' | 'option';
  field: Locator; // the box to read back
  fieldWhat: string;
  intended: string; // may be secret: memory only, and kept out of messages
  typed?: string; // option picks: what the box held before the click (may be secret)
  secret: boolean;
}

class Replay {
  private secrets: string[] = [];
  private pages = new Map<string, Page>();
  private context?: BrowserContext;
  private browserGone = false;
  private expectDialog = false;
  private secretShown = false; // a secret other than a password is visible on the page
  // A saved sign-in value was put in at some point. The page may then carry
  // it in its markup (some sites write a password box's value into the
  // attribute), so no copy of the page is made for the final picture.
  private credentialFilled = false;
  private login?: { username?: string; password?: string };
  private steps: WorkflowStep[];
  private fieldsById: Map<string, WorkflowField>;
  private done = false;
  private justRepaired?: string; // step key: its next success is recorded as 'repaired'
  // The typeahead box the last step typed into or clicked, for the pick that
  // follows it (typeahead.ts). Cleared by any step elsewhere.
  private typeahead?: TypeaheadBox;
  // The last step that was done (not skipped), for a pick from a list that
  // step opened (see listOpenerFor).
  private lastDone?: WorkflowStep;
  // Whether the last clicked control's list was open just before the click.
  private clickedFrom?: { stepKey: string; state: OpenerState };
  // The error messages showing before the last step acted, and what it did,
  // for a message that shows up only after that step was recorded as done
  // (checked before the next step acts, and at the end of the run).
  private errorWatch?: { pageAlias: string; before: PageError[]; did: string };

  constructor(
    private run: WorkflowRun, private workflow: Workflow, private site: SiteAgent,
    fields: WorkflowField[], private inputs: Record<string, string>, private entry: ActiveRun,
  ) {
    this.steps = getStepsByVersion(run.versionId);
    this.fieldsById = new Map(fields.map((f) => [f.id, f]));
    for (const f of fields) if (f.secret && inputs[f.key]) this.secrets.push(inputs[f.key]);
  }

  private get signal(): AbortSignal { return this.entry.controller.signal; }

  // Removes every secret this run has seen from text about to be written.
  redact(text: string): string {
    let out = text;
    const all = [...this.secrets].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const s of all) {
      out = out.split(s).join('•••');
      const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      if (escaped !== s) out = out.split(escaped).join('•••');
      const encoded = encodeURIComponent(s);
      if (encoded !== s) out = out.split(encoded).join('•••');
    }
    return out;
  }

  finish(status: WorkflowRunStatus, details: { error?: string; failedStepKey?: string } = {}): void {
    if (this.done) return;
    this.done = true;
    updateRunStatus(this.run.id, status, {
      error: details.error ? this.redact(details.error) : undefined,
      failedStepKey: details.failedStepKey,
    });
    // Secrets are dropped as soon as the run ends.
    this.inputs = {};
    this.login = undefined;
    const finished = getRunById(this.run.id);
    replayEvents.emit('run:finished', finished && { ...finished, browserShown: !!this.entry.shown });
  }

  private record(step: WorkflowStep, status: WorkflowRunStep['status'], started: number,
                 extra: { resolvedBy?: WorkflowStepResolvedBy; error?: string; screenshotPath?: string; rawError?: string } = {}): void {
    if (this.justRepaired === step.stepKey) {
      this.justRepaired = undefined;
      if (status === 'ok') {
        status = 'repaired';
        extra = { ...extra, resolvedBy: 'human', error: 'You showed NodeBrain where this is now.' };
      }
    }
    // A skipped optional step in between leaves the step before it as the
    // last one done; a stop leaves it too, so a retried step still knows it.
    if (status === 'ok' || status === 'repaired') this.lastDone = step;
    const page = this.pages.get(step.pageAlias);
    const url = page && !page.isClosed() ? this.redact(page.url()) : undefined;
    const row = addRunStep(this.run.id, {
      stepKey: step.stepKey, position: step.position, status,
      resolvedBy: extra.resolvedBy, durationMs: Date.now() - started, url,
      error: extra.error ? this.redact(extra.error) : undefined, screenshotPath: extra.screenshotPath,
      rawError: extra.rawError, // already redacted and gated by stop()
    });
    replayEvents.emit('run:step', row);
  }

  async execute(): Promise<void> {
    updateRunStatus(this.run.id, 'running');
    if (this.steps.length === 0) {
      this.finish('failed', { error: 'This workflow has no steps.' });
      return;
    }
    const profileDir = this.site.profileDir
      ?? path.join(getDataDir(), 'browser-profiles', siteKeyToFolderName(this.site.siteKey));
    try {
      this.entry.launched = await launchBrowser(profileDir, this.site.startUrl, { background: true });
    } catch (err) {
      this.finish('failed', {
        error: err instanceof BrowserNotFoundError
          ? 'Running a workflow needs Google Chrome or Microsoft Edge, and neither was found on this computer.'
          : "The browser didn't open. If a window for this site is already open, close it and try again.",
      });
      return;
    }
    if (this.signal.aborted) { this.finish('cancelled', { error: 'You stopped the run.' }); return; }

    const { browser, context } = this.entry.launched;
    this.context = context;
    browser.on('disconnected', () => { this.browserGone = true; });
    const first = context.pages()[0] ?? (await context.newPage());
    this.pages.set('page', first);
    trackActivity(first);
    this.watchDialogs(first);
    // Popups get the same names the recorder gave them: page, popup1, popup2…
    context.on('page', (p) => {
      if ([...this.pages.values()].includes(p)) return;
      this.pages.set(`popup${this.pages.size}`, p);
      trackActivity(p);
      this.watchDialogs(p);
      // A popup opens as its own window, in front; it joins the run's window
      // in the taskbar unless the person has that one up.
      if (!this.entry.shown) void minimizeWindow(browser, context, p);
    });
    // No bringToFront: the run goes on in the minimized window.
    this.watchSiteLook(first);

    let blocks = signInBlocks(this.steps);
    for (let i = 0; i < this.steps.length; i++) {
      if (this.signal.aborted) { this.finish('cancelled', { error: 'You stopped the run.' }); return; }
      const block = blocks.find((b) => b.start === i);
      if (block && (await this.alreadySignedIn(this.steps[block.anchor]))) {
        this.typeahead = undefined;
        for (let j = block.start; j <= block.end; j++) {
          this.record(this.steps[j], 'skipped', Date.now(), {
            error: "Already signed in, so this sign-in step wasn't needed.",
          });
        }
        i = block.end;
        continue;
      }
      const step = this.steps[i];
      const outcome = await this.runStep(step);
      if (!outcome.ok) {
        // A step whose element wasn't found, or was found but couldn't be
        // clicked or typed into: keep the window as it is and wait for the
        // person (replay/repair.ts). A repair brings a new version's steps.
        const kind = outcome.repairable ? 'missing' : outcome.actionFailed ? 'action' : undefined;
        const repaired = kind ? await this.holdForRepair(step, outcome.error, kind) : null;
        if (repaired) {
          // The page was in the person's hands. What it shows now (a box
          // marked invalid when focus left it for the Fix bar) isn't the
          // previous step's doing.
          this.errorWatch = undefined;
          this.steps = repaired.steps;
          blocks = signInBlocks(this.steps);
          const how = repaired.how;
          if (how.then === 'skip') {
            this.record(step, 'skipped', Date.now(), { error: OPTIONAL_MARKED_TEXT });
            continue;
          }
          if (how.then === 'alternative') {
            // The new step sits right after this one, so it's next.
            this.record(step, 'skipped', Date.now(), { error: ALTERNATIVE_TEXT });
            this.justRepaired = how.stepKey;
            continue;
          }
          if (how.then === 'byHand') {
            const started = Date.now();
            const page = this.pages.get(step.pageAlias) ?? (await this.pageFor(step));
            const answer = page && !page.isClosed()
              ? await this.pause(step, page, `${capitalise(verbFor(step))} ${this.describeTarget(step, undefined)} yourself in the browser window, then press Done. NodeBrain carries on from the next step.`)
              : 'stopped';
            if (answer !== 'done') {
              // Closing the window isn't "You stopped the run".
              const end = this.browserGone ? this.stopped(step, started) : await this.endAtPause(step, started, answer);
              if (!end.ok) this.finish(end.status, { error: end.error, failedStepKey: end.status === 'needs_attention' ? step.stepKey : undefined });
              return;
            }
            this.record(step, 'ok', started, { resolvedBy: 'human', error: BY_HAND_TEXT });
            continue;
          }
          this.justRepaired = step.stepKey;
          i--;
          continue;
        }
        this.finish(outcome.status, { error: outcome.error, failedStepKey: step.stepKey });
        return;
      }
    }
    // The last step is often the submit. Give the site time to answer it
    // (and what it sent time to arrive before the window closes).
    // waitForLoadState('networkidle') isn't used: on a single-page site the
    // state was reached at the first load, so it returns at once.
    const lastStep = this.steps[this.steps.length - 1];
    const last = this.pages.get(lastStep.pageAlias);
    if (last && !last.isClosed()) await this.settleAfterLastStep(last);
    // An error message that came up after the last step (a submit the site
    // turned down) means the run didn't get where it was going. Only a new
    // message that stays counts (pageErrors.ts): a last step that changes
    // nothing visible (a checkbox, a save that only shows a toast) is fine.
    const watch = this.errorWatch;
    const watched = watch && this.pages.get(watch.pageAlias);
    if (watch && watched && !watched.isClosed() && !this.closedOrStopped()) {
      const appeared = await lastingNewErrors(watched, watch.before, this.signal);
      if (appeared.length && !this.closedOrStopped()) {
        console.log(`[replay] ${this.run.id} ${lastStep.stepKey}: the page showed an error message after the last step`);
        const error = `The site didn't accept the last step. After NodeBrain ${watch.did}, the page ${describeErrors(appeared)}.`;
        const picture = await this.finalPicture(watched);
        this.record(lastStep, 'failed', Date.now(), { error, screenshotPath: picture });
        this.finish('needs_attention', { error, failedStepKey: lastStep.stepKey });
        return;
      }
    }
    if (last && !last.isClosed() && !this.closedOrStopped()) await this.finalPicture(last);
    this.finish('completed');
  }

  private async settleAfterLastStep(page: Page): Promise<void> {
    const activity = trackActivity(page);
    const started = Date.now();
    await new Promise((r) => setTimeout(r, FINAL_MIN_WAIT_MS));
    while (Date.now() - started < FINAL_MAX_WAIT_MS && !page.isClosed() && !this.closedOrStopped()) {
      if ((await activity.quietMs()) >= FINAL_QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // The page as it stood when the run ended, kept with the run
  // (finalPicture.ts). Same rule as the stopped-step picture: none once a
  // secret other than a masked password is showing. After a saved sign-in
  // value went in, only a real screenshot (window showing) is taken, never
  // the page copy; a minimized run then has no final picture.
  //
  // `name` set: a picture of where a step failed (failurePicture), kept on
  // that step's row by the caller instead of as the run's final picture.
  private async finalPicture(page: Page, name?: string): Promise<string | undefined> {
    if (this.secretShown || page.isClosed() || !this.context) return undefined;
    const dir = path.join(getDataDir(), 'workflow-runs', this.run.id);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
    const file = path.join(dir, name ?? 'final.png');
    const ok = await takeFinalPicture(page, this.context, file, !!this.entry.shown, !this.credentialFilled).catch(() => false);
    if (!ok) {
      console.log(`[replay] ${this.run.id}: no ${name ? 'failure' : 'final'} picture (window ${this.entry.shown ? 'showing' : 'minimized'}${this.credentialFilled ? ', saved sign-in used: no page copy' : ''})`);
      return undefined;
    }
    if (!name) setRunFinalScreenshot(this.run.id, file);
    return file;
  }

  private watchDialogs(page: Page): void {
    // A dialog the recording saw (the person answered it then) is accepted;
    // one it didn't see is dismissed, so nothing unexpected gets confirmed.
    page.on('dialog', (d) => {
      const answer = this.expectDialog ? d.accept() : d.dismiss();
      answer.catch(() => {});
    });
  }

  // True when the sign-in form isn't there because the profile is already
  // signed in: the sign-in box doesn't appear and the browser has been taken
  // to a different page than the one sign-in was recorded on. If the box
  // isn't there but the page is the recorded one, that's a real miss, and
  // the step itself reports it.
  private async alreadySignedIn(anchor: WorkflowStep): Promise<boolean> {
    const page = this.pages.get(anchor.pageAlias);
    const recordedPath = anchor.fingerprint.urlPath;
    if (!page || !anchor.locator || !recordedPath) return false;
    const box = page.locator(anchor.locator);
    const start = Date.now();
    const deadline = start + SIGN_IN_CHECK_MS;
    const activity = trackActivity(page);
    let elsewhereSince: number | undefined;
    while (Date.now() < deadline && !this.signal.aborted && !this.browserGone) {
      if ((await box.count().catch(() => 0)) > 0) return false;
      const here = pathOf(page.url());
      const ready = await page.evaluate('document.readyState').catch(() => 'loading');
      if (here && here !== recordedPath && ready === 'complete') {
        elsewhereSince ??= Date.now();
        // Stayed away from the sign-in page for a moment: not a redirect in progress.
        if (Date.now() - elsewhereSince > 1500) break;
      } else {
        elsewhereSince = undefined;
        // Still on the sign-in page, settled, and the saved box isn't there:
        // the page changed, and waiting won't bring it. The step itself
        // tries the fingerprint (a redesigned sign-in page, like Roblox's).
        if (here === recordedPath && Date.now() - start >= SETTLED_MS && (await activity.quietMs()) >= SETTLED_MS) break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if ((await box.count().catch(() => 0)) > 0) return false;
    const here = pathOf(page.url());
    return here !== undefined && here !== recordedPath;
  }

  private async pageFor(step: WorkflowStep): Promise<Page | undefined> {
    let page = this.pages.get(step.pageAlias);
    if (!page && this.context) {
      // The popup may still be opening.
      await this.context.waitForEvent('page', { timeout: 10_000 }).catch(() => {});
      page = this.pages.get(step.pageAlias);
    }
    return page && !page.isClosed() ? page : undefined;
  }

  private resolveValue(step: WorkflowStep): ResolvedValue | { error: string } {
    switch (step.valueSource) {
      case 'none':
        return { shownOnPage: false };
      case 'literal': {
        if (!step.literalSecret) return { value: step.literalValue, recordedValue: step.literalValue, shownOnPage: false };
        const v = getStepLiteralValue(step.id) ?? undefined;
        if (v) this.secrets.push(v);
        return { value: v, recordedValue: v, shownOnPage: true };
      }
      case 'field': {
        const field = step.fieldId ? this.fieldsById.get(step.fieldId) : undefined;
        if (!field) return { error: 'This step uses an input the workflow no longer has.' };
        const value = this.inputs[field.key];
        let recordedValue = field.recordedValue;
        if (field.secret) {
          recordedValue = getFieldRecordedValue(field.id) ?? undefined;
          if (recordedValue) this.secrets.push(recordedValue);
        }
        return { value, recordedValue, shownOnPage: field.secret };
      }
      case 'credential': {
        if (!this.login) {
          const raw = this.site.credentialId ? getCredentialValue(this.site.credentialId) : null;
          if (!raw) return { error: `There's no saved sign-in for ${this.site.name}. Record the sign-in again, or add it in the Vault.` };
          try {
            this.login = JSON.parse(raw) as { username?: string; password?: string };
          } catch {
            return { error: `The saved sign-in for ${this.site.name} can't be read. Record the sign-in again.` };
          }
          // Only the password is a secret. A sign-in name isn't (the recorder
          // treats it the same way), and it often appears in ordinary page
          // text and addresses ("practice" in practice.expandtesting.com).
          if (this.login.password) this.secrets.push(this.login.password);
        }
        const v = step.credentialPart ? this.login[step.credentialPart] : undefined;
        if (v === undefined) {
          return { error: `The saved sign-in for ${this.site.name} has no ${step.credentialPart === 'username' ? 'sign-in name' : 'password'}. Record the sign-in again.` };
        }
        return { value: v, recordedValue: v, shownOnPage: false };
      }
    }
  }

  private async runStep(step: WorkflowStep): Promise<StepOutcome> {
    const started = Date.now();
    // Steps that never reach an element (a page change, a hand-off, a key
    // sent to the page) forget the typeahead box; the rest decide in
    // trackTypeahead.
    const box = this.typeahead;
    this.typeahead = undefined;
    const page = await this.pageFor(step);
    if (!page) {
      return this.stop(step, started, 'needs_attention',
        `The window this step happens in (${step.pageAlias === 'page' ? 'the main window' : 'a pop-up'}) isn't open.`);
    }

    if (step.action === 'navigate' || step.action === 'handoff') this.errorWatch = undefined;

    if (step.action === 'navigate') {
      const url = String(step.args.url ?? '');
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
      } catch (err) {
        if (this.closedOrStopped()) return this.stopped(step, started);
        return this.stop(step, started, 'failed', `Couldn't open ${hostOf(url)}. The site may be down or very slow right now.`);
      }
      this.record(step, 'ok', started);
      return { ok: true };
    }

    if (step.action === 'handoff') {
      const reason = typeof step.args.reason === 'string' && step.args.reason.trim()
        ? step.args.reason.trim()
        : 'Finish this step in the browser window yourself.';
      const outcome = await this.pause(step, page, reason);
      if (outcome !== 'done') return this.endAtPause(step, started, outcome);
      this.record(step, 'ok', started, { resolvedBy: 'human' });
      return { ok: true };
    }

    let resolved: ResolvedValue | { error: string };
    try {
      resolved = this.resolveValue(step);
    } catch {
      // The vault couldn't decrypt it: the vault key changed since it was saved.
      resolved = { error: "A saved value for this step can't be unlocked, probably because NodeBrain's vault key changed since it was recorded. Record the workflow again." };
    }
    if ('error' in resolved) return this.stop(step, started, 'failed', resolved.error);
    if (step.valueSource === 'credential') this.credentialFilled = true;
    // The typing of a typeahead pick (reviewDraft.ts typeaheadPairs): the
    // value is the choice. For the recorded choice, the search text typed
    // when recording goes in instead, so that run goes exactly as recorded.
    const search = step.args.searchText;
    if (step.action === 'fill' && step.args.typeahead && typeof search === 'string' && search
        && resolved.value !== undefined && resolved.recordedValue !== undefined && sameValue(resolved.value, resolved.recordedValue)) {
      resolved = { ...resolved, value: search };
    }
    const what = this.describeTarget(step, resolved.value);

    if (step.args.picksTyped && step.action === 'click') {
      return this.pickTyped(page, step, resolved, box, started);
    }

    // A key press with no element: sent to the page.
    if (step.action === 'press' && !step.locator && !step.fingerprint.role) {
      const late = await this.lateErrors(page, step);
      if (late) return this.stop(step, started, 'needs_attention', late, true);
      const errorsBefore = await readPageErrors(page);
      await page.keyboard.press(keyCombo(step)).catch(() => {});
      const appeared = await this.errorsAfter(page, step, errorsBefore, `pressed ${keyCombo(step)}`);
      if (appeared) return this.stop(step, started, 'needs_attention', appeared, true);
      this.record(step, 'ok', started);
      return { ok: true };
    }

    this.typeahead = box;
    // A click right after a click on a control that opens a list (a custom
    // dropdown, a menu): the list must be open for its choice to be there.
    // If it has closed (or never opened), it's opened again before the
    // choice is looked for, and once more before giving up.
    const opener = this.listOpenerFor(step);
    const list: ListCheck = { reopened: false };
    if (opener) await this.openListIfClosed(page, step, resolved.value, opener, list);
    if (this.closedOrStopped()) return this.stopped(step, started);
    const findOpts = {
      value: resolved.value, recordedValue: resolved.recordedValue,
      primaryTimeoutMs: step.optional ? OPTIONAL_PRIMARY_TIMEOUT_MS : PRIMARY_TIMEOUT_MS,
      fallbackTimeoutMs: step.optional ? OPTIONAL_FALLBACK_TIMEOUT_MS : FALLBACK_TIMEOUT_MS,
      signal: this.signal,
      activity: trackActivity(page),
    };
    let found = await findElement(page, step, findOpts);
    if (this.closedOrStopped()) return this.stopped(step, started);
    if (!found.found && !found.ambiguous && opener) {
      // Not there. Failing is the last resort: if the list isn't showing as
      // open, open it and look again. A list that is open and doesn't have
      // the choice isn't clicked (that would close it): that's a real miss.
      if (await this.reopenAfterMiss(page, step, opener, list)) {
        found = await findElement(page, step, {
          ...findOpts, activity: trackActivity(page),
          primaryTimeoutMs: step.optional ? OPTIONAL_PRIMARY_TIMEOUT_MS : LIST_REOPEN_TIMEOUT_MS,
        });
        if (this.closedOrStopped()) return this.stopped(step, started);
      }
      if (!found.found) {
        const now = listState(await this.openerState(page, opener), step);
        // Said only about a control that opens a list, or one just clicked.
        if (now !== 'none' || list.reopened) list.openNow = now;
      }
    }
    // Not there this time, and the person said it doesn't always appear.
    // Several matches isn't "not there": that still stops, as any step would.
    if (!found.found && step.optional && !found.ambiguous) {
      this.record(step, 'skipped', started, { error: OPTIONAL_SKIPPED_TEXT });
      return { ok: true };
    }
    if (!found.found) {
      const inList = opener && list.openNow !== undefined
        ? { opener: this.describeTarget(opener.step, opener.value), reopened: list.reopened, now: list.openNow }
        : undefined;
      const missed = await this.stop(step, started, 'needs_attention', await this.missMessage(page, step, what, found.ambiguous ?? false, inList), true);
      return { ...missed, repairable: true } as StepOutcome;
    }
    if (list.reopened) {
      console.log(`[replay] ${this.run.id} ${step.stepKey}: the list ${opener!.step.stepKey} opens had closed; opened it again`);
    }
    if (found.resolvedBy === 'fallback') {
      console.log(`[replay] ${this.run.id} ${step.stepKey}: saved locator missed, found by ${found.how}`);
    }
    // An error the page put up after the previous step was recorded as done.
    // Nothing has been done at this step yet.
    const late = await this.lateErrors(page, step);
    if (this.closedOrStopped()) return this.stopped(step, started);
    if (late) return this.stop(step, started, 'needs_attention', late, true);

    if (step.requiresConfirmation) {
      const outcome = await this.pause(step, page,
        `Check the page before NodeBrain ${verbPhrase(step, what)}. Click Done to let it carry on, or Stop to end the run here.`);
      if (outcome !== 'done') return this.endAtPause(step, started, outcome);
    }

    if (resolved.shownOnPage && (step.action === 'fill' || step.valueTarget === 'locator' || step.action === 'select')) {
      this.secretShown = true;
    }
    const before = page.url();
    const navigates = step.signals.some((s) => s.name === 'navigation');
    // A pick from a typeahead's list: Enter after typing, or a click on one
    // of its options. Checked against the value meant (see typeahead.ts).
    const pick = this.pickFor(step, found.locator, resolved);
    if (pick?.kind === 'key') {
      const list = await waitForList(found.locator, pick.intended, { activity: trackActivity(page), signal: this.signal });
      if (this.closedOrStopped()) return this.stopped(step, started);
      // No values here: only how the wait ended.
      console.log(`[replay] ${this.run.id} ${step.stepKey}: typeahead list ${list.how} after ${list.waitedMs} ms`);
      // A key that leaves the page can't be checked afterwards: the box is
      // gone. So the list is checked before: what's highlighted is what the
      // key will send.
      if (navigates && list.active !== null && !offers(list.active, pick.intended)) {
        return this.stop(step, started, 'needs_attention', pickMismatchBefore(pick, list.active, String(step.args.key ?? 'the key')), true);
      }
    }
    // The clicked option's own words and attributes, read while it's there:
    // what a box may show instead of the option's name (see below).
    const optionSource = pick?.kind === 'option'
      ? await found.locator.evaluate((el: any) => String(el.outerHTML ?? ''), undefined, { timeout: 500 }).catch(() => '')
      : '';
    const errorsBefore = await readPageErrors(page);
    this.expectDialog = step.signals.some((s) => s.name === 'dialog');
    this.clickedFrom = step.action === 'click' && !navigates
      ? { stepKey: step.stepKey, state: await expandState(found.locator) } : undefined;
    try {
      const problem = await this.perform(page, found.locator, step, resolved.value, what);
      if (problem) return this.stop(step, started, 'needs_attention', problem, true);
      if (step.action === 'fill') {
        const wrong = await this.checkFill(found.locator, step, resolved, what);
        if (this.closedOrStopped()) return this.stopped(step, started);
        if (wrong) return this.stop(step, started, 'needs_attention', wrong, true);
      }
    } catch (err) {
      if (this.closedOrStopped()) return this.stopped(step, started);
      const msg = err instanceof Error ? err.message : String(err);
      const failed = await this.stop(step, started, 'needs_attention', `Found ${what}, but couldn't ${verbFor(step)} it: ${actionProblem(msg)}.`, true, msg);
      return { ...failed, actionFailed: true } as StepOutcome;
    }

    if (pick && !navigates) {
      // Never carry on past a pick that didn't take: a wrong state in a quote
      // is the wrong jurisdiction, rates and forms, and nobody would notice.
      // Some boxes show something other than the clicked option's words:
      // Pie's class-code box shows the code ("5551" for "Roofing - All Kinds
      // - & Drivers"). That counts as taken when the box moved off the typed
      // search text to something that is part of the clicked option itself
      // (its text or an attribute such as data-code="5551"). A different
      // option's name ("Alabama" for a click on Florida) isn't, and stops.
      const source = optionSource.toLowerCase();
      const fromOption = pick.kind === 'option' && source
        ? (shown: string) => {
          const s = shown.trim().toLowerCase();
          return s.length >= 2 && (pick.typed === undefined || !sameValue(shown, pick.typed))
            && (source.includes(s) || source.includes(escapeHtml(s)));
        }
        : undefined;
      const back = await readBack(pick.field, pick.intended, 2_000, fromOption);
      if (this.closedOrStopped()) return this.stopped(step, started);
      if (!back.ok) {
        console.log(`[replay] ${this.run.id} ${step.stepKey}: typeahead pick didn't take`);
        return this.stop(step, started, 'needs_attention', pickMismatchAfter(pick, back.shown), true);
      }
    }
    await this.trackTypeahead(step, found.locator, resolved, pick !== undefined);

    if (step.signals.some((s) => s.name === 'navigation')) {
      await page.waitForURL((u) => u.href !== before, { timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    }
    this.expectDialog = false;
    if (step.action !== 'hover') {
      const appeared = await this.errorsAfter(page, step, errorsBefore, didPhrase(step, what));
      if (this.closedOrStopped()) return this.stopped(step, started);
      if (appeared) return this.stop(step, started, 'needs_attention', appeared, true);
    }
    this.record(step, 'ok', started, { resolvedBy: found.resolvedBy });
    return { ok: true };
  }

  // A step that worked as an action can still have been turned down by the
  // page: an error message under the box it filled, or one Next put up.
  // Returns the stop message when a new error message appeared (and stayed;
  // see pageErrors.ts), else remembers what was showing for lateErrors.
  private async errorsAfter(page: Page, step: WorkflowStep, before: PageError[], did: string): Promise<string | undefined> {
    const appeared = await lastingNewErrors(page, before, this.signal);
    if (appeared.length) {
      console.log(`[replay] ${this.run.id} ${step.stepKey}: the page showed an error message after the step`);
      this.errorWatch = undefined;
      return `After NodeBrain ${did}, the page ${describeErrors(appeared)}. The run stopped here rather than carry on past it.`;
    }
    this.errorWatch = { pageAlias: step.pageAlias, before, did };
    return undefined;
  }

  // The click of a typeahead pick: the choice the run asks for, from the
  // list the typing just opened. Saved without a fixed option, so a run can
  // type "plumbing" where the recording typed "roofing".
  //   - Waits for the list to show the choice by its exact name (case and
  //     spacing aside), or to stop changing for LIST_STILL_MS.
  //   - Exact name: picked. Otherwise, exactly one choice containing the
  //     value: picked ("Plumbing - Commercial" for "commercial").
  //   - Several: stops and names them; it never picks one of them.
  //   - None: stops and says what the list offered.
  // Then the box is read back as for any option pick: it must show the
  // choice, or text that's part of the clicked choice itself (a code).
  // These stops aren't fixed by pointing: pointing at a choice would just
  // make the choice for the person.
  private async pickTyped(page: Page, step: WorkflowStep, resolved: ResolvedValue, box: TypeaheadBox | undefined,
                          started: number): Promise<StepOutcome> {
    const wanted = resolved.value ?? '';
    const secret = resolved.shownOnPage || !!box?.secret;
    // Pie's box is itself called a list ("the "Class Code" list").
    const listWhat = !box ? 'the list' : / list$/.test(box.what) ? box.what : `the list under ${box.what}`;
    const late = await this.lateErrors(page, step);
    if (this.closedOrStopped()) return this.stopped(step, started);
    if (late) return this.stop(step, started, 'needs_attention', late, true);

    const options = page.getByRole('option');
    const want = normChoice(wanted);
    const deadline = Date.now() + 8_000;
    let texts: string[] = [];
    let last = '';
    let stillSince = Date.now();
    for (;;) {
      texts = (await options.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, ' ').trim());
      if (texts.some((t) => normChoice(t) === want)) break;
      const sig = texts.join('\u0001');
      if (sig !== last) { last = sig; stillSince = Date.now(); }
      if (Date.now() - stillSince >= LIST_STILL_MS || Date.now() >= deadline || this.closedOrStopped()) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (this.closedOrStopped()) return this.stopped(step, started);

    const exact = texts.flatMap((t, i) => (normChoice(t) === want ? [i] : []));
    const partial = texts.flatMap((t, i) => (want && normChoice(t).includes(want) ? [i] : []));
    const hits = exact.length ? exact : partial;
    const listed = (ix: number[]) => ix.slice(0, 5).map((i) => `"${texts[i]}"`).join(', ') + (ix.length > 5 ? `, and ${ix.length - 5} more` : '');
    const asked = secret ? 'The value you gave' : `"${wanted}"`;
    if (hits.length !== 1) {
      const error = hits.length > 1
        ? `${asked} matches ${hits.length} choices in ${listWhat}: ${listed(hits)}. The run stopped here rather than pick one. Give the choice as the list shows it.`
        : `${asked} isn't one of the choices in ${listWhat}. ${texts.length ? `It offered ${listed(texts.map((_, i) => i))}.` : 'It offered nothing.'} The run stopped here rather than guess.`;
      console.log(`[replay] ${this.run.id} ${step.stepKey}: typeahead pick found ${hits.length} matching choices of ${texts.length}`);
      return this.stop(step, started, 'needs_attention', error, true);
    }
    const option = options.nth(hits[0]);
    const chosen = texts[hits[0]];
    const optionSource = (await option.evaluate((el: any) => String(el.outerHTML ?? ''), undefined, { timeout: 500 }).catch(() => '')).toLowerCase();
    const errorsBefore = await readPageErrors(page);
    try {
      await option.click({ timeout: ACTION_TIMEOUT_MS });
    } catch (err) {
      if (this.closedOrStopped()) return this.stopped(step, started);
      const msg = err instanceof Error ? err.message : String(err);
      // Not held for a fix: a typeahead pick is checked by reading the box
      // back, which a pick made by hand would skip (see the note above).
      return this.stop(step, started, 'needs_attention', `Found the choice in ${listWhat}, but couldn't click it: ${actionProblem(msg)}.`, true, msg);
    }
    this.typeahead = undefined;
    if (box) {
      const back = await readBack(box.el, chosen, 2_000, (shown) => {
        const s = shown.trim().toLowerCase();
        return s.length >= 2 && (box.typed === undefined || !sameValue(shown, box.typed))
          && (optionSource.includes(s) || optionSource.includes(escapeHtml(s)));
      });
      if (this.closedOrStopped()) return this.stopped(step, started);
      if (!back.ok) {
        const pick: Pick = { kind: 'option', field: box.el, fieldWhat: box.what, intended: chosen, secret };
        return this.stop(step, started, 'needs_attention', pickMismatchAfter(pick, back.shown), true);
      }
    }
    const appeared = await this.errorsAfter(page, step, errorsBefore, `picked ${secret ? 'the choice' : `"${chosen}"`} in ${listWhat}`);
    if (this.closedOrStopped()) return this.stopped(step, started);
    if (appeared) return this.stop(step, started, 'needs_attention', appeared, true);
    this.record(step, 'ok', started);
    return { ok: true };
  }

  // An error message that came up only after the previous step was checked
  // (a site that checks with its server first). Read before this step acts.
  private async lateErrors(page: Page, step: WorkflowStep): Promise<string | undefined> {
    const watch = this.errorWatch;
    if (!watch || watch.pageAlias !== step.pageAlias) return undefined;
    const appeared = await lastingNewErrors(page, watch.before, this.signal);
    if (!appeared.length) return undefined;
    console.log(`[replay] ${this.run.id} ${step.stepKey}: the page showed an error message after the previous step`);
    this.errorWatch = undefined;
    return `After NodeBrain ${watch.did} (the step before this one), the page ${describeErrors(appeared)}. The run stopped here, before going on.`;
  }

  // What a box shows after typing into it, compared with what was typed.
  // Formatting the page adds doesn't count ("412000" showing as "412,000",
  // "2145550142" as "(214) 555-0142"): only the letters and digits must be
  // the same. A box that shows something else (a mask that only reacts to
  // key presses, a length limit that cut the text off) is typed again key by
  // key, as a person would; if it still doesn't show the value, the run
  // stops. A box that can't be read back (not a text box) isn't checked.
  private async checkFill(el: Locator, step: WorkflowStep, resolved: ResolvedValue, what: string): Promise<string | undefined> {
    const value = resolved.value ?? '';
    let ahead: boolean | undefined;
    const read = async (): Promise<{ ok: boolean; shown: string | null }> => {
      const deadline = Date.now() + 1_000;
      for (;;) {
        const shown = await el.inputValue({ timeout: 500 }).catch(() => null);
        if (shown === null) return { ok: true, shown };
        if (sameTyped(shown, value)) return { ok: true, shown };
        // A typeahead may complete the word in the box ("Tex" → "Texas").
        ahead ??= await isTypeahead(el);
        if (ahead && offers(shown, value)) return { ok: true, shown };
        if (Date.now() >= deadline || this.closedOrStopped()) return { ok: false, shown };
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    let r = await read();
    if (r.ok) return undefined;
    console.log(`[replay] ${this.run.id} ${step.stepKey}: the box didn't show what fill put in; typing it key by key`);
    await el.fill('', { timeout: ACTION_TIMEOUT_MS });
    await el.pressSequentially(value, { delay: 30, timeout: ACTION_TIMEOUT_MS + value.length * 100 });
    r = await read();
    if (r.ok) return undefined;
    const secret = resolved.shownOnPage || step.valueSource === 'credential';
    const tail = ' The run stopped here rather than carry on with the wrong value.';
    if (secret) return `After typing into ${what}, it doesn't show the value you gave.${tail}`;
    const now = r.shown === null || r.shown.trim() === '' ? "it's empty" : `it shows "${r.shown}"`;
    return `After typing "${value}" into ${what}, ${now}.${tail}`;
  }

  // Whether this step picks from the typeahead the steps before it used, and
  // the value it should end up showing:
  //   - Enter or Tab in the box, right after typing into it: the text typed
  //     (the recording typed the whole choice, e.g. "Texas");
  //   - a click on an option after typing into or clicking the box: the
  //     option's name (the run's value when the option is the value slot).
  // Not a pick it can check: arrow keys pressed after the typing (the choice
  // was "the 2nd suggestion", and nothing recorded which one that was).
  private pickFor(step: WorkflowStep, el: Locator, resolved: ResolvedValue): Pick | undefined {
    const box = this.typeahead;
    if (!box || box.pageAlias !== step.pageAlias) return undefined;
    if (step.action === 'press') {
      const key = String(step.args.key ?? '');
      const sameBox = !!step.locator && step.locator === box.locator;
      if (!sameBox || (key !== 'Enter' && key !== 'Tab') || modifierKeys(step.args.modifiers).length) return undefined;
      if (box.typed === undefined || box.typed === '' || box.moved) return undefined;
      return { kind: 'key', field: el, fieldWhat: box.what, intended: box.typed, secret: box.secret };
    }
    if (step.action === 'click' && step.fingerprint.role === 'option') {
      const intended = step.valueTarget === 'locator' ? resolved.value : step.fingerprint.name;
      if (!intended?.trim() || intended.includes(WORKFLOW_VALUE_PLACEHOLDER)) return undefined;
      return { kind: 'option', field: box.el, fieldWhat: box.what, intended, typed: box.typed, secret: resolved.shownOnPage || box.secret };
    }
    return undefined;
  }

  // Remembers the typeahead box a step typed into or clicked; any step
  // somewhere else (or a pick, which used it up) forgets it.
  private async trackTypeahead(step: WorkflowStep, el: Locator, resolved: ResolvedValue, picked: boolean): Promise<void> {
    const box = this.typeahead;
    this.typeahead = undefined;
    if (picked || !step.locator || !['fill', 'click', 'press'].includes(step.action)) return;
    const same = box && box.locator === step.locator && box.pageAlias === step.pageAlias ? box : undefined;
    if (!same && !step.args.typeahead && !(await isTypeahead(el))) return;
    const next: TypeaheadBox = same ?? {
      pageAlias: step.pageAlias, locator: step.locator, el, moved: false, secret: false,
      what: this.describeTarget(step, resolved.value),
    };
    if (step.action === 'fill') {
      next.typed = resolved.value;
      next.moved = false;
      next.secret = resolved.shownOnPage;
    } else if (step.action === 'press') {
      next.moved = true; // a key other than the pick: an arrow, Backspace…
    }
    this.typeahead = next;
  }

  // Returns a plain-words problem when the step can't be done as recorded,
  // without trying something else instead.
  private async perform(page: Page, el: Locator, step: WorkflowStep, value: string | undefined, what: string): Promise<string | undefined> {
    const timeout = ACTION_TIMEOUT_MS;
    switch (step.action) {
      case 'click': {
        const a = step.args;
        const opts = {
          timeout,
          button: (a.button === 'right' || a.button === 'middle' ? a.button : 'left') as 'left' | 'right' | 'middle',
          clickCount: typeof a.clickCount === 'number' && a.clickCount > 0 ? a.clickCount : 1,
          modifiers: modifierKeys(a.modifiers),
          ...(isPoint(a.position) ? { position: a.position } : {}),
        };
        if (step.signals.some((s) => s.name === 'popup') && this.context) {
          await Promise.all([this.context.waitForEvent('page', { timeout }).catch(() => {}), el.click(opts)]);
        } else {
          await el.click(opts);
        }
        // A step a repair added: the recording never saw this click, so it
        // has no recorded page change to wait for. Give the page a moment to
        // start going somewhere; if it does, wait for the new page to load.
        // The next step's search would otherwise settle on the old page.
        if (step.args.pointedAt && !step.signals.some((s) => s.name === 'navigation')) {
          const before = page.url();
          const moved = await page.waitForURL((u) => u.href !== before, { timeout: POINTED_NAV_WAIT_MS }).then(() => true, () => false);
          if (moved) await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
        }
        return undefined;
      }
      case 'fill':
        await el.fill(value ?? '', { timeout });
        return undefined;
      case 'press':
        await el.press(keyCombo(step), { timeout });
        return undefined;
      case 'check':
        await el.check({ timeout });
        return undefined;
      case 'uncheck':
        await el.uncheck({ timeout });
        return undefined;
      case 'hover':
        await el.hover({ timeout });
        return undefined;
      case 'select': {
        const byLabel = step.args.matchBy !== 'value';
        let wanted: string[];
        if (step.valueSource === 'field' || step.literalSecret) {
          wanted = value !== undefined ? [value] : [];
        } else {
          const labels = (step.args.optionLabels as string[] | undefined) ?? [];
          const values = (step.args.optionValues as string[] | undefined) ?? [];
          wanted = byLabel && labels.length ? labels : values;
        }
        const options = await el.evaluate((s: any) =>
          Array.from(s.options ?? []).map((o: any) => ({ label: String(o.label ?? o.text ?? '').trim(), value: String(o.value) })),
        ).catch(() => [] as { label: string; value: string }[]);
        const missing = wanted.filter((w) => !options.some((o) => (byLabel ? o.label === w.trim() : o.value === w)));
        if (missing.length) {
          return `${capitalise(what)} has no choice called "${missing.join('", "')}".`;
        }
        await el.selectOption(byLabel ? wanted.map((label) => ({ label: label.trim() })) : wanted, { timeout });
        return undefined;
      }
      case 'upload':
        if (step.valueTarget === 'file' && value) {
          await el.setInputFiles(value, { timeout });
          return undefined;
        }
        return "This step attaches a file, and NodeBrain can't choose files on its own yet.";
      default:
        return `NodeBrain doesn't know how to replay a "${step.action}" step yet.`;
    }
  }

  // Sites recorded before NodeBrain read favicons and names get them on
  // their next run: on the first few loads of a site page, while missing.
  private watchSiteLook(page: Page): void {
    let wantIcon = !siteIconFile(this.site.siteKey);
    let wantName = isDefaultSiteName(this.site.siteKey, this.site.name);
    let tries = 0;
    const onLoad = (): void => {
      if ((!wantIcon && !wantName) || tries >= 4) { page.off('load', onLoad); return; }
      tries++;
      void captureSiteLook(page, this.site.siteKey, { icon: wantIcon, name: wantName }).then((look) => {
        if (look.iconSaved) wantIcon = false;
        if (!look.name) return;
        wantName = false;
        const current = getSiteAgentById(this.site.id);
        if (current && isDefaultSiteName(current.siteKey, current.name)) updateSiteAgent(current.id, { name: look.name });
      }).catch(() => {});
    };
    page.on('load', onLoad);
  }

  // Take Control: the window is the person's until they press Done or Stop.
  // A run nobody is watching can't wait for a person, so it stops instead.
  private async pause(step: WorkflowStep, page: Page, reason: string): Promise<'done' | 'stopped' | 'unattended'> {
    if (this.run.trigger === 'schedule') return 'unattended';
    this.entry.shown = true;
    await page.bringToFront().catch(() => {});
    console.log(`[replay] ${this.run.id} ${step.stepKey}: waiting for the person in the browser`);
    // The wait also ends when the window goes: closed by the person, or the
    // browser quit. Before, only Done or Stop ended it, so a window closed
    // during a pause left the run (and the site) waiting forever.
    const ended = new AbortController();
    const onEnd = () => ended.abort();
    const browser = this.entry.launched?.browser;
    this.signal.addEventListener('abort', onEnd);
    browser?.on('disconnected', onEnd);
    if (this.signal.aborted || this.browserGone) ended.abort();
    try {
      const done = await requestTakeControl({ runId: this.run.id, title: this.workflow.name, reason }, ended.signal);
      if (this.browserGone) return 'stopped';
      return done ? 'done' : 'stopped';
    } finally {
      this.signal.removeEventListener('abort', onEnd);
      browser?.off('disconnected', onEnd);
    }
  }

  private async endAtPause(step: WorkflowStep, started: number, outcome: 'stopped' | 'unattended'): Promise<StepOutcome> {
    if (outcome === 'unattended') {
      return this.stop(step, started, 'needs_attention',
        'This step needs a person (to type a code or check the page), but the workflow ran on its own. Start it yourself and stay nearby.');
    }
    this.record(step, 'skipped', started, { error: 'You stopped the run here.' });
    return { ok: false, status: 'cancelled', error: 'You stopped the run.' };
  }

  private closedOrStopped(): boolean {
    return this.signal.aborted || this.browserGone;
  }

  private stopped(step: WorkflowStep, started: number): StepOutcome {
    const error = this.signal.aborted ? 'You stopped the run.' : 'The browser window was closed before the workflow finished.';
    this.record(step, 'failed', started, { error });
    return { ok: false, status: 'cancelled', error };
  }

  // `raw` is Playwright's own message, kept on the step row (never shown) so
  // a failure can be looked into afterwards. It names the selector and often
  // the element's markup, and a selector can hold a typed value, so it goes
  // through redact(), and isn't kept at all once a saved sign-in went in:
  // redact() only knows the password, and the sign-in name or a value the
  // page reformatted could still be in it.
  private async stop(step: WorkflowStep, started: number, status: WorkflowRunStatus, error: string, screenshot = false,
                     raw?: string): Promise<StepOutcome> {
    let screenshotPath: string | undefined;
    if (screenshot) screenshotPath = await this.screenshot(step) ?? await this.failurePicture(step);
    // Playwright's call log comes with terminal colour codes; they go.
    // eslint-disable-next-line no-control-regex
    const rawError = raw && !this.credentialFilled ? this.redact(raw.replace(/\u001b\[[0-9;]*m/g, '')).slice(0, 4000) : undefined;
    this.record(step, 'failed', started, { error, screenshotPath, rawError });
    return { ok: false, status, error };
  }

  // A picture of where the run stopped when the window is minimized (the
  // usual case), where screenshot() can't take one: the page copy, through
  // the same finalPicture path as the end of the run, so the same rules
  // hold (no picture once a secret is showing, the copy deleted in its
  // finally). After a saved sign-in went in, no failure picture at all.
  private async failurePicture(step: WorkflowStep): Promise<string | undefined> {
    if (this.credentialFilled) return undefined;
    const page = this.pages.get(step.pageAlias);
    if (!page || page.isClosed() || this.closedOrStopped()) return undefined;
    return this.finalPicture(page, `${step.stepKey}.png`);
  }

  // A picture of where the run stopped, so the person can see it. Not taken
  // once a secret (other than a masked password) is showing on the page.
  // Not taken while the window is minimized (it's only showing once the
  // person has brought it up): Chrome draws no frames for a minimized
  // window, and every way of capturing waits for one. Measured 2026-11-08 on
  // Chrome 157: 5 s timeouts and no picture on every miss, once 110 s;
  // Playwright's anti-throttling launch flags didn't change it, and restoring
  // the window off-screen to capture took keyboard focus. The Fix screen's
  // "Show the page" takes it instead, with the window brought forward.
  private async screenshot(step: WorkflowStep): Promise<string | undefined> {
    if (this.secretShown || !this.entry.shown) return undefined;
    const page = this.pages.get(step.pageAlias);
    if (!page || page.isClosed()) return undefined;
    const dir = path.join(getDataDir(), 'workflow-runs', this.run.id);
    const file = path.join(dir, `${step.stepKey}.png`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return undefined;
    }
    const ok = await page.screenshot({ path: file, timeout: 5_000 }).then(() => true, () => false);
    return ok ? file : undefined;
  }

  // "Show the page" on a run held for a fix: the window comes forward (as
  // for "Show me where it is"), the picture is taken, and the stopped step's
  // row gets it.
  private async takePicture(step: WorkflowStep): Promise<boolean> {
    const page = this.pages.get(step.pageAlias);
    if (!page || page.isClosed() || this.secretShown) return false;
    this.entry.shown = true;
    await page.bringToFront().catch(() => {});
    const file = await this.screenshot(step);
    if (!file) return false;
    const row = [...getRunSteps(this.run.id)].reverse().find((r) => r.stepKey === step.stepKey && r.status === 'failed');
    if (!row) return false;
    setRunStepScreenshot(row.id, file);
    return true;
  }

  private describeTarget(step: WorkflowStep, value: string | undefined): string {
    return describeStepTarget(step, value, this.steps, this.fieldsById);
  }

  // ── Picking from a list another step opened ───────────────────────────────
  //
  // A custom dropdown (HubSpot's Lead Status) is two recorded steps: a click
  // on the control, then a click on the choice. The choice is a button in a
  // pop-up that exists only while the list is open. The recorder doesn't
  // pair the two; they're independent steps. So when the choice is missing
  // the run used to stop at once, even when the list had simply closed again
  // (the page re-drew after its address changed, or the first click came
  // before the control was ready).
  //
  // The step before is treated as the choice's opener only when it was a
  // click done in this run, in the same window, and its element is still
  // there, exactly once, by its saved locator. Whether the list is open is
  // read from that element (or the wrapper or child that carries it):
  //   aria-expanded="true"  → open; aria-expanded="false" → closed;
  //   no aria-expanded but aria-haspopup or role=combobox → can't tell;
  //   none of those → not an opener, unless the choice itself was recorded
  //   as a list item (role option / menuitem…, or inside a named list),
  //   then → can't tell.
  // Closed: opened before looking. Can't tell: opened only after the choice
  // wasn't found (a list that was open and lacks the choice gets closed by
  // that click, and the run stops anyway). Open: never clicked.
  // A native <select> is a 'select' step and never comes through here.

  private listOpenerFor(step: WorkflowStep): { step: WorkflowStep; value?: string } | undefined {
    const prev = this.lastDone;
    if (step.action !== 'click' || step.args.picksTyped || !prev || prev === step) return undefined;
    if (prev.action !== 'click' || prev.pageAlias !== step.pageAlias || !prev.locator) return undefined;
    if (prev.signals.some((s) => s.name === 'navigation' || s.name === 'popup')) return undefined;
    // Its list was open when it was clicked: that click closed it (a section
    // folded away), so it isn't opened again.
    if (this.clickedFrom?.stepKey === prev.stepKey && this.clickedFrom.state === 'open') return undefined;
    // Immediately before, apart from optional steps that were skipped.
    const i = this.steps.findIndex((s) => s.stepKey === step.stepKey);
    const j = this.steps.findIndex((s) => s.stepKey === prev.stepKey);
    if (j < 0 || i <= j || this.steps.slice(j + 1, i).some((s) => !s.optional)) return undefined;
    let value: string | undefined;
    if (prev.valueTarget === 'locator') {
      try {
        const v = this.resolveValue(prev);
        if ('error' in v || v.value === undefined) return undefined;
        value = v.value;
      } catch { return undefined; }
    }
    return { step: prev, value };
  }

  private openerLocator(page: Page, opener: { step: WorkflowStep; value?: string }): Locator {
    const sel = opener.step.valueTarget === 'locator' ? fillTemplate(opener.step.locator!, opener.value ?? '') : opener.step.locator!;
    return page.locator(sel);
  }

  private async openerState(page: Page, opener: { step: WorkflowStep; value?: string }): Promise<OpenerState> {
    const loc = this.openerLocator(page, opener);
    if ((await loc.count().catch(() => 0)) !== 1) return 'none';
    return expandState(loc);
  }

  // How many elements the step's saved locator matches right now; -1 when
  // it has none to check.
  private async choiceCount(page: Page, step: WorkflowStep, value: string | undefined): Promise<number> {
    if (!step.locator) return -1;
    if (step.valueTarget === 'locator' && value === undefined) return -1;
    const sel = step.valueTarget === 'locator' ? fillTemplate(step.locator, value!) : step.locator;
    return page.locator(sel).count().catch(() => -1);
  }

  // Before looking: the choice isn't there and the opener says its list is
  // closed. A list still opening can show "closed" for a moment after the
  // click, so it has to stay closed for LIST_CLOSED_GRACE_MS first.
  private async openListIfClosed(page: Page, step: WorkflowStep, value: string | undefined,
                                 opener: { step: WorkflowStep; value?: string }, list: ListCheck): Promise<void> {
    const until = Date.now() + LIST_CLOSED_GRACE_MS;
    for (;;) {
      if (this.closedOrStopped()) return;
      if ((await this.choiceCount(page, step, value)) !== 0) return;
      if ((await this.openerState(page, opener)) !== 'closed') return;
      if (Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    list.reopened = await this.clickOpener(page, opener);
  }

  // After the choice wasn't found: open the list if it isn't showing as
  // open. True when the opener was clicked.
  private async reopenAfterMiss(page: Page, step: WorkflowStep, opener: { step: WorkflowStep; value?: string },
                                list: ListCheck): Promise<boolean> {
    if (list.reopened) return false; // opened once already for this step
    const state = listState(await this.openerState(page, opener), step);
    if (state !== 'closed' && state !== 'unknown') return false;
    list.reopened = await this.clickOpener(page, opener);
    return list.reopened;
  }

  private async clickOpener(page: Page, opener: { step: WorkflowStep; value?: string }): Promise<boolean> {
    const a = opener.step.args;
    try {
      await this.openerLocator(page, opener).click({
        timeout: LIST_REOPEN_CLICK_MS,
        ...(isPoint(a.position) ? { position: a.position } : {}),
      });
    } catch {
      return false;
    }
    console.log(`[replay] ${this.run.id}: clicked ${opener.step.stepKey} again to open its list`);
    return true;
  }

  // The run stopped on a step whose element it couldn't find. A person
  // watching can point at the element (replay/repair.ts) and the run carries
  // on from this step with the repaired version. Or they say the step doesn't
  // always appear, and the run skips it and carries on from the next one.
  // Until then the window stays as it is and the run shows as
  // needs_attention. Returns the fixed version's steps and whether to retry
  // or skip the step, or null when the hold ends without a fix: the person
  // closed the window or chose to fix it later, the run was stopped, or
  // nobody answered within REPAIR_HOLD_MS. A run nobody is watching isn't held.
  private async holdForRepair(step: WorkflowStep, error: string, kind: RepairHold['kind']): Promise<{ steps: WorkflowStep[]; how: RepairResume } | null> {
    if (this.run.trigger === 'schedule' || this.closedOrStopped()) return null;
    const page = this.pages.get(step.pageAlias);
    const browser = this.entry.launched?.browser;
    if (!page || page.isClosed() || !browser) return null;
    let value: ResolvedValue | { error: string };
    try { value = this.resolveValue(step); } catch { return null; }
    if ('error' in value) return null;

    updateRunStatus(this.run.id, 'needs_attention', { error: this.redact(error), failedStepKey: step.stepKey });
    replayEvents.emit('run:needs_repair', getRunById(this.run.id));
    console.log(`[replay] ${this.run.id} ${step.stepKey}: holding the window for a repair`);

    const repaired = await new Promise<{ steps: WorkflowStep[]; how: RepairResume } | null>((resolve) => {
      const end = (fixed: { steps: WorkflowStep[]; how: RepairResume } | null) => {
        if (holds.get(this.run.id) !== hold) return;
        holds.delete(this.run.id);
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onGone);
        browser.off('disconnected', onGone);
        resolve(fixed);
      };
      const onGone = () => end(null);
      const hold: RepairHold = {
        kind,
        runId: this.run.id, workflowId: this.workflow.id, versionId: step.versionId, siteKey: this.site.siteKey,
        step, steps: this.steps, fieldsById: this.fieldsById, page,
        value: value.value, recordedValue: value.recordedValue, signal: this.signal,
        redact: (text) => this.redact(text),
        resume: (steps, how) => end({ steps, how }),
        release: () => end(null),
        takePicture: () => this.takePicture(step),
      };
      const timer = setTimeout(onGone, REPAIR_HOLD_MS);
      holds.set(this.run.id, hold);
      this.signal.addEventListener('abort', onGone);
      browser.on('disconnected', onGone);
    });
    if (!repaired) return null;
    updateRunStatus(this.run.id, 'running');
    replayEvents.emit('run:resumed', getRunById(this.run.id));
    return repaired;
  }

  // inList: the step picks from a list the step before opened, and NodeBrain
  // checked the list (opener: that control, described; reopened: it was
  // clicked again for this step; now: the list's state at the end).
  private async missMessage(page: Page, step: WorkflowStep, what: string, ambiguous: boolean,
                            inList?: { opener: string; reopened: boolean; now: OpenerState }): Promise<string> {
    if (ambiguous) {
      return `More than one thing on the page matches ${what}, and NodeBrain can't tell which one is meant. The run stopped here rather than guess.`;
    }
    let found = `Couldn't find ${what}.`;
    if (inList?.now === 'open') {
      found = `Couldn't find ${what} in the list ${inList.opener} opens. ${inList.reopened
        ? 'The list had closed, so NodeBrain opened it again, and that choice isn’t in it.'
        : 'The list is open, and that choice isn’t in it.'}`;
    } else if (inList?.reopened && inList.now === 'unknown') {
      found = `Couldn't find ${what}. NodeBrain clicked ${inList.opener} again to open its list, and that choice still isn’t there.`;
    } else if (inList?.reopened) {
      found = `Couldn't find ${what}. Its list wasn't open, and clicking ${inList.opener} again didn't open it.`;
    }
    let hint = '';
    const here = pathOf(page.url());
    const elsewhere = onDifferentPage(step, page);
    // Taken somewhere else, to what looks like a sign-in page: the session ran out.
    const looksLikeSignIn = elsewhere && step.valueSource !== 'credential'
      && /log ?in|sign ?in|auth/i.test(`${here} ${await page.title().catch(() => '')}`)
      && (await page.locator('input[type=password]').filter({ visible: true }).count().catch(() => 0)) > 0;
    if (looksLikeSignIn) hint = ' The site seems to be asking you to sign in.';
    else if (elsewhere) hint = ' The browser is on a different page from the one this step was recorded on.';
    return `${found}${hint} The run stopped here rather than guess.`;
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

const ROLE_WORDS: Record<string, string> = {
  button: 'button', link: 'link', textbox: 'box', searchbox: 'search box', combobox: 'dropdown',
  checkbox: 'checkbox', radio: 'option', option: 'option', menuitem: 'menu item', tab: 'tab',
  spinbutton: 'number box', listbox: 'list', switch: 'switch',
};

// The browser is on a different page from the one this step was recorded on:
// the address's path isn't the recorded one, record ids aside (pagePath.ts:
// HubSpot's contact record has a new id every run). What missMessage says
// ("The browser is on a different page…"), and what decides whether pointing
// at something replaces the step or adds an alternative to it (repair.ts).
// A step recorded inside a frame is judged by whether the page has that
// frame, not by the main page's address (pagePath.ts onAnotherPageFor).
export function onDifferentPage(step: WorkflowStep, page: PlaceNow): boolean {
  return onAnotherPageFor(step.fingerprint, page);
}

// True for the stop messages missMessage() writes: the element wasn't found,
// or more than one thing matched. Nothing was done to the page at that step.
export function isMissError(text: string | undefined): boolean {
  return !!text && (text.startsWith("Couldn't find ") || text.startsWith('More than one thing on the page matches '));
}

// True for the stop written when a step's element was found but clicking or
// typing into it failed (runStep's catch around perform): "Found the "Add
// contacts" button, but couldn't click it: it's greyed out."
export function isActionError(text: string | undefined): boolean {
  return !!text && text.startsWith('Found ') && / but couldn't .+: /.test(text) && !text.startsWith('Found the choice in ');
}

// "the "Get my quote" button", ""Business name"", "the option you chose".
export function describeStepTarget(
  step: WorkflowStep, value: string | undefined, steps: WorkflowStep[], fieldsById: Map<string, WorkflowField>,
): string {
  const fp = step.fingerprint;
  // The fingerprint can miss the name the locator has: a click on a <p>
  // inside an option (Pie's class-code list) gets the option's locator and
  // the paragraph's facts.
  const fromLocator = locatorRoleName(step.locator);
  let name = fp.label || fp.name || fp.placeholder || fromLocator?.name;
  if (name?.includes(WORKFLOW_VALUE_PLACEHOLDER)) {
    const secret = step.literalSecret || (step.fieldId ? fieldsById.get(step.fieldId)?.secret : false);
    if (secret || value === undefined) return 'the option you chose';
    name = name.split(WORKFLOW_VALUE_PLACEHOLDER).join(value);
  }
  const word = (fromLocator && name === fromLocator.name ? ROLE_WORDS[fromLocator.role] : undefined)
    ?? (fp.role ? ROLE_WORDS[fp.role] : undefined);
  if (name) return word ? `the "${name}" ${word}` : `"${name}"`;
  // No name: say what it showed when recorded (often a dropdown's current
  // choice, which is exactly what tends to change), and which list it opened.
  const shown = /internal:text="((?:[^"\\]|\\.)*)"/.exec(step.locator ?? '')?.[1]?.replace(/\\(.)/g, '$1');
  const next = steps.find((s) => s.position === step.position + 1);
  const opens = next?.fingerprint.container && !next.fingerprint.container.includes(WORKFLOW_VALUE_PLACEHOLDER)
    ? ` (the one that opens the ${next.fingerprint.container} list)` : '';
  if (shown && !shown.includes(WORKFLOW_VALUE_PLACEHOLDER)) return `the part of the page showing "${shown}"${opens}`;
  return word ? `the ${word}${opens}` : `the part of the page this step uses${opens}`;
}

// The last role=…[name="…"] in a saved locator: role "option", name
// "Roofing - All Kinds - &".
export function locatorRoleName(locator: string | undefined): { role: string; name: string } | undefined {
  const all = [...(locator ?? '').matchAll(/internal:role=([a-z]+)\[name="((?:[^"\\]|\\.)*)"[is]?\]/g)];
  const m = all[all.length - 1];
  return m ? { role: m[1], name: m[2].replace(/\\(.)/g, '$1') } : undefined;
}

// A click that picks a choice from a list (a typeahead's suggestions, a
// custom dropdown): its saved element is an option.
export function picksOption(step: WorkflowStep): boolean {
  return step.action === 'click'
    && (step.fingerprint.role === 'option' || locatorRoleName(step.locator)?.role === 'option'
        || /internal:role=option\b/.test(step.locator ?? ''));
}

export function verbFor(step: WorkflowStep): string {
  switch (step.action) {
    case 'fill': return 'type into';
    case 'select': return 'choose from';
    case 'check': return 'tick';
    case 'uncheck': return 'untick';
    case 'press': return 'press a key in';
    case 'hover': return 'point at';
    case 'upload': return 'attach a file to';
    default: return 'click';
  }
}

function verbPhrase(step: WorkflowStep, what: string): string {
  switch (step.action) {
    case 'fill': return `types into ${what}`;
    case 'select': return `makes a choice in ${what}`;
    case 'check': return `ticks ${what}`;
    case 'uncheck': return `unticks ${what}`;
    case 'press': return `presses ${String(step.args.key ?? 'a key')}`;
    default: return `clicks ${what}`;
  }
}

// What a step did, for "After NodeBrain …, the page showed …".
function didPhrase(step: WorkflowStep, what: string): string {
  switch (step.action) {
    case 'fill': return `typed into ${what}`;
    case 'select': return `made a choice in ${what}`;
    case 'check': return `ticked ${what}`;
    case 'uncheck': return `unticked ${what}`;
    case 'press': return `pressed ${keyCombo(step)} in ${what}`;
    case 'upload': return `attached a file to ${what}`;
    default: return `clicked ${what}`;
  }
}

// A box shows what was typed, give or take the formatting the page adds:
// the same letters and digits in the same order, ignoring case.
export function sameTyped(shown: string, typed: string): boolean {
  if (shown === typed) return true;
  const core = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return core(shown) === core(typed) && (core(typed) !== '' || shown.trim() === typed.trim());
}

// The stop messages for a typeahead pick that didn't take (typeahead.ts).
// Secret values are left out of the words altogether, not just redacted.
function pickMismatchAfter(pick: Pick, shown: string | null): string {
  const tail = ' The run stopped here rather than carry on with the wrong value.';
  if (shown === null) {
    return `NodeBrain couldn't read back what ${pick.fieldWhat} shows after choosing, so it can't tell whether the right choice went in.`
      + ' The run stopped here rather than carry on unchecked.';
  }
  if (pick.secret) return `After choosing, ${pick.fieldWhat} doesn't show the value you gave.${tail}`;
  const now = shown.trim() === '' ? "it's empty" : `it shows "${shown}"`;
  return `After choosing "${pick.intended}" in ${pick.fieldWhat}, ${now}.${tail}`;
}

function pickMismatchBefore(pick: Pick, active: string, key: string): string {
  const offered = pick.secret ? 'a different choice from the value you gave' : `"${active}", not "${pick.intended}"`;
  return `The list under ${pick.fieldWhat} was offering ${offered}, so pressing ${key} would have sent the wrong choice.`
    + ' The run stopped here before pressing it.';
}

// Playwright errors, in words a person can act on.
function actionProblem(msg: string): string {
  if (/not enabled|disabled/i.test(msg)) return "it's greyed out";
  if (/intercepts pointer events|not visible|outside of the viewport|not stable/i.test(msg)) return 'something on the page is covering it or it never became visible';
  if (/Cannot type text|Malformed value|not an <input>|not editable/i.test(msg)) return "the page didn't accept that value there";
  if (/Timeout \d+ms exceeded/i.test(msg)) return "the page didn't respond in time";
  return "the page didn't respond as it did when this was recorded";
}

// Recorder modifier bits: 1 Alt, 2 Control, 4 Meta, 8 Shift.
function modifierKeys(bits: unknown): Array<'Alt' | 'Control' | 'Meta' | 'Shift'> {
  const n = typeof bits === 'number' ? bits : 0;
  const out: Array<'Alt' | 'Control' | 'Meta' | 'Shift'> = [];
  if (n & 1) out.push('Alt');
  if (n & 2) out.push('Control');
  if (n & 4) out.push('Meta');
  if (n & 8) out.push('Shift');
  return out;
}

function keyCombo(step: WorkflowStep): string {
  const key = String(step.args.key ?? '');
  return [...modifierKeys(step.args.modifiers), key].join('+');
}

function isPoint(p: unknown): p is { x: number; y: number } {
  return !!p && typeof (p as { x: unknown }).x === 'number' && typeof (p as { y: unknown }).y === 'number';
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the page'; }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A choice's name, compared without case or runs of spaces.
function normChoice(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
}
