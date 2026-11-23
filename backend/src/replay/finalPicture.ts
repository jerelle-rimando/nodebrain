import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { findBrowser } from '../recorder/browserLauncher';

// A picture of the page as it stood when a run finished, so the person can
// see what the site actually showed (a quote, a confirmation, or an error
// the run should have caught).
//
// A run's window is minimized, and Chrome draws no frames for a minimized
// window, so an ordinary screenshot times out. Measured 2026-11-20 on this
// machine with the run's own launcher (launchBrowser + minimizeWindow):
// page.screenshot timed out at 5 s three times out of three; a device
// metrics override didn't change that. Page.captureSnapshot (MHTML) works
// minimized in ~10 ms. So a minimized page is copied as MHTML and the copy
// is drawn in a separate headless browser with no network (~1 s). The
// window itself is never restored: that takes keyboard focus away from
// whatever the person is doing.
//
// What the copy keeps: the page's markup, styles (including ones added
// through CSSOM, as CSS-in-JS libraries do) and images. What it loses:
// scripts don't run in it, so anything a script draws on a canvas is blank,
// and form controls come out greyed. Typed values aren't part of the markup;
// they're read from the live page (read only) and put into the copy, except
// password boxes, which stay empty. Frames from other sites aren't copied.
//
// The caller decides whether a picture may be taken at all (no secret
// showing), as for the stopped-step picture.

const SHOT_TIMEOUT_MS = 5_000;
const COPY_LOAD_TIMEOUT_MS = 10_000;

type ControlValue = string | boolean | null;

// Page-side: each form control's current value, in document order; null for
// ones that mustn't be copied. A string, not a function: the dev server
// wraps named inner functions in a helper that doesn't exist in the page.
const READ_VALUES = `() => Array.from(document.querySelectorAll('input, textarea, select')).map((el) => {
  const type = String(el.type || '').toLowerCase();
  if (type === 'password' || type === 'file' || type === 'hidden') return null;
  if (type === 'checkbox' || type === 'radio') return !!el.checked;
  return String(el.value ?? '');
})`;
const readValues = new Function(`return ${READ_VALUES}`)() as () => ControlValue[];

const WRITE_VALUES = `(values) => {
  const els = Array.from(document.querySelectorAll('input, textarea, select'));
  if (els.length !== values.length) return; // not the same page shape: leave it as it is
  els.forEach((el, i) => {
    const v = values[i];
    if (v === null) return;
    if (typeof v === 'boolean') el.checked = v; else el.value = v;
  });
}`;
const writeValues = new Function(`return ${WRITE_VALUES}`)() as (values: ControlValue[]) => void;

// Saves the picture to `file` (PNG). True when it was taken. With
// `copyAllowed` false no MHTML copy is ever written: only a real screenshot,
// when the window is showing, can be taken.
// `failures`, when given, gets one entry per attempt that failed (which
// attempt, and the error as thrown), for the caller's log. They're raw: a
// Playwright message can carry the page's address or markup, so the caller
// redacts them and decides whether they may be logged at all.
export async function takeFinalPicture(
  page: Page, context: BrowserContext, file: string, windowShown: boolean, copyAllowed: boolean,
  failures?: string[],
): Promise<boolean> {
  if (page.isClosed()) return false;
  // The person has the window up: a real picture. If it was minimized again
  // since, the screenshot times out and the copy is made instead.
  if (windowShown) {
    const ok = await page.screenshot({ path: file, timeout: SHOT_TIMEOUT_MS })
      .then(() => true, (err: unknown) => { failures?.push(`screenshot: ${errorText(err)}`); return false; });
    if (ok) return true;
  }
  if (!copyAllowed) return false;
  return pictureFromCopy(page, context, file, failures);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Deletes page copies left in run folders (<runsDir>/<run id>/*.mhtml) by a
// shutdown during the second one exists. Called at startup, before any run
// can start. Returns how many were removed.
export function removeLeftoverCopies(runsDir: string): number {
  let removed = 0;
  let runs: fs.Dirent[];
  try {
    runs = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return 0; // no runs folder yet
  }
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const dir = path.join(runsDir, run.name);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.mhtml')) continue;
      try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch { /* tried again next start */ }
    }
  }
  return removed;
}

async function pictureFromCopy(page: Page, context: BrowserContext, file: string, failures?: string[]): Promise<boolean> {
  const mhtmlFile = `${file}.mhtml`;
  let copyBrowser: Browser | undefined;
  try {
    const size = await page.evaluate('({ w: window.innerWidth, h: window.innerHeight })').catch(() => null) as { w: number; h: number } | null;
    const values = await page.evaluate(readValues).catch(() => [] as ControlValue[]);
    const session = await context.newCDPSession(page);
    const { data } = await session.send('Page.captureSnapshot', { format: 'mhtml' });
    await session.detach().catch(() => {});
    fs.writeFileSync(mhtmlFile, data, 'utf8');

    copyBrowser = await chromium.launch({ executablePath: findBrowser().exe, headless: true, timeout: COPY_LOAD_TIMEOUT_MS });
    const copy = await copyBrowser.newPage({
      viewport: { width: Math.max(320, Math.min(size?.w || 1280, 2560)), height: Math.max(240, Math.min(size?.h || 800, 1600)) },
    });
    // Everything the copy needs is inside the file. Nothing goes out to the
    // site again from here (no cookies, no requests).
    await copy.route('**/*', (r) => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
    await copy.goto(pathToFileURL(mhtmlFile).href, { timeout: COPY_LOAD_TIMEOUT_MS });
    if (values.length) await copy.evaluate(writeValues, values).catch(() => {});
    await copy.screenshot({ path: file, timeout: SHOT_TIMEOUT_MS });
    return true;
  } catch (err) {
    failures?.push(`page copy: ${errorText(err)}`);
    return false;
  } finally {
    await copyBrowser?.close().catch(() => {});
    // The copy holds the whole page; only the picture is kept.
    try { fs.rmSync(mhtmlFile, { force: true }); } catch { /* already gone */ }
  }
}
