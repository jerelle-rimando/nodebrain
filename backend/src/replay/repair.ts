import fs from 'fs';
import path from 'path';
import type { Locator, Page } from 'playwright-core';
import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type WorkflowField, type WorkflowRun, type WorkflowRunRepair, type WorkflowRunStep, type WorkflowStep,
  type WorkflowStepFingerprint, type WorkflowVersion,
} from '../../shared-types';
import { getDataDir } from '../db/database';
import {
  getRunById, getRunSteps, getWorkflowById, getSiteAgentById, getStepsByVersion, getFieldsByWorkflow,
  getVersionsByWorkflow, getStepLiteralValue, deriveVersion,
} from '../db/workflowRepository';
import { ELEMENT_FACTS_SOURCE } from '../recorder/pageScript';
import { factsForRef, type SnapshotFacts } from '../recorder/ariaSnapshot';
import { fingerprintFromFacts, listRecordings, type PageElementFacts } from '../recorder/recordingSession';
import { templateLocator, templateFingerprint } from '../recorder/reviewDraft';
import { launchBrowser, closeBrowser, BrowserNotFoundError, type LaunchedBrowser } from '../recorder/browserLauncher';
import { siteKeyToFolderName } from '../recorder/siteIdentity';
import { claimSiteBrowser, releaseSiteBrowser, siteBrowserHolder } from '../browser/siteBrowserLock';
import { buildPhases } from '../workflows/runPlan';
import { findElement } from './elementFinder';
import {
  getRepairHold, isRunActive, markRunBrowserShown, isMissError, describeStepTarget, verbFor, type RepairHold,
} from './replayEngine';

// Repairing a workflow whose step can't find its element any more: the
// person points at the element in the browser and the step is updated. No
// model is involved anywhere on this path.
//
// Picking reuses the recorder's machinery:
//   - Playwright's own recorder, in its "inspecting" mode (page.pickLocator):
//     hovering highlights an element, clicking picks it without pressing it,
//     and the locator comes from the same selector generator that wrote the
//     recorded steps;
//   - the recorder's page-side fingerprint code (ELEMENT_FACTS_SOURCE) and its
//     aria-snapshot facts (factsForRef), merged by fingerprintFromFacts, so a
//     repaired step is described exactly like a recorded one.
// NodeBrain adds only the pill (what to click, Cancel) and hides the
// picker's hover tooltip, which shows the locator text.
//
// A repair writes a new version (deriveVersion, reason 'repair'): every step
// copied, the repaired one with a new locator and fingerprint. The old
// version keeps the old locator, so rollback works.
//
// The other fix is "This doesn't always appear" (markOptional): the step is
// conditional (a consent dialog, a cookie banner), so a new version (reason
// 'optional') marks it optional. Runs then skip it when it's missing and
// still do it when it's there. No browser is needed for this one.
//
// Two cases:
//   - live: the run is holding its window open at the stopped step
//     (replayEngine holdForRepair). After the repair the run carries on from
//     that step with the new version.
//   - later: the run has ended (its window closed, NodeBrain restarted, or it
//     ran on a schedule). NodeBrain opens the site where the run stopped, the
//     person gets to the element and points at it. Nothing is typed or sent,
//     and the run itself doesn't continue; the next run uses the repair.

const REPAIR_BINDING = '__nodebrainRepair';
const SET_STATE_FN = '__nodebrainRepairSetState';
const PILL_HOST_ID = 'nodebrain-repair';
const NTH = /\s*>>\s*nth=(-?\d+)\s*$/;

export class RepairError extends Error {}

type Phase = WorkflowRunRepair['phase'];

interface RepairState {
  phase: NonNullable<Phase>;
  live: boolean;
  problem?: string;
  session?: PickSession;
}

const states = new Map<string, RepairState>(); // by run id

// ── Status for the run view ─────────────────────────────────────────────────

export function repairStatus(runId: string): WorkflowRunRepair | undefined {
  const run = getRunById(runId);
  if (!run || run.status !== 'needs_attention' || !run.failedStepKey || !isMissError(run.error)) return undefined;
  const workflow = getWorkflowById(run.workflowId);
  if (!workflow) return undefined;
  const hold = getRepairHold(runId);
  const runSteps = getRunSteps(runId);
  const stoppedAt = stoppedVersion(run, runSteps);
  const steps = hold ? hold.steps : getStepsByVersion(stoppedAt.versionId);
  const step = steps.find((s) => s.stepKey === run.failedStepKey);
  if (!step) return undefined;
  const fields = getFieldsByWorkflow(workflow.id);
  // Fixed: a fix of this step (shown where it is, or marked optional), from
  // this run, saved after it stopped there. (A run can be fixed more than
  // once as it goes.)
  const fixedBy = hold ? undefined : fixVersions(workflow.id, runId).find((v) =>
    v.repairedStepKey === run.failedStepKey && v.createdAt >= stoppedAt.stoppedAt);
  const state = states.get(runId);
  const live = !!hold;

  // Reasons neither fix can be made from here...
  let blocked: string | undefined;
  if (!live && !fixedBy && workflow.currentVersionId !== stoppedAt.versionId) {
    blocked = 'This workflow has changed since this run, so it can’t be fixed from here. Run it again; if it stops, you can fix it then.';
  } else if (!live && !fixedBy && isRunActive(runId)) {
    blocked = 'This run is still closing its window. Try again in a moment.';
  }
  // ...and one that only stops pointing, which needs the step's value.
  let whyNot = blocked;
  if (!whyNot && !live && !fixedBy && step.valueTarget === 'locator' && valueForLater(run, step, fields) === undefined) {
    whyNot = 'This step picks a choice that was kept secret, so it can only be shown while a run is open. Run it again and fix it when it stops.';
  }
  const pointing = !!state?.phase && state.phase !== 'failed';

  const failedRow = [...runSteps].reverse().find((r) => r.stepKey === step.stepKey && r.status === 'failed');
  return {
    live,
    fixed: !!fixedBy,
    fixedBy: fixedBy ? (fixedBy.reason === 'optional' ? 'optional' : 'pointing') : undefined,
    canFix: !fixedBy && !whyNot,
    whyNot,
    canMarkOptional: !fixedBy && !blocked && !pointing,
    optionalCaution: optionalCaution(step, steps),
    phase: state?.phase,
    problem: state?.problem,
    explanation: explain(run, steps, step, fields, runSteps, live, fixedBy?.reason, hold?.value),
    askText: askText(run, workflow.name, steps, step, fields, runSteps, hold?.value),
    hasScreenshot: !!screenshotFile(failedRow),
  };
}

// The version whose steps the run was on when it last stopped: the run's
// own, or the latest repair made during the run before that stop.
function stoppedVersion(run: WorkflowRun, runSteps: WorkflowRunStep[]): { versionId: string; stoppedAt: string } {
  const failed = [...runSteps].reverse().find((r) => r.stepKey === run.failedStepKey && r.status === 'failed');
  const stoppedAt = failed?.createdAt ?? run.finishedAt ?? run.startedAt;
  const during = fixVersions(run.workflowId, run.id)
    .filter((v) => v.createdAt < stoppedAt)
    .sort((a, b) => b.number - a.number)[0];
  return { versionId: during?.id ?? run.versionId, stoppedAt };
}

// Versions made by fixing a step that this run stopped at.
function fixVersions(workflowId: string, runId: string): WorkflowVersion[] {
  return getVersionsByWorkflow(workflowId).filter((v) => (v.reason === 'repair' || v.reason === 'optional') && v.fromRunId === runId);
}

// The picture the run took when it stopped, if it's still there and inside
// NodeBrain's own run folder.
export function stoppedScreenshot(runId: string): string | undefined {
  const run = getRunById(runId);
  if (!run?.failedStepKey) return undefined;
  const row = [...getRunSteps(runId)].reverse().find((r) => r.stepKey === run.failedStepKey && r.status === 'failed');
  return screenshotFile(row);
}

function screenshotFile(row: WorkflowRunStep | undefined): string | undefined {
  if (!row?.screenshotPath) return undefined;
  const root = path.resolve(getDataDir(), 'workflow-runs');
  const file = path.resolve(row.screenshotPath);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return undefined;
  return file;
}

// ── Starting and stopping ───────────────────────────────────────────────────

// "Show me where it is". Returns once picking has started; the result shows
// in repairStatus (and, for a live run, as the run carrying on).
export async function startRepair(runId: string): Promise<void> {
  const status = repairStatus(runId);
  if (!status) throw new RepairError('This run doesn’t need fixing.');
  if (status.fixed) throw new RepairError('This has already been fixed. Run the workflow again to use it.');
  if (!status.canFix) throw new RepairError(status.whyNot ?? 'This can’t be fixed from here.');
  const existing = states.get(runId);
  if (existing && existing.phase !== 'failed') {
    existing.session?.bringForward();
    return;
  }
  const hold = getRepairHold(runId);
  if (hold) startLive(hold);
  else await startLater(runId);
}

// Cancel on the app side: stops picking. A live run goes back to waiting;
// a later repair closes its window.
export function cancelRepair(runId: string): boolean {
  const state = states.get(runId);
  if (!state?.session) return false;
  state.session.cancel();
  return true;
}

// "This doesn't always appear": the step is conditional (a consent dialog, a
// cookie banner). Saved as a new version with the step marked optional. A
// live run skips it and carries on from the next step; after the run, the
// next run uses it. Either way, later runs skip it only when it's missing.
export function markOptional(runId: string): void {
  const status = repairStatus(runId);
  if (!status) throw new RepairError('This run doesn’t need fixing.');
  if (status.fixed) throw new RepairError('This has already been fixed. Run the workflow again to use it.');
  if (!status.canMarkOptional) {
    throw new RepairError(status.whyNot && !status.canFix ? status.whyNot : 'Finish showing NodeBrain where it is first, or cancel that.');
  }
  const run = getRunById(runId)!;
  const hold = getRepairHold(runId);
  const versionId = hold ? hold.versionId : stoppedVersion(run, getRunSteps(runId)).versionId;
  const stepKey = run.failedStepKey!;
  const wf = getWorkflowById(run.workflowId);
  if (!wf || wf.currentVersionId !== versionId) {
    throw new RepairError('This workflow was changed since this run stopped, so nothing was saved. Run it again.');
  }
  let version;
  try {
    version = deriveVersion(run.workflowId, { reason: 'optional', repairedStepKey: stepKey, fromRunId: runId }, {
      [stepKey]: { optional: true },
    });
  } catch (err) {
    console.error('[repair] could not mark optional:', err instanceof Error ? err.message : err);
    throw new RepairError('NodeBrain couldn’t save that. Nothing was changed.');
  }
  console.log(`[repair] workflow ${run.workflowId}: step ${stepKey} marked optional as version ${version.number} (from run ${runId})`);
  hold?.resume(getStepsByVersion(version.id), 'skip');
}

// "Close the browser, fix it later": a live run stops waiting and ends.
export function releaseRun(runId: string): boolean {
  const hold = getRepairHold(runId);
  if (!hold) return false;
  states.get(runId)?.session?.cancel();
  hold.release();
  return true;
}

function startLive(hold: RepairHold): void {
  markRunBrowserShown(hold.runId); // the picker brings the window forward
  const state: RepairState = { phase: 'picking', live: true };
  states.set(hold.runId, state);
  const session = new PickSession(hold.page, hold.step, hold.steps, hold.fieldsById, hold.value, hold.recordedValue, 'picking', state);
  state.session = session;
  const onAbort = () => session.cancel();
  hold.signal.addEventListener('abort', onAbort);
  void (async () => {
    let problem: string | undefined;
    try {
      const picked = await session.run();
      if (!picked) return; // cancelled: the run goes on waiting
      state.phase = 'saving';
      const steps = saveRepair(hold.workflowId, hold.versionId, hold.step.stepKey, hold.runId, picked);
      await session.close();
      hold.resume(steps, 'retry'); // the run carries on from the repaired step
    } catch (err) {
      console.error('[repair] live repair failed:', err instanceof Error ? err.message : err);
      problem = err instanceof RepairError ? err.message : 'Something went wrong while fixing this step. Nothing was changed.';
      await session.close();
    } finally {
      hold.signal.removeEventListener('abort', onAbort);
      // A problem is shown until the next try; the run keeps waiting.
      if (problem && getRepairHold(hold.runId)) states.set(hold.runId, { phase: 'failed', live: true, problem });
      else states.delete(hold.runId);
    }
  })();
}

async function startLater(runId: string): Promise<void> {
  const run = getRunById(runId)!;
  const workflow = getWorkflowById(run.workflowId)!;
  const site = getSiteAgentById(workflow.siteAgentId);
  if (!site) throw new RepairError('The site this workflow belongs to doesn’t exist anymore.');
  const versionId = stoppedVersion(run, getRunSteps(runId)).versionId;
  const steps = getStepsByVersion(versionId);
  const step = steps.find((s) => s.stepKey === run.failedStepKey)!;
  const fields = getFieldsByWorkflow(workflow.id);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const value = valueForLater(run, step, fields);

  if (siteBrowserHolder(site.siteKey)) throw new RepairError(`Something else is using the ${site.name} browser window right now. Wait for it to finish.`);
  if (listRecordings().some((r) => r.siteKey === site.siteKey && ['recording', 'browser_closed', 'finishing', 'saving'].includes(r.state))) {
    throw new RepairError(`A recording is open for ${site.siteKey}. Finish it or throw it away first.`);
  }
  const holder = `repair:${runId}`;
  claimSiteBrowser(site.siteKey, holder);
  const state: RepairState = { phase: 'opening', live: false };
  states.set(runId, state);

  let launched: LaunchedBrowser | undefined;
  void (async () => {
    try {
      const profileDir = site.profileDir ?? path.join(getDataDir(), 'browser-profiles', siteKeyToFolderName(site.siteKey));
      launched = await launchBrowser(profileDir, site.startUrl);
      const page = launched.context.pages()[0] ?? (await launched.context.newPage());
      const url = whereItStopped(run, step, site.startUrl);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
      await page.bringToFront().catch(() => {});
      const session = new PickSession(page, step, steps, fieldsById, value, value, 'browsing', state);
      state.session = session;
      launched.browser.on('disconnected', () => session.cancel());
      const picked = await session.run();
      if (!picked) {
        states.delete(runId);
        return;
      }
      state.phase = 'saving';
      saveRepair(workflow.id, versionId, step.stepKey, runId, picked);
      await session.close();
      states.delete(runId);
    } catch (err) {
      console.error('[repair] repair failed:', err instanceof Error ? err.message : err);
      const problem = err instanceof BrowserNotFoundError
        ? 'Fixing a workflow needs Google Chrome or Microsoft Edge, and neither was found on this computer.'
        : err instanceof RepairError ? err.message : 'Something went wrong while fixing this step. Nothing was changed.';
      states.set(runId, { phase: 'failed', live: false, problem });
    } finally {
      if (launched) await closeBrowser(launched).catch(() => {});
      releaseSiteBrowser(site.siteKey, holder);
    }
  })();
}

// The page the run was on when it stopped; else the page the step was
// recorded on. A stored address with a hidden value in it can't be used.
function whereItStopped(run: WorkflowRun, step: WorkflowStep, startUrl: string): string {
  const row = [...getRunSteps(run.id)].reverse().find((r) => r.stepKey === step.stepKey && r.status === 'failed');
  if (row?.url && !row.url.includes('•••') && /^https?:/i.test(row.url)) return row.url;
  if (step.origin && step.fingerprint.urlPath) return step.origin + step.fingerprint.urlPath;
  return startUrl;
}

// A step whose choice is part of its locator ("Ohio" in a list) needs the
// value to set the new locator up. After the run, only non-secret values
// are known.
function valueForLater(run: WorkflowRun, step: WorkflowStep, fields: WorkflowField[]): string | undefined {
  if (step.valueTarget !== 'locator') return undefined;
  if (step.valueSource === 'literal') return step.literalSecret ? (getStepLiteralValue(step.id) ?? undefined) : step.literalValue;
  if (step.valueSource === 'field') {
    const f = fields.find((x) => x.id === step.fieldId);
    return f && !f.secret ? run.inputs[f.key] ?? f.recordedValue : undefined;
  }
  return undefined;
}

// ── Saving ──────────────────────────────────────────────────────────────────

interface Picked { locator: string; fingerprint: WorkflowStepFingerprint }

function saveRepair(workflowId: string, versionId: string, stepKey: string, runId: string, picked: Picked): WorkflowStep[] {
  const wf = getWorkflowById(workflowId);
  if (!wf || wf.currentVersionId !== versionId) {
    throw new RepairError('This workflow was changed while you were fixing it, so the fix wasn’t saved. Run it again.');
  }
  let version;
  try {
    version = deriveVersion(workflowId, { reason: 'repair', repairedStepKey: stepKey, fromRunId: runId }, {
      // The old snapshot shows the old page; there's no new one to keep.
      [stepKey]: { locator: picked.locator, fingerprint: picked.fingerprint, snapshotPath: undefined },
    });
  } catch (err) {
    console.error('[repair] could not save:', err instanceof Error ? err.message : err);
    throw new RepairError('NodeBrain couldn’t save that. Nothing was changed. Try pointing at it again.');
  }
  console.log(`[repair] workflow ${workflowId}: step ${stepKey} repaired as version ${version.number} (from run ${runId})`);
  return getStepsByVersion(version.id);
}

// ── Picking ─────────────────────────────────────────────────────────────────

type PillMode = 'picking' | 'browsing' | 'checking';
type PillAction = 'pick' | 'browse' | 'cancel';

// One "show me where it is", in one page: the pill, Playwright's picker, and
// the checks on what was picked. Resolves with the new locator and
// fingerprint, or null when cancelled.
class PickSession {
  private mode: PillMode;
  private cancelled = false;
  private wake?: (a: PillAction) => void;
  private queued?: PillAction;
  private readonly wanted: string;

  constructor(
    private page: Page, private step: WorkflowStep, private steps: WorkflowStep[],
    private fieldsById: Map<string, WorkflowField>, private value: string | undefined,
    private recordedValue: string | undefined, start: PillMode, private state: RepairState,
  ) {
    this.mode = start;
    this.wanted = wantedPhrase(step, value, steps, fieldsById);
  }

  bringForward(): void {
    void this.page.bringToFront().catch(() => {});
  }

  cancel(): void {
    this.cancelled = true;
    this.act('cancel');
  }

  // A press on the pill (or Cancel in the app).
  act(a: PillAction): void {
    if (a === 'browse' || a === 'cancel') void this.page.cancelPickLocator().catch(() => {});
    if (this.wake) { const w = this.wake; this.wake = undefined; w(a); } else this.queued = a;
  }

  private nextAction(): Promise<PillAction> {
    if (this.queued) { const q = this.queued; this.queued = undefined; return Promise.resolve(q); }
    return new Promise((r) => { this.wake = r; });
  }

  pillState(): Record<string, unknown> | null {
    if (this.cancelled) return null;
    return { mode: this.mode, wanted: this.wanted, problem: this.state.problem ?? null };
  }

  private async show(): Promise<void> {
    this.state.phase = this.mode === 'checking' ? 'checking' : this.mode;
    const st = JSON.stringify(this.pillState());
    await this.page.evaluate(`window[${JSON.stringify(SET_STATE_FN)}] && window[${JSON.stringify(SET_STATE_FN)}](${st})`).catch(() => {});
  }

  async close(): Promise<void> {
    this.cancelled = true;
    sessions.delete(this.page);
    await this.page.evaluate(`window[${JSON.stringify(SET_STATE_FN)}] && window[${JSON.stringify(SET_STATE_FN)}](null)`).catch(() => {});
  }

  async run(): Promise<Picked | null> {
    await installPill(this.page);
    sessions.set(this.page, this);
    await this.page.bringToFront().catch(() => {});
    try {
      for (;;) {
        if (this.cancelled || this.page.isClosed()) return null;
        if (this.mode === 'browsing') {
          await this.show();
          const a = await this.nextAction();
          if (a === 'cancel') return null;
          if (a === 'pick') this.mode = 'picking';
          continue;
        }
        await this.show();
        let picked: Locator;
        try {
          picked = await this.page.pickLocator();
        } catch {
          // Cancelled from the pill or the app, Escape, or the page went away.
          if (this.cancelled || this.page.isClosed()) return null;
          const a = this.queued;
          this.queued = undefined;
          if (a === 'cancel') return null;
          this.mode = 'browsing';
          continue;
        }
        this.mode = 'checking';
        this.state.problem = undefined;
        await this.show();
        const result = await this.examine(picked).catch((err): { problem: string } => {
          console.error('[repair] checking the picked element failed:', err instanceof Error ? err.message : err);
          return { problem: 'NodeBrain couldn’t read that part of the page. Try clicking it again.' };
        });
        if ('problem' in result) {
          this.state.problem = result.problem;
          this.mode = 'picking';
          continue;
        }
        return result;
      }
    } finally {
      sessions.delete(this.page);
      if (this.cancelled) await this.close();
    }
  }

  // Is the picked element one this step can use, and will the new locator
  // and fingerprint find it again? Problems are in plain words for the pill.
  private async examine(picked: Locator): Promise<Picked | { problem: string }> {
    // Playwright keeps the selector it generated on the locator. The recorder
    // stores the same kind of selector (from the same generator).
    const selector = (picked as unknown as { _selector?: string })._selector;
    if (!selector || selector.includes(PILL_HOST_ID)) return { problem: 'Click the thing on the page itself, not this bar.' };
    if ((await picked.count()) !== 1) return { problem: 'NodeBrain couldn’t tell exactly which one that was. Try clicking it again.' };

    const facts = await picked.evaluate(pageFacts, this.step.action);
    if (!facts.fits) return { problem: misfitProblem(this.step) };
    const aria = await this.ariaFacts(picked);
    let fingerprint = fingerprintFromFacts(aria, facts.fp);
    let locator = selector;

    // A step whose value is its choice ("Ohio") keeps the value as a slot.
    if (this.step.valueTarget === 'locator') {
      if (this.value === undefined) return { problem: 'NodeBrain doesn’t know which choice this run was making, so it can’t fix this step here.' };
      const template = templateLocator(selector, this.value);
      if (!template) return { problem: `Click the choice that says "${this.value}".` };
      locator = this.value !== this.recordedValue ? template.replace(NTH, '') : template;
      fingerprint = templateFingerprint(fingerprint, this.value);
      if (!fingerprint.name?.includes(WORKFLOW_VALUE_PLACEHOLDER) && fingerprint.name) {
        return { problem: `Click the choice that says "${this.value}".` };
      }
    }

    // The repaired step must find this same element the way a run would.
    const candidate: WorkflowStep = { ...this.step, locator, fingerprint };
    const found = await findElement(this.page, candidate, {
      value: this.value, recordedValue: this.value, primaryTimeoutMs: 2_000, fallbackTimeoutMs: 500,
    });
    const handle = await picked.elementHandle({ timeout: 2_000 }).catch(() => null);
    const same = found.found && handle
      ? await found.locator.evaluate((a: unknown, b: unknown) => a === b, handle).catch(() => false)
      : false;
    await handle?.dispose().catch(() => {});
    if (!same) return { problem: 'NodeBrain couldn’t pin that one down reliably. Try clicking it again, or the part of it with the words on it.' };
    return { locator, fingerprint };
  }

  // Role, name, heading, landmark, list and position, read from the page's
  // aria snapshot the way the recorder reads them from its own.
  private async ariaFacts(picked: Locator): Promise<SnapshotFacts> {
    const own = /^\s*-\s+'?([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/.exec(await picked.ariaSnapshot({ timeout: 2_000 }).catch(() => '')) ?? [];
    const role = own[1];
    const name = own[2]?.replace(/\\(.)/g, '$1');
    const snapshot = await this.page.ariaSnapshot({ mode: 'ai', timeout: 5_000 }).catch(() => '');
    if (role && snapshot) {
      const handle = await picked.elementHandle({ timeout: 2_000 }).catch(() => null);
      for (const line of snapshot.split('\n')) {
        const m = /^\s*-\s+'?([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?.*\[ref=([a-z0-9]+)\]/.exec(line);
        if (!m || m[1] !== role || (m[2]?.replace(/\\(.)/g, '$1') ?? undefined) !== name) continue;
        const same = handle
          ? await this.page.locator(`aria-ref=${m[3]}`).evaluate((a: unknown, b: unknown) => a === b, handle).catch(() => false)
          : false;
        if (same) {
          await handle?.dispose().catch(() => {});
          const facts = factsForRef(snapshot, m[3]);
          delete facts.frameRef;
          return facts;
        }
      }
      await handle?.dispose().catch(() => {});
    }
    return role ? { role, name } : {};
  }
}

// Runs in the page on the picked element: the recorder's element facts
// (retargeted for clicks, as the recorder does), and whether it's the kind
// of element this step acts on.
const PAGE_FACTS_FN = `(picked, action) => {
${ELEMENT_FACTS_SOURCE}
  const el = (action === 'click' || action === 'hover') ? interactive(picked) : picked;
  const tag = el.tagName.toLowerCase();
  const type = tag === 'input' ? (el.type || 'text').toLowerCase() : '';
  const role = (el.getAttribute('role') || '').toLowerCase();
  let fits = true;
  if (action === 'fill') {
    fits = el.isContentEditable || tag === 'textarea'
      || (tag === 'input' && !['checkbox','radio','file','submit','button','image','reset','hidden','range','color'].includes(type))
      || ['textbox','searchbox','combobox','spinbutton'].includes(role);
  } else if (action === 'select') {
    fits = tag === 'select';
  } else if (action === 'check' || action === 'uncheck') {
    fits = (tag === 'input' && (type === 'checkbox' || type === 'radio')) || ['checkbox','radio','switch','menuitemcheckbox','menuitemradio'].includes(role);
  } else if (action === 'upload') {
    fits = tag === 'input' && type === 'file';
  }
  return { fp: fingerprint(el), fits };
}`;

// A real function (its source is what Playwright sends to the page). The
// backend has no DOM types, hence the string.
const pageFacts = new Function(`return ${PAGE_FACTS_FN}`)() as (el: unknown, action: string) => { fp: PageElementFacts; fits: boolean };

function misfitProblem(step: WorkflowStep): string {
  switch (step.action) {
    case 'fill': return 'That isn’t a box you can type into. Click the box itself.';
    case 'select': return 'That isn’t a dropdown list. Click the dropdown itself.';
    case 'check': case 'uncheck': return 'That isn’t a checkbox. Click the box you tick.';
    case 'upload': return 'That isn’t where a file is attached. Click the “choose file” button.';
    default: return 'That one can’t be used for this step. Try another part of it.';
  }
}

// What the pill asks for, in words: "Click the button that said “Submit renewal”".
function wantedPhrase(step: WorkflowStep, value: string | undefined, steps: WorkflowStep[], fieldsById: Map<string, WorkflowField>): string {
  const fp = step.fingerprint;
  const fill = (s: string | undefined) => {
    if (!s) return undefined;
    if (!s.includes(WORKFLOW_VALUE_PLACEHOLDER)) return s;
    const secret = step.literalSecret || (step.fieldId ? fieldsById.get(step.fieldId)?.secret : false);
    return secret || value === undefined ? undefined : s.split(WORKFLOW_VALUE_PLACEHOLDER).join(value);
  };
  const label = fill(fp.label) ?? fill(fp.name) ?? fill(fp.placeholder);
  switch (step.action) {
    case 'fill': return label ? `Click the box for “${label}”` : 'Click the box NodeBrain should type into';
    case 'select': return label ? `Click the dropdown for “${label}”` : 'Click the dropdown NodeBrain should choose from';
    case 'check': case 'uncheck':
      if (fp.role === 'radio') return label ? `Click the “${label}” option` : 'Click the option NodeBrain should pick';
      return label ? `Click the checkbox for “${label}”` : 'Click the checkbox NodeBrain should tick';
    case 'upload': return 'Click where the file gets attached';
    default: {
      const words: Record<string, string> = { button: 'button', link: 'link', tab: 'tab', menuitem: 'menu item', option: 'choice', radio: 'option', checkbox: 'checkbox', combobox: 'dropdown' };
      const word = fp.role ? words[fp.role] : undefined;
      if (step.valueTarget === 'locator') return value !== undefined && !(step.literalSecret || (step.fieldId && fieldsById.get(step.fieldId)?.secret)) ? `Click the “${value}” choice` : 'Click the choice this run was making';
      if (label) return `Click the ${word ?? 'thing'} that said “${label}”`;
      return `Click ${describeStepTarget(step, value, steps, fieldsById)}`;
    }
  }
}

// ── The pill ────────────────────────────────────────────────────────────────

const sessions = new Map<Page, PickSession>();
const contextsReady = new WeakSet<object>();

// Once per browser context: a binding the pill talks through and the pill
// script for every page load. Then into the page that's open now.
async function installPill(page: Page): Promise<void> {
  const context = page.context();
  if (!contextsReady.has(context)) {
    contextsReady.add(context);
    await context.exposeBinding(REPAIR_BINDING, (source, msg: unknown) => {
      const session = sessions.get(source.page);
      if (!session) return null;
      const m = (msg && typeof msg === 'object' ? msg : {}) as { type?: string };
      if (m.type === 'hello') return session.pillState();
      if (m.type === 'pick' || m.type === 'browse' || m.type === 'cancel') {
        if (m.type === 'cancel') session.cancel();
        else session.act(m.type);
      }
      return null;
    });
    await context.addInitScript(PILL_SCRIPT);
  }
  await page.evaluate(PILL_SCRIPT).catch(() => {});
}

// Main world, every frame. Two jobs:
// 1. Hide the hover tooltip of Playwright's picker, which shows the locator
//    text. The picker draws in a closed shadow root on <x-pw-glass>, created
//    by its script in this same world; the stylesheet goes into that root as
//    it's created. Highlighting is unaffected. x-pw-glass and x-pw-tooltip
//    are Playwright-internal names (playwright-core is pinned); if they
//    change, the tooltip shows again and nothing else breaks.
// 2. The pill (top frame): what to click, "I need to open something first" /
//    "Point at it", and Cancel. Its clicks are taken at the window, before
//    the picker (which listens on the document) can treat them as the pick.
const PILL_SCRIPT = `(() => {
  if (window.__nodebrainRepairInstalled) return;
  Object.defineProperty(window, '__nodebrainRepairInstalled', { value: true });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('x-pw-tooltip { display: none !important; }');
    const original = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = original.call(this, init);
      if (this.localName === 'x-pw-glass') { try { root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; } catch {} }
      return root;
    };
  } catch {}
  if (window !== top) return;
  const send = window[${JSON.stringify(REPAIR_BINDING)}];
  if (typeof send !== 'function') return;
  const HOST_ID = ${JSON.stringify(PILL_HOST_ID)};
  let host, root, state = null;

  const css = \`
    .pill { display: flex; align-items: center; gap: 12px; padding: 10px 10px 10px 16px; border-radius: 16px; max-width: min(720px, 92vw);
      background: #1d2026; color: #f4f5f7; font: 500 14px/1.35 "Segoe UI", system-ui, -apple-system, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.06); user-select: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #7aa7ff; flex: none; animation: pulse 1.6s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
    @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
    .text { min-width: 0; }
    .wanted { font-weight: 600; }
    .hint { color: #a9afba; font-size: 12.5px; margin-top: 2px; }
    .problem { color: #ffb86b; font-size: 12.5px; margin-top: 2px; }
    .buttons { display: flex; gap: 6px; flex: none; }
    button { all: unset; cursor: pointer; border-radius: 999px; font: inherit; padding: 6px 12px; white-space: nowrap; }
    button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }
    .primary { background: #f4f5f7; color: #1d2026; font-weight: 600; }
    .plain { color: #d5d8de; }
    .plain:hover { background: rgba(255,255,255,.1); }
  \`;

  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render() {
    if (!host) return;
    if (!state) { host.remove(); return; }
    let hint, buttons;
    if (state.mode === 'browsing') {
      hint = 'Use the page as usual until you can see it, then press Point at it.';
      buttons = '<button class="primary" data-act="pick">Point at it</button><button class="plain" data-act="cancel">Cancel</button>';
    } else if (state.mode === 'checking') {
      hint = 'Checking that one\\u2026';
      buttons = '';
    } else {
      hint = 'Move over the page to highlight it, then click it. Clicking only points at it: nothing gets pressed.';
      buttons = '<button class="plain" data-act="browse">I need to open something first</button><button class="plain" data-act="cancel">Cancel</button>';
    }
    root.querySelector('.slot').innerHTML =
      '<span class="dot"></span><div class="text"><div class="wanted">' + esc(state.wanted) + '</div>' +
      (state.problem ? '<div class="problem">' + esc(state.problem) + '</div>' : '') +
      '<div class="hint">' + esc(hint) + '</div></div><div class="buttons">' + buttons + '</div>';
    mount();
  }

  function build() {
    host = document.createElement(HOST_ID);
    host.id = HOST_ID;
    host.setAttribute('aria-hidden', 'true');
    host.setAttribute('popover', 'manual');
    host.style.cssText = [
      'all: initial', 'position: fixed', 'inset: auto', 'left: 50%', 'bottom: 20px', 'transform: translateX(-50%)',
      'margin: 0', 'padding: 0', 'border: 0', 'background: transparent', 'overflow: visible', 'display: block',
      'z-index: 2147483647',
    ].map((d) => d + ' !important').join(';');
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>' + css + '</style><div class="pill slot"></div>';
  }

  function mount() {
    if (!state || !document.body) return;
    if (!host) { build(); render(); return; }
    if (!host.isConnected) document.documentElement.appendChild(host);
    try { if (!host.matches(':popover-open')) host.showPopover(); } catch {}
  }

  // Everything that happens on the pill stays on the pill: the picker never
  // sees it (so a click here isn't a pick), and neither does the site.
  const onPill = (e) => host && host.isConnected && e.composedPath && e.composedPath()[0] === host;
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'pointermove', 'mousemove', 'pointerover', 'mouseover', 'contextmenu', 'dblclick', 'auxclick']) {
    window.addEventListener(t, (e) => { if (onPill(e)) e.stopImmediatePropagation(); }, true);
  }
  window.addEventListener('click', (e) => {
    if (!onPill(e)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const at = e.detail === 0 ? root.activeElement : root.elementFromPoint(e.clientX, e.clientY);
    const button = at && at.closest && at.closest('button[data-act]');
    if (button) { try { send({ type: button.getAttribute('data-act') }); } catch {} }
  }, true);

  Object.defineProperty(window, ${JSON.stringify(SET_STATE_FN)}, { value: (s) => { state = s; if (!host && s) build(); render(); } });
  document.addEventListener('DOMContentLoaded', mount);
  setInterval(mount, 1000);
  send({ type: 'hello' }).then((s) => { if (s) { state = s; if (!host) build(); render(); } }).catch(() => {});
})();`;

// ── The explanation ─────────────────────────────────────────────────────────

const SUBMIT_WORDS = /\b(submit|save|confirm|pay|purchase|buy|bind|order|checkout|send|renew|apply|finish|place)\b/i;

const GERUNDS: Array<[RegExp, string]> = [
  [/^Type /, 'typing '], [/^Clear /, 'clearing '], [/^Choose /, 'choosing '], [/^Pick /, 'picking '],
  [/^Tick /, 'ticking '], [/^Untick /, 'unticking '], [/^Click /, 'clicking '], [/^Open /, 'opening '],
  [/^Go to /, 'going to '], [/^Press /, 'pressing '], [/^Point at /, 'pointing at '], [/^Attach /, 'attaching '],
];

function sentences(run: WorkflowRun, steps: WorkflowStep[], fields: WorkflowField[]): Map<string, string> {
  const out = new Map<string, string>();
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const phase of buildPhases(steps, fields)) {
    for (const p of phase.steps) {
      out.set(p.stepKey, p.segments.map((g) => {
        if (!('field' in g)) return g.text;
        const f = byKey.get(g.field);
        if (!f || f.secret) return `your ${f?.label ?? 'value'}`;
        const v = run.inputs[g.field];
        return v !== undefined ? `"${v}"` : f.label;
      }).join(''));
    }
  }
  return out;
}

function gerund(sentence: string | undefined): string {
  if (!sentence) return 'the step before';
  for (const [re, ing] of GERUNDS) if (re.test(sentence)) return sentence.replace(re, ing);
  return 'the step before';
}

// Said under "This doesn't always appear" when the step is one a workflow
// can't really do without: the click that sends a form, or the one that
// submits a sign-in: a click or key press that took the browser to another
// page after a saved sign-in was typed on this one. (signInBlocks isn't used
// here: it ends a block at the first click after the password, which on the
// Roblox recording was a click on the page background, not "Sign in".)
function optionalCaution(step: WorkflowStep, steps: WorkflowStep[]): string | undefined {
  if (signsIn(step, steps)) {
    return 'This step looks like the one that signs in. If it’s marked as not always appearing, a run where it’s missing will carry on without signing in.';
  }
  if (submitLike(step)) {
    return 'This step looks like the one that sends the form. If it’s marked as not always appearing, a run where it’s missing will finish without sending anything.';
  }
  return undefined;
}

function signsIn(step: WorkflowStep, steps: WorkflowStep[]): boolean {
  if ((step.action !== 'click' && step.action !== 'press') || !step.signals.some((s) => s.name === 'navigation')) return false;
  for (let i = steps.findIndex((s) => s.stepKey === step.stepKey) - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.pageAlias !== step.pageAlias) continue;
    if (s.action === 'navigate' || s.signals.some((x) => x.name === 'navigation')) return false;
    if (s.valueSource === 'credential') return true;
  }
  return false;
}

function submitLike(step: WorkflowStep): boolean {
  if (step.action === 'press') return step.args.key === 'Enter';
  if (step.action !== 'click') return false;
  const fp = step.fingerprint;
  return SUBMIT_WORDS.test(`${fp.name ?? ''} ${fp.label ?? ''}`) || fp.inputType === 'submit';
}

// "I got as far as typing "12345" into "Policy number", then couldn't find
// the "Submit renewal" button I usually click. I stopped there, so that step
// and the 2 after it didn't happen. Nothing on this page has been sent."
function explain(
  run: WorkflowRun, steps: WorkflowStep[], step: WorkflowStep, fields: WorkflowField[],
  runSteps: WorkflowRunStep[], live: boolean, fixed: WorkflowVersion['reason'] | undefined, liveValue: string | undefined,
): string {
  const words = sentences(run, steps, fields);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const value = liveValue ?? valueForLater(run, step, fields);
  const what = describeStepTarget(step, value, steps, fieldsById);
  const verb = verbFor(step);
  const done = runSteps.filter((r) => (r.status === 'ok' || r.status === 'repaired') && r.position < step.position);
  const last = done.length ? done[done.length - 1] : undefined;
  const ambiguous = run.error?.startsWith('More than one');

  const miss = ambiguous
    ? `found more than one ${stripArticle(what)} and couldn’t tell which one to ${verb}`
    : `couldn’t find ${what} I usually ${verb}`;
  const first = last
    ? `I got as far as ${gerund(words.get(last.stepKey))}, then ${miss}.`
    : `I stopped at the start: I ${miss}.`;

  const after = steps.filter((s) => s.position > step.position).length;
  let second = after === 0
    ? 'I stopped there, so that last step didn’t happen.'
    : `I stopped there, so that step and the ${after === 1 ? 'one' : after} after it didn’t happen.`;

  // Was anything sent from the page the run stopped on? Only steps since the
  // last page change count.
  const phase = buildPhases(steps, fields).find((p) => p.steps.some((s) => s.stepKey === step.stepKey));
  const samePage = new Set(phase?.steps.map((s) => s.stepKey) ?? []);
  const doneKeys = new Set(done.map((r) => r.stepKey));
  const sentHere = steps.filter((s) => samePage.has(s.stepKey) && doneKeys.has(s.stepKey) && submitLike(s));
  if (sentHere.length === 0) {
    second += ' Nothing on this page has been sent.';
  } else {
    const named = sentHere[sentHere.length - 1];
    const did = (words.get(named.stepKey) ?? '').replace(/^Click /, 'clicked ').replace(/^Press /, 'pressed ');
    second += ` Earlier on this page I ${did || 'pressed a button'}, so that part may already have gone through.`;
  }

  const third = fixed === 'optional'
    ? 'You said it doesn’t always appear, so from now on runs skip it when it isn’t there, and still do it when it is.'
    : fixed
    ? 'You’ve shown NodeBrain the new one, so the next run will use it.'
    : live
      ? 'The browser is still open where I stopped.'
      : 'That browser window has closed, so this run can’t carry on. You can still show me the new one: I’ll open the page, and nothing gets filled in or sent. The next run will use it.';
  return `${first} ${second} ${third}`;
}

function stripArticle(what: string): string {
  return what.replace(/^the /, '');
}

// What "Ask the agent" puts in the chat: the same plain account, no
// locators. The chat can't see the browser yet (see RunView).
function askText(
  run: WorkflowRun, name: string, steps: WorkflowStep[], step: WorkflowStep, fields: WorkflowField[],
  runSteps: WorkflowRunStep[], liveValue: string | undefined,
): string {
  const words = sentences(run, steps, fields);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const what = describeStepTarget(step, liveValue ?? valueForLater(run, step, fields), steps, fieldsById);
  const done = runSteps.filter((r) => (r.status === 'ok' || r.status === 'repaired') && r.position < step.position);
  const last = done.length ? words.get(done[done.length - 1].stepKey) : undefined;
  return `My saved workflow "${name}" stopped because the website seems to have changed. `
    + (last ? `It got as far as ${gerund(last)}. ` : '')
    + `The next step was: ${words.get(step.stepKey) ?? 'a click on the page'}, but it couldn't find ${what}. `
    + 'What might that be called or look like now, and where should I look for it on the page?';
}
