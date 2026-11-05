// One browser window per site profile at a time. A recording and a replay
// for the same site would otherwise share a window: launchBrowser attaches to
// a window that's already open on the profile instead of opening a second.
// Imports nothing, so the recorder and the replayer can both use it without
// importing each other.

const busy = new Map<string, string>(); // siteKey → what holds it, in plain words

export function claimSiteBrowser(siteKey: string, holder: string): boolean {
  if (busy.has(siteKey)) return false;
  busy.set(siteKey, holder);
  return true;
}

export function releaseSiteBrowser(siteKey: string, holder: string): void {
  if (busy.get(siteKey) === holder) busy.delete(siteKey);
}

export function siteBrowserHolder(siteKey: string): string | undefined {
  return busy.get(siteKey);
}
