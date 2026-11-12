import {
  deriveAgentEmoji,
  type SiteSummary, type WorkflowRow, type WorkflowRun, type WorkflowsOverview, type WorkflowStep,
} from '../../shared-types';
import {
  getAllSiteAgents, getAllWorkflows, getRunsByWorkflow, getRunSteps, getStepsByVersion, getFieldsByWorkflow,
} from '../db/workflowRepository';
import { isRunActive, getRepairHold, describeStepTarget, isMissError } from '../replay/replayEngine';
import { repairStatus } from '../replay/repair';
import { listTakeControlRequests } from '../browser/takeControl';
import { siteIconUrl } from '../recorder/siteLook';

// The Workflows list and its site picker, in plain words. Everything here is
// read from what's stored and what's running; no model is involved, and the
// replay engine, repair flow and Take Control are only asked, never changed.

export function buildOverview(now = new Date()): WorkflowsOverview {
  const paused = new Map(listTakeControlRequests().filter((r) => r.runId).map((r) => [r.runId!, r]));
  const sites = getAllSiteAgents();
  const siteNames = new Map(sites.map((s) => [s.id, s.name]));

  const workflows: WorkflowRow[] = [];
  const lastActivity = new Map<string, string>();
  for (const wf of getAllWorkflows()) {
    if (!wf.currentVersionId) continue;
    const runs = getRunsByWorkflow(wf.id, 200);
    const last = runs[0];
    const touched = last && last.startedAt > wf.updatedAt ? last.startedAt : wf.updatedAt;
    if (touched > (lastActivity.get(wf.siteAgentId) ?? '')) lastActivity.set(wf.siteAgentId, touched);
    workflows.push({
      id: wf.id,
      siteAgentId: wf.siteAgentId,
      name: withoutSiteName(wf.name, siteNames.get(wf.siteAgentId)),
      ...rowState(last, runs, paused.has(last?.id ?? '') ? paused.get(last!.id)!.reason : undefined, now),
    });
  }

  const order = { paused: 0, stopped: 1, running: 2, idle: 3 } as const;
  workflows.sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));

  const summaries: SiteSummary[] = sites.map((s) => {
    const mine = workflows.filter((w) => w.siteAgentId === s.id);
    const waiting = mine.find((w) => w.state === 'paused');
    const stopped = mine.filter((w) => w.state === 'stopped').length;
    return {
      id: s.id,
      siteKey: s.siteKey,
      name: s.name,
      icon: s.emoji ?? deriveAgentEmoji(s.name),
      favicon: siteIconUrl(s.siteKey),
      startUrl: s.startUrl,
      workflowCount: mine.length,
      attention: waiting ? waiting.stateText
        : stopped === 1 ? 'A workflow stopped and needs fixing'
        : stopped > 1 ? `${stopped} workflows stopped and need fixing` : undefined,
      lastActivity: lastActivity.get(s.id),
    };
  });
  return { sites: summaries, workflows };
}

type RowState = Pick<WorkflowRow, 'state' | 'stateText' | 'runId'>;

function rowState(last: WorkflowRun | undefined, runs: WorkflowRun[], pauseReason: string | undefined, now: Date): RowState {
  if (last && isRunActive(last.id)) {
    const steps = getStepsByVersion(last.versionId);
    const rows = getRunSteps(last.id);
    if (getRepairHold(last.id)) return { state: 'stopped', stateText: stoppedText(last, steps), runId: last.id };
    if (pauseReason !== undefined) return { state: 'paused', stateText: pausedText(steps, rows.map((r) => r.stepKey), pauseReason), runId: last.id };
    const done = new Set(rows.filter((r) => r.status !== 'failed').map((r) => r.stepKey)).size;
    const step = Math.min(done + 1, Math.max(steps.length, 1));
    return { state: 'running', stateText: `Running now, step ${step} of ${steps.length}`, runId: last.id };
  }
  if (last?.status === 'needs_attention' && repairStatus(last.id)?.canFix) {
    return { state: 'stopped', stateText: stoppedText(last, getStepsByVersion(last.versionId)), runId: last.id };
  }
  // A last run that didn't finish keeps its id, so the row can open it and
  // show why it stopped. Not once it's been fixed: that reason is old news.
  const unfinished = last && (last.status === 'failed' || (last.status === 'needs_attention' && !repairStatus(last.id)?.fixed));
  return { state: 'idle', stateText: idleText(last, runs, now), runId: unfinished ? last.id : undefined };
}

// "Needs you: type the code from your email". A handoff step says in its own
// words what the person does; a check before a step doesn't.
function pausedText(steps: WorkflowStep[], seen: string[], reason: string): string {
  const doneKeys = new Set(seen);
  const next = steps.find((s) => !doneKeys.has(s.stepKey));
  if (next?.action === 'handoff') {
    const words = reason.trim().replace(/\.$/, '');
    const short = words.length > 70 ? `${words.slice(0, 67).trimEnd()}…` : words;
    return `Needs you: ${short.charAt(0).toLowerCase()}${short.slice(1)}`;
  }
  return 'Needs you to check the page before it carries on';
}

// "Stopped because the "Submit renewal" button moved".
function stoppedText(run: WorkflowRun, steps: WorkflowStep[]): string {
  const step = steps.find((s) => s.stepKey === run.failedStepKey);
  if (!step || !isMissError(run.error)) return 'Stopped because something on the page moved';
  const fields = new Map(getFieldsByWorkflow(run.workflowId).map((f) => [f.id, f]));
  const what = describeStepTarget(step, undefined, steps, fields);
  return run.error?.startsWith('More than one')
    ? `Stopped because it found more than one ${what.replace(/^the /, '')}`
    : `Stopped because ${what} moved`;
}

function idleText(last: WorkflowRun | undefined, runs: WorkflowRun[], now: Date): string {
  if (!last) return "Hasn't run yet";
  if (last.status === 'needs_attention') {
    // Fixed since (the Fix button is gone), or it stopped for another reason.
    return repairStatus(last.id)?.fixed ? 'Fixed — ready to run' : "Didn't finish last time";
  }
  if (last.status === 'failed') return "Didn't finish last time";
  if (last.status === 'cancelled') return 'You stopped it last time';
  const today = runs.filter((r) => sameDay(new Date(r.startedAt), now)).length;
  if (today === 1) return 'Ran once today';
  if (today > 1) return `Ran ${today} times today`;
  const days = Math.round((startOfDay(now) - startOfDay(new Date(last.startedAt))) / 86_400_000);
  return days === 1 ? 'Last ran yesterday' : `Last ran ${days} days ago`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function sameDay(a: Date, b: Date): boolean {
  return startOfDay(a) === startOfDay(b);
}

// "Jimcor - Renew policy" under the Jimcor header reads "Renew policy".
// Only a whole leading or trailing site name goes; the rest is kept.
export function withoutSiteName(name: string, siteName: string | undefined): string {
  if (!siteName) return name;
  const site = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sep = '[\\s\\-–—:|·•/]+';
  const stripped = name
    .replace(new RegExp(`^${site}${sep}`, 'i'), '')
    .replace(new RegExp(`${sep}${site}$`, 'i'), '')
    .trim();
  return stripped || name;
}
