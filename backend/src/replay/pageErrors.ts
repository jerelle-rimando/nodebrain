import type { Page } from 'playwright-core';

// Error messages a page is showing about its form: "A valid class code is
// required", "Enter a valid payroll amount". A message that appears after a
// step is the page saying the step didn't take, even though the click or the
// typing itself worked; the run stops there instead of reporting success.
//
// Measured on quote.pieinsurance.com (2026-11-15 recording): after a wrong
// class-code pick the box had aria-invalid=true and the text "A valid class
// code is required" showed under it. Next did nothing visible and the run
// had carried on to "completed".
//
// Three kinds of signal, all only when visible:
//   1. a field marked aria-invalid=true, with the text its aria-errormessage
//      or aria-describedby points at (only the parts that read as an error:
//      a describedby hint like "You can search by keyword" isn't one);
//   2. role=alert or aria-live=assertive text that reads as an error (a
//      "Saved" toast in an alert isn't);
//   3. short text in an element whose class or id says error/invalid/danger
//      (no inputs inside it: a "has-error" wrapper around a field is not the
//      message itself).
// Messages inside shadow roots and native browser validation bubbles aren't
// seen.
//
// A string, not a function: the dev server (tsx/esbuild) wraps named inner
// functions in a __name() helper that doesn't exist in the page.
const PAGE_ERRORS_FN = `() => {
  const WORDS = /required|invalid|not valid|valid\\b|must\\b|please (enter|select|choose|provide|fill|check|correct)|can(no|')t be|too (short|long|low|high|many|few)|incorrect|does(n't| not) match|not allowed|not accepted|at least|at most|error|wrong|missing|unavailable/i;
  const ERRORISH = /(^|[^a-z])(error|errors|invalid|danger|err)([^a-z]|$)/i;
  const out = [];
  const seen = new Set();
  const visible = (n) => {
    if (!n || !n.getClientRects || !n.getClientRects().length) return false;
    const s = getComputedStyle(n);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const textOf = (n) => String(n.innerText || n.textContent || '').replace(/\\s+/g, ' ').trim();
  const classy = (n) => ERRORISH.test(String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className || '')) || ERRORISH.test(n.id || '');
  const labelOf = (f) => {
    const al = f.getAttribute('aria-label');
    if (al) return al.trim();
    if (f.labels && f.labels[0]) return textOf(f.labels[0]);
    return (f.getAttribute('placeholder') || f.getAttribute('name') || '').trim();
  };
  const add = (text, field) => {
    const key = text + '|' + (text ? '' : field);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text, field });
  };
  for (const f of document.querySelectorAll('[aria-invalid="true"]')) {
    if (!visible(f)) continue;
    let said = false;
    const strong = (f.getAttribute('aria-errormessage') || '').split(/\\s+/).filter(Boolean);
    const weak = (f.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
    for (const id of [...strong, ...weak]) {
      const m = document.getElementById(id);
      if (!m || !visible(m)) continue;
      const t = textOf(m);
      if (!t || t.length > 200) continue;
      if (strong.includes(id) || classy(m) || WORDS.test(t)) { add(t, labelOf(f)); said = true; }
    }
    if (!said) add('', labelOf(f) || 'a field');
  }
  for (const n of document.querySelectorAll('[role=alert], [aria-live=assertive]')) {
    if (!visible(n)) continue;
    const t = textOf(n);
    if (t && t.length <= 200 && WORDS.test(t)) add(t, '');
  }
  for (const n of document.querySelectorAll('[class*=error i], [class*=invalid i], [class*=danger i], [id*=error i]')) {
    if (!classy(n) || !visible(n)) continue;
    if (n.matches('input, textarea, select, button, a, label, form') || n.querySelector('input, textarea, select, button, form')) continue;
    const t = textOf(n);
    if (t && t.length <= 200) add(t, '');
  }
  return out.slice(0, 20);
}`;

export interface PageError { text: string; field: string }

const readErrors = new Function(`return ${PAGE_ERRORS_FN}`)() as () => PageError[];

// The error messages showing now; empty when the page can't be read (it's
// navigating, or gone).
export async function readPageErrors(page: Page): Promise<PageError[]> {
  if (page.isClosed()) return [];
  return page.evaluate(readErrors).catch(() => []);
}

const keyOf = (e: PageError) => `${e.text}|${e.text ? '' : e.field}`;

export function newErrors(before: PageError[], now: PageError[]): PageError[] {
  const had = new Set(before.map(keyOf));
  return now.filter((e) => !had.has(keyOf(e)));
}

// New messages that stay. Some pages flash an error mid-step and clear it a
// moment later: Pie's class-code box goes invalid on the mouse-down that
// starts an option click (the box loses focus before the pick lands), and is
// valid again once the click has picked. So a new message counts only if it
// is still there after STAY_MS.
export const STAY_MS = 1_500;

export async function lastingNewErrors(page: Page, before: PageError[], signal?: AbortSignal): Promise<PageError[]> {
  let fresh = newErrors(before, await readPageErrors(page));
  const deadline = Date.now() + STAY_MS;
  while (fresh.length && Date.now() < deadline && !signal?.aborted) {
    await new Promise((r) => setTimeout(r, 250));
    fresh = newErrors(before, await readPageErrors(page));
  }
  return fresh;
}

// "showed “A valid class code is required”", "marked the “Class Code” box as not valid".
export function describeErrors(errors: PageError[]): string {
  const texts = [...new Set(errors.filter((e) => e.text).map((e) => e.text))];
  if (texts.length) {
    const shown = texts.slice(0, 2).map((t) => `"${t}"`).join(' and ');
    return `showed ${shown}${texts.length > 2 ? ' and more' : ''}`;
  }
  const fields = [...new Set(errors.map((e) => e.field).filter(Boolean))];
  return fields.length ? `marked ${fields.slice(0, 2).map((f) => `"${f}"`).join(' and ')} as not valid` : 'marked a field as not valid';
}
