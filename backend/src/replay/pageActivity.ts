import type { Page, Request } from 'playwright-core';

// Whether a page has gone quiet: finished loading, no requests going, and
// nothing added to or removed from the page for a while. The replay uses it
// to stop waiting for an element that isn't coming (elementFinder.ts),
// instead of always waiting out the full locator timeout.
//
// Attached when the run's page opens, so requests started by the step
// before (a click that loads the next form) are already being counted.
//
// What counts as activity:
//   - a document, script, XHR/fetch or EventSource request starting or
//     ending (images, fonts and styles don't bring new elements);
//   - nodes added to or removed from the DOM (a MutationObserver in the
//     page; attribute and style changes, like a carousel moving, don't count).
// A request still going after LONG_LIVED_MS is taken to be a long poll or
// stream and stops counting. A page that never goes quiet (live tickers,
// constant re-rendering) just gets the full timeout, as before.

const COUNTED = new Set(['document', 'script', 'xhr', 'fetch', 'eventsource']);
const LONG_LIVED_MS = 10_000;

// Page-side: ms since the last node was added or removed, or null while the
// page is still loading. Installs its observer the first time it's asked on
// each document, so a fresh document starts at "just changed".
const DOM_QUIET = `(() => {
  if (document.readyState !== 'complete') return null;
  const key = '__nodebrainReplayQuiet';
  let w = window[key];
  if (!w) {
    w = { last: performance.now() };
    Object.defineProperty(window, key, { value: w });
    new MutationObserver((ms) => {
      for (const m of ms) if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) { w.last = performance.now(); return; }
    }).observe(document, { childList: true, subtree: true });
  }
  return performance.now() - w.last;
})()`;

export class PageActivity {
  private inFlight = new Map<Request, number>(); // request → when it started
  private lastNetwork = Date.now();

  constructor(private page: Page) {
    page.on('request', (r) => {
      if (!COUNTED.has(r.resourceType())) return;
      this.inFlight.set(r, Date.now());
      this.lastNetwork = Date.now();
    });
    const done = (r: Request) => {
      if (this.inFlight.delete(r)) this.lastNetwork = Date.now();
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  // How long the page has been quiet, in ms; 0 while it's loading or busy.
  async quietMs(): Promise<number> {
    const now = Date.now();
    for (const [r, started] of this.inFlight) {
      if (now - started < LONG_LIVED_MS) return 0;
      this.inFlight.delete(r); // a long poll or stream: not a page still loading
    }
    const dom = await this.page.evaluate(DOM_QUIET).catch(() => null) as number | null;
    if (dom === null) return 0; // loading, or mid-navigation
    return Math.min(now - this.lastNetwork, dom);
  }
}

const tracked = new WeakMap<Page, PageActivity>();

export function trackActivity(page: Page): PageActivity {
  let a = tracked.get(page);
  if (!a) { a = new PageActivity(page); tracked.set(page, a); }
  return a;
}
