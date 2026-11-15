import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type MaybeOptionalStep, type RecordedValue, type RecordedValueKind, type WorkflowStepAction, type WorkflowStepFingerprint,
} from '../../shared-types';

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
  // A click's element text as the page gave it, in full (the locator's name
  // can be cut short: Playwright stopped Pie's option name at "&").
  optionText?: string;
  // A button answering a question: the question and every button's name.
  choiceGroup?: { question: string; options: string[] };
  // The click was inside a pop-up or banner (pageScript.ts layerOf).
  layer?: { unasked: boolean; consent: boolean; vendor: boolean; promo: boolean; dismissWord: boolean; gone: boolean };
  navigates?: boolean; // the click opened another page or a pop-up window
  description?: string; // 'Clicked "Close Layer"'
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
  // A button answering a question (Yes / No).
  if (step.action === 'click' && step.choiceGroup && step.fingerprint.name?.trim() && !step.navigates) return 'option-click';
  return null;
}

function fieldName(fp: WorkflowStepFingerprint): string | undefined {
  return fp.label || fp.name || fp.placeholder || undefined;
}

// Labels that only restate what kind of control it is ("Input: Text",
// "Text field", "Number") say nothing about what goes in it.
const CONTROL_WORDS = new Set([
  'input', 'field', 'textbox', 'textfield', 'textarea', 'box', 'entry', 'control', 'enter', 'type', 'here', 'your', 'a', 'the',
  'value', 'text', 'string', 'number', 'numeric', 'date', 'time', 'datetime', 'local', 'select', 'dropdown',
]);

export function isUselessLabel(label: string | undefined): boolean {
  const words = label?.toLowerCase().split(/[^a-z]+/).filter(Boolean) ?? [];
  return words.length > 0 && words.every((w) => CONTROL_WORDS.has(w));
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

// Where the field sits and what it takes: "2nd box · text".
function positionLabel(fp: WorkflowStepFingerprint): string | undefined {
  if (!fp.fieldIndex || fp.fieldIndex < 1) return undefined;
  if (fp.tag === 'select') return `${ordinal(fp.fieldIndex)} dropdown`;
  const kind = fp.tag === 'textarea' ? 'text' : (fp.inputType || 'text').replace('datetime-local', 'date and time');
  return `${ordinal(fp.fieldIndex)} box · ${kind}`;
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
    const own = fieldName(fp);
    if (own && !isUselessLabel(own)) return own;
    return positionLabel(fp) ?? own ?? (fp.role && UNNAMED[fp.role]) ?? 'A field';
  }
  if (step.choiceGroup) return step.choiceGroup.question;
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

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// A click on a choice in a list (a typeahead's suggestion).
export function clicksOption(step: DraftStep): boolean {
  return step.action === 'click'
    && (step.fingerprint.role === 'option' || /(^|>> )internal:role=option\[/.test(step.locator ?? ''));
}

// The choice a click picked, in full: the page's own text for it, else its
// accessible name.
export function choiceText(step: DraftStep): string | undefined {
  const t = (step.optionText ?? step.fingerprint.name)?.replace(/\s+/g, ' ').trim();
  return t || undefined;
}

// Typing into a box, then clicking one of the choices it offered, is one
// thing the person did: picking a choice. They belong together when
//   - the click is on an option, on the same page, after the typing;
//   - nothing came between them but clicks or keys in that same box
//     (refocusing it, arrow keys);
//   - the option's text contains what was typed ("roofing" is in "Roofing -
//     All Kinds - & Drivers"). That is what shows the click landed in the
//     list the typing filtered; a list matched on synonyms or codes isn't
//     paired, and stays two rows.
// Returns the typing step's index → the click's index.
export function typeaheadPairs(steps: DraftStep[]): Map<number, number> {
  const pairs = new Map<number, number>();
  steps.forEach((step, i) => {
    if (step.action !== 'fill' || step.usesSavedLogin || !step.locator || !step.value?.trim()) return;
    for (let j = i + 1; j < steps.length; j++) {
      const next = steps[j];
      if (next.pageAlias !== step.pageAlias) return;
      if (clicksOption(next)) {
        const text = choiceText(next);
        if (text && norm(text).includes(norm(step.value))) pairs.set(i, j);
        return;
      }
      if ((next.action === 'click' || next.action === 'press') && next.locator === step.locator) continue;
      return;
    }
  });
  return pairs;
}

export function valueRows(steps: DraftStep[]): RecordedValue[] {
  const rows: RecordedValue[] = [];
  const pairs = typeaheadPairs(steps);
  const picks = new Set(pairs.values());
  steps.forEach((step, i) => {
    if (picks.has(i)) return; // shown with its typing
    const pick = pairs.get(i);
    if (pick !== undefined) {
      rows.push({
        stepKey: step.stepKey, pickStepKey: steps[pick].stepKey, kind: 'typeahead',
        value: choiceText(steps[pick])!, label: labelFor(steps, i), defaultMode: 'changes', canChange: true,
      });
      return;
    }
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
      ...(step.choiceGroup ? { choices: step.choiceGroup.options } : {}),
    });
  });
  return rows;
}

function usable(name: string | undefined, siteName: string): string | undefined {
  const n = name?.replace(/\s+/g, ' ').trim();
  if (!n || n.length < 3 || n.toLowerCase() === siteName.toLowerCase()) return undefined;
  if (n.length <= 60) return n;
  const cut = n.slice(0, 60);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 60).trim();
}

// Button and link names that move through a flow or dismiss something
// rather than say what the task is.
const GENERIC_ACTIONS = new Set([
  'next', 'continue', 'back', 'previous', 'ok', 'okay', 'close', 'cancel', 'skip', 'yes', 'no', 'done',
  'accept', 'accept all', 'accept all cookies', 'accept cookies', 'allow all', 'reject all', 'got it', 'dismiss',
  'save and continue', 'continue to next step', 'go', 'menu', 'search', 'submit', 'sign in', 'log in', 'login',
]);

function actionName(step: DraftStep): string | undefined {
  if (step.action !== 'click' || step.usesSavedLogin) return undefined;
  const { role, name } = step.fingerprint;
  if (role !== 'button' && role !== 'link') return undefined;
  const n = name?.replace(/\s+/g, ' ').trim();
  if (!n || n.length < 3 || n.length > 40 || !/[a-z]/i.test(n)) return undefined;
  if (GENERIC_ACTIONS.has(n.toLowerCase().replace(/[^a-z ]/g, '').trim())) return undefined;
  return n;
}

// "<Site> — <action>". The action is the first button or link the person
// clicked whose name says what they set out to do ("Get a quote"), skipping
// flow and dismiss buttons (Next, Continue, Accept cookies…). With no such
// click, "Fill in form" when values were entered. Page headings and titles
// are not used: on marketing sites they are slogans. The caller supplies
// the dated fallback.
export function guessName(steps: DraftStep[], siteName: string, _siteKey: string, fallback: string): string {
  const site = siteName.replace(/\s+/g, ' ').trim();
  let action: string | undefined;
  for (const s of steps) {
    action = actionName(s);
    if (action) break;
  }
  if (!action && steps.some((s) => valueKindOf(s))) action = 'Fill in form';
  if (!action) return fallback;
  return usable(site ? `${site} — ${action}` : action, siteName) ?? fallback;
}

// A field's input key: "Insured name" → "insured_name", unique per workflow.
export function fieldKeyFor(label: string, used: Set<string>): string {
  const base = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'value';
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  used.add(key);
  return key;
}

// Clicks that put away a pop-up or banner which showed up on its own. Such
// a layer is often gone on the next run (the browser profile remembers the
// cookie choice), and the step then fails. All four must hold:
//   1. the click was inside a dialog, or a box fixed or stuck to the screen;
//   2. nobody asked for it: it appeared with no click or key press of the
//      person's just before (a confirm dialog after "Delete" is asked for);
//   3. the click put it away, and the page stayed where it was;
//   4. something says what it is: cookie / consent / privacy wording or a
//      known consent tool (pre-marked); a promotion or announcement, or a
//      button worded as a dismissal (listed, not pre-marked).
// Never a step that types or chooses a value, or one that opened a page.
export function maybeOptional(steps: DraftStep[]): MaybeOptionalStep[] {
  const out: MaybeOptionalStep[] = [];
  for (const step of steps) {
    const l = step.layer;
    if (step.action !== 'click' || !l || step.navigates || step.usesSavedLogin || step.value !== undefined) continue;
    if (valueKindOf(step)) continue;
    if (!l.unasked || !l.gone) continue;
    const consent = l.consent || l.vendor;
    if (!consent && !l.promo && !l.dismissWord) continue;
    out.push({
      stepKey: step.stepKey,
      description: step.description ?? 'A click',
      reason: consent ? 'looks like a cookie or privacy banner'
        : l.promo ? 'looks like a pop-up offer or announcement'
          : 'closed a pop-up that appeared on its own',
      preMarked: consent,
    });
  }
  return out;
}
