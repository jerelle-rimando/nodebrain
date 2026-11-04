import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

// Opens the user's installed browser (Edge, else Chrome) as an ordinary
// window with a NodeBrain profile for one site, and attaches to it over the
// DevTools protocol so the recorder can watch.
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

const CANDIDATES = [
  process.env.NODEBRAIN_BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter((p): p is string => !!p);

export class BrowserNotFoundError extends Error {
  constructor() {
    super("Recording needs Microsoft Edge or Google Chrome, and neither was found on this computer.");
  }
}

export function findBrowser(): string {
  const found = CANDIDATES.find((p) => fs.existsSync(p));
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

  const exe = findBrowser();
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
