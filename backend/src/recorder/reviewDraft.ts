import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type RecordedValue, type RecordedValueKind, type WorkflowStepAction, type WorkflowStepFingerprint,
} from '../../shared-types';
import { topHeading } from './ariaSnapshot';

// Pure helpers for the review screen: which recorded steps carry a value the
// person chose, what each defaults to, and a name guess. No model involved:
// everything comes from what the page itself said.

export interface DraftStep {
  stepKey: string;
  action: WorkflowStepAction;
  locator?: string;
  fingerprint: WorkflowStepFingerprint;
  value?: string;
  usesSavedLogin?: 'username' | 'password';
  opening?: boolean;
  pageAlias: string;
  pageTitle?: string;
  snapshot?: string;
}

// Clicking one of these picks a value ("Texas" in a list, "LLC" among
// radio buttons). Menu items and tabs are left out: they usually do
// something rather than choose something.
const CHOICE_ROLES = new Set(['option', 'radio', 'menuitemradio']);

const UNNAMED: Record<string, string> = {
  combobox: 'A dropdown', listbox: 'A list', checkbox: 'A checkbox', radio: 'A choice', spinbutton: 'A number field',
  searchbox: 'A search box', textbox: 'A text field',
};

export function valueKindOf(step: DraftStep): RecordedValueKind | null {
  if (step.usesSavedLogin) return null; // sign-in steps live in the Vault, not on this list
  if (step.action === 'fill') return 'text';
  if (step.action === 'select') return step.value ? 'option' : null;
  if ((step.action === 'click' || step.action === 'check')
      && step.fingerprint.role && CHOICE_ROLES.has(step.fingerprint.role) && step.fingerprint.name?.trim()) {
    return 'option-click';
  }
  return null;
}

function fieldName(fp: WorkflowStepFingerprint): string | undefined {
  return fp.label || fp.name || fp.placeholder || undefined;
}

// The label shown under a value: the field's own label for typed text and
// dropdowns. A clicked option's own name is the value, so its label comes
// from the list or group it sits in, else the control clicked just before
// it on the same page (the one that opened the list), else the radio
// group's name attribute, else the section heading.
export function labelFor(steps: DraftStep[], index: number): string {
  const step = steps[index];
  const fp = step.fingerprint;
  if (step.action !== 'click' && step.action !== 'check') {
    return fieldName(fp) ?? (fp.role && UNNAMED[fp.role]) ?? 'A field';
  }
  if (fp.container) return fp.container;
  for (let i = index - 1; i >= Math.max(0, index - 3); i--) {
    const prev = steps[i];
    if (prev.pageAlias !== step.pageAlias || prev.action === 'navigate') break;
    const role = prev.fingerprint.role;
    // Only the opener's label or placeholder: its accessible name is often
    // the value it currently shows ("Alaska"), not what the field is.
    const openerLabel = prev.fingerprint.label || prev.fingerprint.placeholder;
    if ((role === 'combobox' || role === 'button' || role === 'textbox' || role === 'searchbox') && openerLabel) {
      return openerLabel;
    }
  }
  // Radio buttons in a group share a name attribute ("color" → "Color").
  if (fp.role === 'radio' && fp.nameAttr && /[a-z]/i.test(fp.nameAttr)) {
    const words = fp.nameAttr.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_[\].]+/g, ' ').trim().toLowerCase();
    if (words) return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return fp.heading || 'A choice from a list';
}

// Playwright quotes names as "..." with \ and " escaped, followed by i
// (ignore case) or s (exact).
function quoted(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Turns `internal:role=option[name="Texas"i]` into a template with the
// value slot. Null when the name doesn't appear exactly once in the
// locator (e.g. the recorder chose a test id or CSS instead), because then
// a different value can't be substituted.
export function templateLocator(locator: string | undefined, name: string): string | null {
  if (!locator) return null;
  for (const candidate of [name, name.trim()]) {
    const needle = `[name=${quoted(candidate)}`;
    const first = locator.indexOf(needle);
    if (first >= 0 && locator.indexOf(needle, first + 1) < 0) {
      return locator.slice(0, first) + `[name="${WORKFLOW_VALUE_PLACEHOLDER}"` + locator.slice(first + needle.length);
    }
  }
  return null;
}

// The option's text is in its name and often also its label (a radio's
// <label>). Every occurrence becomes the value slot, so the recorded value
// isn't kept anywhere in the step.
export function templateFingerprint(fp: WorkflowStepFingerprint, value: string): WorkflowStepFingerprint {
  const out: WorkflowStepFingerprint = { ...fp };
  for (const k of Object.keys(out) as (keyof WorkflowStepFingerprint)[]) {
    const v = out[k];
    if (typeof v === 'string' && value && v.includes(value)) {
      (out as Record<string, unknown>)[k] = v.split(value).join(WORKFLOW_VALUE_PLACEHOLDER);
    }
  }
  return out;
}

export function valueRows(steps: DraftStep[]): RecordedValue[] {
  const rows: RecordedValue[] = [];
  steps.forEach((step, i) => {
    const kind = valueKindOf(step);
    if (!kind) return;
    const value = kind === 'option-click' ? step.fingerprint.name!.trim() : (step.value ?? '');
    rows.push({
      stepKey: step.stepKey,
      kind,
      value,
      label: labelFor(steps, i),
      defaultMode: kind === 'text' ? 'changes' : 'fixed',
      canChange: kind !== 'option-click' || templateLocator(step.locator, step.fingerprint.name!) !== null,
    });
  });
  return rows;
}

// "Add Employee - OrangeHRM" → "Add Employee". Drops the parts of a title
// that are just the site's name.
export function cleanTitle(title: string | undefined, siteName: string, siteKey: string): string | undefined {
  if (!title) return undefined;
  const site = siteName.toLowerCase();
  const domainWord = siteKey.split('.')[0].toLowerCase();
  const parts = title.split(/\s+[|\-–—·:»]{1,2}\s+/).map((p) => p.trim()).filter(Boolean);
  const kept = parts.filter((p) => {
    const l = p.toLowerCase();
    return !l.includes(site) && !l.replace(/\s+/g, '').includes(domainWord) && !l.includes(siteKey);
  });
  return kept[0];
}

function usable(name: string | undefined, siteName: string): string | undefined {
  const n = name?.replace(/\s+/g, ' ').trim();
  if (!n || n.length < 3 || n.toLowerCase() === siteName.toLowerCase()) return undefined;
  if (n.length <= 60) return n;
  const cut = n.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60).trim();
}

// The page the task is about is where the first value was entered (a form),
// or, with no values, where the last action happened. Its main heading is
// the guess, then its title, then the first page's. The caller supplies the
// dated fallback.
export function guessName(steps: DraftStep[], siteName: string, siteKey: string, fallback: string): string {
  const elementSteps = steps.filter((s) => s.action !== 'navigate');
  const anchor = steps.find((s) => valueKindOf(s)) ?? elementSteps[elementSteps.length - 1];
  const first = steps.find((s) => s.snapshot || s.pageTitle);
  const candidates = [
    topHeading(anchor?.snapshot),
    cleanTitle(anchor?.pageTitle, siteName, siteKey),
    topHeading(first?.snapshot),
    cleanTitle(first?.pageTitle, siteName, siteKey),
  ];
  for (const c of candidates) {
    const n = usable(c, siteName);
    if (n) return n;
  }
  return fallback;
}

// A field's input key: "Insured name" → "insured_name", unique per workflow.
export function fieldKeyFor(label: string, used: Set<string>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'value';
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  used.add(key);
  return key;
}
