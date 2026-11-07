import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

// Opens the user's installed browser (Chrome, else Edge) as an ordinary
// window with a NodeBrain profile for one site, and attaches to it over the
// DevTools protocol so the recorder can watch.
//
// The profile is NodeBrain's own folder, not the person's everyday one, so
// their usual saved sign-ins aren't in it (Chrome also refuses a debugging
// port on its default profile).
//
// Why not chromium.launchPersistentContext: that adds --enable-automation and
// pipe control, which shows the "controlled by automated test software" bar
// and changes browser behaviour (extensions off, etc.). This launches the
// browser the way a shortcut would, plus a localhost-only debugging port.
//
// Measured on Edge 2026-11: the debugging port alone makes
// navigator.webdriver true, before Playwright attaches and after it detaches.
// So sites can see this window is automatable. Nothing here hides that.
//
// The port is bound to 127.0.0.1 but any local process can use it while the
// window is open; the session closes the browser on Done and on discard.

export interface LaunchedBrowser {
  browser: Browser;
  context: BrowserContext;
  process: ChildProcess | null; // null when we attached to a window already open
}

type BrowserKind = 'chrome' | 'edge';

// Chrome first: it's where most people browse. Edge is the fallback (it ships
// with Windows).
const LOCAL = process.env.LOCALAPPDATA;
const CANDIDATES: Array<{ kind: BrowserKind; exe: string }> = [
  { kind: 'chrome' as const, exe: 'C:/Program Files/Google/Chrome/Application/chrome.exe' },
  { kind: 'chrome' as const, exe: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' },
  { kind: 'chrome' as const, exe: LOCAL ? path.join(LOCAL, 'Google/Chrome/Application/chrome.exe') : '' },
  { kind: 'edge' as const, exe: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' },
  { kind: 'edge' as const, exe: 'C:/Program Files/Microsoft/Edge/Application/msedge.exe' },
  { kind: 'edge' as const, exe: LOCAL ? path.join(LOCAL, 'Microsoft/Edge/Application/msedge.exe') : '' },
].filter((c) => !!c.exe);

export class BrowserNotFoundError extends Error {
  constructor() {
    super("Recording needs Google Chrome or Microsoft Edge, and neither was found on this computer.");
  }
}

// A site's profile folder stays with the browser that made it. Its sign-ins
// (cookies, saved passwords) are encrypted by that browser and the other one
// can't read them, so switching would sign the person out of the site.
// NodeBrain writes MARKER on launch. Folders made before it existed are
// identified by Chromium's own "Last Browser" file (UTF-16 exe path).
const MARKER = 'NodeBrain Browser';

function profileBrowser(profileDir: string): BrowserKind | null {
  try {
    const kind = fs.readFileSync(path.join(profileDir, MARKER), 'utf8').trim();
    if (kind === 'chrome' || kind === 'edge') return kind;
  } catch { /* no marker */ }
  try {
    const last = fs.readFileSync(path.join(profileDir, 'Last Browser')).toString('utf16le').toLowerCase();
    if (last.includes('msedge.exe')) return 'edge';
    if (last.includes('chrome.exe')) return 'chrome';
  } catch { /* new folder */ }
  return null;
}

export function findBrowser(profileDir?: string): { kind: BrowserKind; exe: string } {
  const override = process.env.NODEBRAIN_BROWSER_PATH;
  if (override && fs.existsSync(override)) {
    return { kind: /msedge\.exe$/i.test(override) ? 'edge' : 'chrome', exe: override };
  }
  const installed = CANDIDATES.filter((c) => fs.existsSync(c.exe));
  const pinned = profileDir ? profileBrowser(profileDir) : null;
  // If the browser that made the profile is gone, the other one opens it and
  // the site asks for a sign-in again.
  const found = installed.find((c) => c.kind === pinned) ?? installed[0];
  if (!found) throw new BrowserNotFoundError();
  return found;
}

function readPort(profileDir: string): string | null {
  try {
    const port = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    return /^\d+$/.test(port) ? port : null;
  } catch {
    return null;
  }
}

async function connect(port: string): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => {});
    throw new Error('The browser opened without a window to record in.');
  }
  return { browser, context };
}

export async function launchBrowser(profileDir: string, startUrl: string): Promise<LaunchedBrowser> {
  fs.mkdirSync(profileDir, { recursive: true });

  // A window for this profile may still be open (an earlier recording, or a
  // crash). A second launch on the same profile would just hand the URL to
  // that window and exit, so attach to it instead.
  const existingPort = readPort(profileDir);
  if (existingPort) {
    try {
      const attached = await connect(existingPort);
      const page = attached.context.pages()[0] ?? (await attached.context.newPage());
      await page.bringToFront().catch(() => {});
      return { ...attached, process: null };
    } catch {
      // Stale file from a closed browser.
      try { fs.unlinkSync(path.join(profileDir, 'DevToolsActivePort')); } catch { /* gone */ }
    }
  }

  const { kind, exe } = findBrowser(profileDir);
  try { fs.writeFileSync(path.join(profileDir, MARKER), kind); } catch { /* next launch falls back to Last Browser */ }
  const child = spawn(exe, [
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let exited = false;
  child.once('exit', () => { exited = true; });

  let port: string | null = null;
  for (let i = 0; i < 200 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    port = readPort(profileDir);
    if (!port && exited && i > 20) break;
  }
  if (!port) {
    child.kill();
    throw new Error("The browser didn't open for recording. If a window for this site is already open, close it and try again.");
  }
  const attached = await connect(port);
  return { ...attached, process: child };
}

export async function closeBrowser(launched: LaunchedBrowser): Promise<void> {
  try {
    const session = await launched.browser.newBrowserCDPSession();
    await session.send('Browser.close');
  } catch {
    // Already closed by the user.
  }
  await launched.browser.close().catch(() => {});
  if (launched.process && launched.process.exitCode === null) launched.process.kill();
}
