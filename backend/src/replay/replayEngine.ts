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
  getFieldRecordedValue, createRun, updateRunStatus, addRunStep, getRunById, getRunSteps,
} from '../db/workflowRepository';
import { getCredentialValue } from '../vault/credentialVault';
import { launchBrowser, closeBrowser, minimizeWindow, BrowserNotFoundError, type LaunchedBrowser } from '../recorder/browserLauncher';
import { listRecordings } from '../recorder/recordingSession';
import { siteKeyToFolderName } from '../recorder/siteIdentity';
import { captureSiteLook, isDefaultSiteName, siteIconFile } from '../recorder/siteLook';
import { claimSiteBrowser, releaseSiteBrowser, siteBrowserHolder } from '../browser/siteBrowserLock';
import { requestTakeControl } from '../browser/takeControl';
import { findElement } from './elementFinder';

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

const PRIMARY_TIMEOUT_MS = 15_000; // page loads and slow widgets
const FALLBACK_TIMEOUT_MS = 3_000; // the page has had its 15 s by then
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATE_TIMEOUT_MS = 60_000;
const SIGN_IN_CHECK_MS = 15_000;
// An optional step (a consent dialog, a cookie banner) gets a shorter look:
// most runs where it's missing would otherwise wait the full 18 s for it.
// Long enough for a dialog that opens just after the page loads.
const OPTIONAL_PRIMARY_TIMEOUT_MS = 6_000;
const OPTIONAL_FALLBACK_TIMEOUT_MS = 1_000;
// What the run view says under an optional step that was skipped.
const OPTIONAL_SKIPPED_TEXT = "Wasn't on the page this time. It doesn't always appear, so NodeBrain carried on.";
const OPTIONAL_MARKED_TEXT = "You said this doesn't always appear, so NodeBrain skipped it and carried on.";

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
export interface RepairHold {
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
  // Carry on with a fixed version's steps: run this step again (it was shown
  // where it is), or skip it (it was marked as not always appearing).
  resume: (steps: WorkflowStep[], then: 'retry' | 'skip') => void;
  release: () => void; // stop waiting: the run ends as needs_attention
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
  | { ok: false; status: WorkflowRunStatus; error: string; repairable?: boolean };

interface ResolvedValue { value?: string; recordedValue?: string; shownOnPage: boolean }

class Replay {
  private secrets: string[] = [];
  private pages = new Map<string, Page>();
  private context?: BrowserContext;
  private browserGone = false;
  private expectDialog = false;
  private secretShown = false; // a secret other than a password is visible on the page
  private login?: { username?: string; password?: string };
  private steps: WorkflowStep[];
  private fieldsById: Map<string, WorkflowField>;
  private done = false;
  private justRepaired?: string; // step key: its next success is recorded as 'repaired'

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
                 extra: { resolvedBy?: WorkflowStepResolvedBy; error?: string; screenshotPath?: string } = {}): void {
    if (this.justRepaired === step.stepKey) {
      this.justRepaired = undefined;
      if (status === 'ok') {
        status = 'repaired';
        extra = { ...extra, resolvedBy: 'human', error: 'You showed NodeBrain where this is now.' };
      }
    }
    const page = this.pages.get(step.pageAlias);
    const url = page && !page.isClosed() ? this.redact(page.url()) : undefined;
    const row = addRunStep(this.run.id, {
      stepKey: step.stepKey, position: step.position, status,
      resolvedBy: extra.resolvedBy, durationMs: Date.now() - started, url,
      error: extra.error ? this.redact(extra.error) : undefined, screenshotPath: extra.screenshotPath,
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
    this.watchDialogs(first);
    // Popups get the same names the recorder gave them: page, popup1, popup2…
    context.on('page', (p) => {
      if ([...this.pages.values()].includes(p)) return;
      this.pages.set(`popup${this.pages.size}`, p);
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
        // A step whose element wasn't found: keep the window as it is and
        // wait for the person to point at the element (replay/repair.ts).
        // A repair brings a new version's steps; the same step runs again.
        const repaired = outcome.repairable ? await this.holdForRepair(step, outcome.error) : null;
        if (repaired) {
          this.steps = repaired.steps;
          blocks = signInBlocks(this.steps);
          if (repaired.then === 'skip') {
            this.record(step, 'skipped', Date.now(), { error: OPTIONAL_MARKED_TEXT });
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
    // The last step is often the submit. Give what it sent time to arrive
    // before the window closes, or the close could cut it off.
    const last = this.pages.get(this.steps[this.steps.length - 1].pageAlias);
    if (last && !last.isClosed()) {
      await new Promise((r) => setTimeout(r, 1_000));
      await last.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    }
    this.finish('completed');
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
    const deadline = Date.now() + SIGN_IN_CHECK_MS;
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
    const page = await this.pageFor(step);
    if (!page) {
      return this.stop(step, started, 'needs_attention',
        `The window this step happens in (${step.pageAlias === 'page' ? 'the main window' : 'a pop-up'}) isn't open.`);
    }

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
    const what = this.describeTarget(step, resolved.value);

    // A key press with no element: sent to the page.
    if (step.action === 'press' && !step.locator && !step.fingerprint.role) {
      await page.keyboard.press(keyCombo(step)).catch(() => {});
      this.record(step, 'ok', started);
      return { ok: true };
    }

    const found = await findElement(page, step, {
      value: resolved.value, recordedValue: resolved.recordedValue,
      primaryTimeoutMs: step.optional ? OPTIONAL_PRIMARY_TIMEOUT_MS : PRIMARY_TIMEOUT_MS,
      fallbackTimeoutMs: step.optional ? OPTIONAL_FALLBACK_TIMEOUT_MS : FALLBACK_TIMEOUT_MS,
      signal: this.signal,
    });
    if (this.closedOrStopped()) return this.stopped(step, started);
    // Not there this time, and the person said it doesn't always appear.
    // Several matches isn't "not there": that still stops, as any step would.
    if (!found.found && step.optional && !found.ambiguous) {
      this.record(step, 'skipped', started, { error: OPTIONAL_SKIPPED_TEXT });
      return { ok: true };
    }
    if (!found.found) {
      const missed = await this.stop(step, started, 'needs_attention', await this.missMessage(page, step, what, found.ambiguous ?? false), true);
      return { ...missed, repairable: true } as StepOutcome;
    }
    if (found.resolvedBy === 'fallback') {
      console.log(`[replay] ${this.run.id} ${step.stepKey}: saved locator missed, found by ${found.how}`);
    }

    if (step.requiresConfirmation) {
      const outcome = await this.pause(step, page,
        `Check the page before NodeBrain ${verbPhrase(step, what)}. Click Done to let it carry on, or Stop to end the run here.`);
      if (outcome !== 'done') return this.endAtPause(step, started, outcome);
    }

    if (resolved.shownOnPage && (step.action === 'fill' || step.valueTarget === 'locator' || step.action === 'select')) {
      this.secretShown = true;
    }
    const before = page.url();
    this.expectDialog = step.signals.some((s) => s.name === 'dialog');
    try {
      const problem = await this.perform(page, found.locator, step, resolved.value, what);
      if (problem) return this.stop(step, started, 'needs_attention', problem, true);
    } catch (err) {
      if (this.closedOrStopped()) return this.stopped(step, started);
      const msg = err instanceof Error ? err.message : String(err);
      return this.stop(step, started, 'needs_attention', `Found ${what}, but couldn't ${verbFor(step)} it: ${actionProblem(msg)}.`, true);
    }

    if (step.signals.some((s) => s.name === 'navigation')) {
      await page.waitForURL((u) => u.href !== before, { timeout: 10_000 }).catch(() => {});
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    }
    this.expectDialog = false;
    this.record(step, 'ok', started, { resolvedBy: found.resolvedBy });
    return { ok: true };
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
    const done = await requestTakeControl({ runId: this.run.id, title: this.workflow.name, reason }, this.signal);
    if (this.browserGone) return 'stopped';
    return done ? 'done' : 'stopped';
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

  private async stop(step: WorkflowStep, started: number, status: WorkflowRunStatus, error: string, screenshot = false): Promise<StepOutcome> {
    let screenshotPath: string | undefined;
    if (screenshot) screenshotPath = await this.screenshot(step);
    this.record(step, 'failed', started, { error, screenshotPath });
    return { ok: false, status, error };
  }

  // A picture of where the run stopped, so the person can see it. Not taken
  // once a secret (other than a masked password) is showing on the page.
  private async screenshot(step: WorkflowStep): Promise<string | undefined> {
    if (this.secretShown) return undefined;
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

  private describeTarget(step: WorkflowStep, value: string | undefined): string {
    return describeStepTarget(step, value, this.steps, this.fieldsById);
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
  private async holdForRepair(step: WorkflowStep, error: string): Promise<{ steps: WorkflowStep[]; then: 'retry' | 'skip' } | null> {
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

    const repaired = await new Promise<{ steps: WorkflowStep[]; then: 'retry' | 'skip' } | null>((resolve) => {
      const end = (fixed: { steps: WorkflowStep[]; then: 'retry' | 'skip' } | null) => {
        if (holds.get(this.run.id) !== hold) return;
        holds.delete(this.run.id);
        clearTimeout(timer);
        this.signal.removeEventListener('abort', onGone);
        browser.off('disconnected', onGone);
        resolve(fixed);
      };
      const onGone = () => end(null);
      const hold: RepairHold = {
        runId: this.run.id, workflowId: this.workflow.id, versionId: step.versionId, siteKey: this.site.siteKey,
        step, steps: this.steps, fieldsById: this.fieldsById, page,
        value: value.value, recordedValue: value.recordedValue, signal: this.signal,
        redact: (text) => this.redact(text),
        resume: (steps, then) => end({ steps, then }),
        release: () => end(null),
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

  private async missMessage(page: Page, step: WorkflowStep, what: string, ambiguous: boolean): Promise<string> {
    if (ambiguous) {
      return `More than one thing on the page matches ${what}, and NodeBrain can't tell which one is meant. The run stopped here rather than guess.`;
    }
    let hint = '';
    const recordedPath = step.fingerprint.urlPath;
    const here = pathOf(page.url());
    const elsewhere = !!recordedPath && !!here && here !== recordedPath;
    // Taken somewhere else, to what looks like a sign-in page: the session ran out.
    const looksLikeSignIn = elsewhere && step.valueSource !== 'credential'
      && /log ?in|sign ?in|auth/i.test(`${here} ${await page.title().catch(() => '')}`)
      && (await page.locator('input[type=password]').filter({ visible: true }).count().catch(() => 0)) > 0;
    if (looksLikeSignIn) hint = ' The site seems to be asking you to sign in.';
    else if (elsewhere) hint = ' The browser is on a different page from the one this step was recorded on.';
    return `Couldn't find ${what}.${hint} The run stopped here rather than guess.`;
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

const ROLE_WORDS: Record<string, string> = {
  button: 'button', link: 'link', textbox: 'box', searchbox: 'search box', combobox: 'dropdown',
  checkbox: 'checkbox', radio: 'option', option: 'option', menuitem: 'menu item', tab: 'tab',
  spinbutton: 'number box', listbox: 'list', switch: 'switch',
};

// True for the stop messages missMessage() writes: the element wasn't found,
// or more than one thing matched. Nothing was done to the page at that step.
export function isMissError(text: string | undefined): boolean {
  return !!text && (text.startsWith("Couldn't find ") || text.startsWith('More than one thing on the page matches '));
}

// "the "Get my quote" button", ""Business name"", "the option you chose".
export function describeStepTarget(
  step: WorkflowStep, value: string | undefined, steps: WorkflowStep[], fieldsById: Map<string, WorkflowField>,
): string {
  const fp = step.fingerprint;
  let name = fp.label || fp.name || fp.placeholder;
  if (name?.includes(WORKFLOW_VALUE_PLACEHOLDER)) {
    const secret = step.literalSecret || (step.fieldId ? fieldsById.get(step.fieldId)?.secret : false);
    if (secret || value === undefined) return 'the option you chose';
    name = name.split(WORKFLOW_VALUE_PLACEHOLDER).join(value);
  }
  const word = fp.role ? ROLE_WORDS[fp.role] : undefined;
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

function pathOf(url: string): string | undefined {
  try { return new URL(url).pathname; } catch { return undefined; }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the page'; }
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
