import fs from 'fs';
import path from 'path';
import { getDataDir } from '../db/database';
import { siteKeyToFolderName } from '../recorder/siteIdentity';
import type { SiteAgent } from '../../shared-types';

// Brings a site's open browser window to the front ("Show the browser" on a
// run). Uses the browser's own DevTools address (localhost only, the port the
// window was opened with) to activate its tab, so nothing here touches the
// run's connection: the replay engine keeps driving the window as before.
// Windows may only flash the taskbar button if another app has focus.

export async function raiseSiteWindow(site: SiteAgent): Promise<boolean> {
  const profileDir = site.profileDir ?? path.join(getDataDir(), 'browser-profiles', siteKeyToFolderName(site.siteKey));
  let port: string;
  try {
    port = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  } catch {
    return false; // no window open for this site
  }
  if (!/^\d+$/.test(port)) return false;
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
    const targets = (await list.json()) as Array<{ id: string; type: string; url: string }>;
    const page = targets.find((t) => t.type === 'page' && /^https?:/i.test(t.url)) ?? targets.find((t) => t.type === 'page');
    if (!page) return false;
    const r = await fetch(`http://127.0.0.1:${port}/json/activate/${encodeURIComponent(page.id)}`, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch {
    return false; // the window has closed since
  }
}
