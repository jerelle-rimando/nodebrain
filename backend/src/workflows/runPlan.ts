import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type PlanPhase, type PlanSegment, type PlanStep, type RunForm, type RunFormField,
  type WorkflowField, type WorkflowStep,
} from '../../shared-types';
import {
  getWorkflowById, getSiteAgentById, getFieldsByWorkflow, getCurrentSteps, getRunsByWorkflow,
} from '../db/workflowRepository';
import { signInBlocks } from '../replay/replayEngine';

// The run form's view of a workflow: its inputs and its steps in plain
// words, grouped into phases. Everything comes from the saved steps; no
// model is involved.
//
// Phases are presentation only. A new phase starts where the browser moves
// to another page: an "open this address" step, a step after one that
// changed the page, or a step recorded on a different page path. A sign-in
// (the steps the replayer skips together when the profile is still signed
// in) is always a phase of its own. Each phase is named after the heading
// most of its steps sat under, else the page's address.

export function buildRunForm(workflowId: string): RunForm | null {
  const wf = getWorkflowById(workflowId);
  if (!wf || !wf.currentVersionId) return null;
  const site = getSiteAgentById(wf.siteAgentId);
  const fields = getFieldsByWorkflow(workflowId);
  const runs = getRunsByWorkflow(workflowId, 1);
  const last = runs[0];

  const formFields: RunFormField[] = fields.map((f) => ({
    key: f.key, label: f.label, kind: f.kind, secret: f.secret, required: f.required,
    // Secret values are never stored with a run, and the recorded one stays encrypted.
    previousValue: f.secret ? undefined : (last ? last.inputs[f.key] : undefined) ?? f.recordedValue,
  }));

  return {
    workflow: { id: wf.id, name: wf.name, siteName: site?.name ?? '', siteKey: site?.siteKey ?? '' },
    lastRun: last ? { startedAt: last.startedAt, finishedAt: last.finishedAt, status: last.status } : undefined,
    fields: formFields,
    phases: buildPhases(getCurrentSteps(workflowId), fields),
  };
}

export function buildPhases(steps: WorkflowStep[], fields: WorkflowField[]): PlanPhase[] {
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const blocks = signInBlocks(steps);
  const inBlock = (i: number) => blocks.find((b) => i >= b.start && i <= b.end);

  interface Draft { steps: WorkflowStep[]; signIn: boolean; path?: string; url?: string }
  const drafts: Draft[] = [];
  let cur: Draft | undefined;
  steps.forEach((step, i) => {
    const block = inBlock(i);
    const prev = steps[i - 1];
    const path = step.fingerprint.urlPath;
    const pageChanged = !cur
      || step.action === 'navigate'
      || (prev && prev.signals.some((s) => s.name === 'navigation'))
      || (path !== undefined && cur.path !== undefined && path !== cur.path);
    const blockChanged = !!cur && cur.signIn !== !!block;
    // A navigate followed by steps on the page it opened stays one phase.
    const continuesOpen = cur && cur.steps.length === 1 && cur.steps[0].action === 'navigate'
      && step.action !== 'navigate' && !blockChanged && !block;
    if (!continuesOpen && (pageChanged || blockChanged)) {
      cur = { steps: [], signIn: !!block };
      drafts.push(cur);
    }
    cur!.steps.push(step);
    cur!.path ??= path;
    if (step.action === 'navigate') cur!.url ??= String(step.args.url ?? '');
  });

  const phases: PlanPhase[] = [];
  drafts.forEach((d, i) => {
    const title = d.signIn ? 'Sign in' : phaseTitle(d.steps, d.url, i === 0);
    const planned = d.steps.map((s) => planStep(s, steps, fieldsById));
    // Two pages in a row under the same name read as one phase (a recording
    // can mark a page change where there wasn't one).
    const last = phases[phases.length - 1];
    if (last && !d.signIn && last.title === title && !last.note) {
      last.steps.push(...planned);
      return;
    }
    phases.push({ title, note: d.signIn ? "Skipped when you're already signed in" : undefined, steps: planned });
  });
  return phases;
}

// Address parts that say nothing about the page.
const GENERIC_SEGMENTS = /^(index|home|default|main|view|page|start|web|app|index\.\w+)$/i;

function phaseTitle(steps: WorkflowStep[], url: string | undefined, first: boolean): string {
  const counts = new Map<string, number>();
  for (const s of steps) {
    const h = s.fingerprint.heading?.trim();
    if (h && !h.includes(WORKFLOW_VALUE_PLACEHOLDER)) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top) return top.length > 60 ? `${top.slice(0, 57).trimEnd()}…` : top;
  if (url) {
    let host = url;
    try { host = new URL(url).host.replace(/^www\./, ''); } catch { /* keep as is */ }
    return `${first ? 'Open' : 'Go to'} ${host}`;
  }
  const path = steps.find((s) => s.fingerprint.urlPath)?.fingerprint.urlPath;
  const segment = path?.split('/').filter(Boolean).filter((p) => !GENERIC_SEGMENTS.test(p) && !/^\d+$/.test(p)).pop();
  const words = segment?.replace(/\.[a-z]+$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'On the page';
}

const UNNAMED: Record<string, string> = {
  combobox: 'a dropdown', listbox: 'a list', checkbox: 'a checkbox', radio: 'an option', switch: 'a switch',
  spinbutton: 'a number box', searchbox: 'a search box', textbox: 'a text box',
};
const ROLE_WORD: Record<string, string> = {
  button: 'button', link: 'link', checkbox: 'checkbox', tab: 'tab', menuitem: 'menu item',
};
const CHOICE_ROLES = new Set(['option', 'radio', 'menuitemradio']);

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t && !t.includes(WORKFLOW_VALUE_PLACEHOLDER) ? t : undefined;
}

// What the step acts on, in words: "Business name", "a dropdown".
function target(step: WorkflowStep): string {
  const fp = step.fingerprint;
  const name = clean(fp.label) ?? clean(fp.name) ?? clean(fp.placeholder);
  if (name) return `"${name}"`;
  return (fp.role && UNNAMED[fp.role]) ?? 'a box on the page';
}

// Text a click target showed, from a text locator: `internal:text="American"i`.
function shownText(step: WorkflowStep): string | undefined {
  const m = /internal:text="((?:[^"\\]|\\.)*)"/.exec(step.locator ?? '');
  return m ? clean(m[1].replace(/\\(.)/g, '$1')) : undefined;
}

function planStep(step: WorkflowStep, all: WorkflowStep[], fieldsById: Map<string, WorkflowField>): PlanStep {
  const t = (text: string): PlanSegment => ({ text });
  const field = step.valueSource === 'field' && step.fieldId ? fieldsById.get(step.fieldId) : undefined;
  // The value as it appears in the sentence: the run's input, a recorded
  // value, or words for a value that stays hidden.
  const value = (): PlanSegment => {
    if (field) return { field: field.key };
    if (step.valueSource === 'credential') return t(step.credentialPart === 'password' ? 'your saved password' : 'your saved sign-in name');
    if (step.literalSecret) return t('a saved secret value');
    if (step.valueTarget === 'option') {
      const labels = (step.args.optionLabels as string[] | undefined) ?? [];
      return t(`"${labels.length ? labels.join(', ') : (step.literalValue ?? '')}"`);
    }
    return t(`"${step.literalValue ?? ''}"`);
  };
  const fp = step.fingerprint;
  let segments: PlanSegment[];

  switch (step.action) {
    case 'navigate':
      segments = [t(`${step.position === 0 ? 'Open' : 'Go to'} ${shortUrl(String(step.args.url ?? ''))}`)];
      break;
    case 'fill':
      if (step.valueSource === 'literal' && !step.literalSecret && !step.literalValue) {
        segments = [t(`Clear ${target(step)}`)];
      } else {
        segments = [t('Type '), value(), t(` into ${target(step)}`)];
      }
      break;
    case 'select':
      segments = [t('Choose '), value(), t(` in ${target(step)}`)];
      break;
    case 'click':
    case 'check': {
      const isChoice = fp.role !== undefined && CHOICE_ROLES.has(fp.role);
      const list = clean(fp.container);
      if (step.valueTarget === 'locator') {
        segments = [t('Pick '), value(), t(list ? ` from the ${list} list` : '')];
      } else if (isChoice && clean(fp.name)) {
        segments = [t(`Pick "${clean(fp.name)}"${list ? ` from the ${list} list` : ''}`)];
      } else if (step.action === 'check') {
        segments = [t(`Tick ${target(step)}`)];
      } else {
        // An unnamed box that opens a list: name it by the list it opens.
        const next = all.find((s) => s.position === step.position + 1);
        const opens = clean(next?.fingerprint.container);
        const name = clean(fp.name) ?? clean(fp.label);
        const word = fp.role ? ROLE_WORD[fp.role] : undefined;
        if (!name && opens) segments = [t(`Open the ${opens} list`)];
        else if (name) segments = [t(`Click "${name}"${word ? ` ${word}` : ''}`)];
        else if (shownText(step)) segments = [t(`Click "${shownText(step)}"`)];
        else segments = [t('Click on the page')];
      }
      break;
    }
    case 'uncheck':
      segments = [t(`Untick ${target(step)}`)];
      break;
    case 'press': {
      const key = String(step.args.key ?? '');
      segments = [t(`Press ${key === ' ' ? 'Space' : key}`)];
      break;
    }
    case 'hover':
      segments = [t(`Point at ${target(step)}`)];
      break;
    case 'upload':
      segments = [t('Attach a file')];
      break;
    case 'handoff': {
      const reason = typeof step.args.reason === 'string' && step.args.reason.trim() ? step.args.reason.trim() : 'You do this step yourself in the browser';
      segments = [t(reason)];
      break;
    }
    default:
      segments = [t('A step NodeBrain does on the page')];
  }

  const pause = step.action === 'handoff' ? 'handoff' as const : step.requiresConfirmation ? 'confirm' as const : undefined;
  return { stepKey: step.stepKey, segments, pause, ...(step.optional ? { optional: true } : {}) };
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return url || 'the page';
  }
}
