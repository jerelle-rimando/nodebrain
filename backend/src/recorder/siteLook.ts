import fs from 'fs';
import path from 'path';
import { parse } from 'tldts';
import type { Page } from 'playwright-core';
import { getDataDir } from '../db/database';
import { siteKeyFromUrl, siteNameFromKey, siteKeyToFolderName } from './siteIdentity';

// How a site looks in NodeBrain's lists: its favicon and its name as the site
// writes it ("Expand Testing" for expandtesting.com, which the domain alone
// can't split). Both are read from the site's own page while NodeBrain's
// browser is already on it, during a recording or a run. Nothing is asked
// of anyone else: no favicon service, no lookup, so no third party learns
// which sites are automated.
//
// The icon is kept at <data dir>/site-icons/<site folder>.<ext>, next to the
// site's browser profile folder name, and served by GET /api/site-icons.

const ICON_DIR = 'site-icons';
const MAX_ICON_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

export interface SiteLook {
  name?: string; // the site's own spelling of its name, when the page has it
  iconSaved: boolean;
}

// ── The icon ────────────────────────────────────────────────────────────────

export function siteIconsDir(): string {
  return path.join(getDataDir(), ICON_DIR);
}

const EXT = ['png', 'ico', 'svg', 'gif', 'jpg', 'webp'] as const;
type IconExt = (typeof EXT)[number];

export const ICON_TYPES: Record<IconExt, string> = {
  png: 'image/png', ico: 'image/x-icon', svg: 'image/svg+xml', gif: 'image/gif', jpg: 'image/jpeg', webp: 'image/webp',
};

// The stored icon's file name for a site, if it has one.
export function siteIconFile(siteKey: string): { file: string; version: number } | null {
  const base = siteKeyToFolderName(siteKey);
  for (const ext of EXT) {
    const file = `${base}.${ext}`;
    try {
      const stat = fs.statSync(path.join(siteIconsDir(), file));
      return { file, version: Math.round(stat.mtimeMs) };
    } catch { /* not this one */ }
  }
  return null;
}

// What the frontend puts in an <img src>; the version busts its cache when
// the icon is replaced.
export function siteIconUrl(siteKey: string): string | undefined {
  const found = siteIconFile(siteKey);
  return found ? `/api/site-icons/${encodeURIComponent(found.file)}?v=${found.version}` : undefined;
}

// Recognised by content, not by what the server says it is.
function sniff(buf: Buffer): IconExt | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0 && buf[1] === 0 && (buf[2] === 1 || buf[2] === 2) && buf[3] === 0) return 'ico';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  const head = buf.toString('utf8', 0, Math.min(buf.length, 1024)).trimStart().toLowerCase();
  if ((head.startsWith('<svg') || head.startsWith('<?xml')) && head.includes('<svg')) return 'svg';
  return null;
}

function saveIcon(siteKey: string, buf: Buffer, ext: IconExt): void {
  const dir = siteIconsDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = siteKeyToFolderName(siteKey);
  for (const other of EXT) {
    if (other !== ext) { try { fs.unlinkSync(path.join(dir, `${base}.${other}`)); } catch { /* none */ } }
  }
  fs.writeFileSync(path.join(dir, `${base}.${ext}`), buf);
}

interface PageFacts {
  icons: Array<{ href: string; rel: string; sizes: string; type: string }>;
  texts: string[]; // places a site writes its own name, most telling first
}

// Read in the page. Plain DOM reads; the page isn't changed.
const READ_PAGE = `(() => {
  const icons = [...document.querySelectorAll('link[rel][href]')]
    .filter((l) => /(^|\\s)(icon|apple-touch-icon)(\\s|$)/i.test(l.getAttribute('rel') || ''))
    .map((l) => ({ href: l.href, rel: (l.getAttribute('rel') || '').toLowerCase(), sizes: l.getAttribute('sizes') || '', type: l.getAttribute('type') || '' }));
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const texts = [
    meta('meta[property="og:site_name"]'), meta('meta[name="application-name"]'), meta('meta[name="apple-mobile-web-app-title"]'),
    document.title || '',
    ((document.body && document.body.innerText) || '').slice(0, 300000),
  ];
  return { icons, texts };
})()`;

// Best first: a modest square PNG/SVG, then the touch icon (180px, sharp at
// any size we show), then any icon, then the site's /favicon.ico.
function iconCandidates(facts: PageFacts, pageUrl: string): string[] {
  const size = (s: string) => {
    if (/any/i.test(s)) return 64;
    const n = Math.max(0, ...s.split(/\s+/).map((p) => Number(p.split(/x/i)[0]) || 0));
    return n;
  };
  const score = (i: PageFacts['icons'][number]) => {
    const px = size(i.sizes);
    let v = 0;
    if (/svg/i.test(i.type) || /\.svg(\?|$)/i.test(i.href)) v += 40;
    if (px >= 32 && px <= 256) v += 30 + Math.min(px, 192) / 10;
    else if (px > 256) v += 20;
    else if (px > 0) v += 5;
    if (i.rel.includes('apple-touch-icon')) v += 25;
    if (/png/i.test(i.type) || /\.png(\?|$)/i.test(i.href)) v += 5;
    return v;
  };
  const urls = [...facts.icons].sort((a, b) => score(b) - score(a)).map((i) => i.href);
  try { urls.push(new URL('/favicon.ico', pageUrl).href); } catch { /* odd page URL */ }
  return [...new Set(urls)].filter((u) => /^(https?:|data:image\/)/i.test(u));
}

async function fetchIcon(page: Page, url: string): Promise<Buffer | null> {
  if (url.startsWith('data:')) {
    const m = /^data:image\/[\w.+-]+(;base64)?,(.*)$/is.exec(url);
    if (!m) return null;
    return m[1] ? Buffer.from(m[2], 'base64') : Buffer.from(decodeURIComponent(m[2]), 'utf8');
  }
  // Through the site's own browser context: the same cookies and the same
  // request the page would make, to the site (or the CDN its page names).
  const res = await page.context().request.get(url, { timeout: FETCH_TIMEOUT_MS, maxRedirects: 3, failOnStatusCode: false });
  if (!res.ok()) return null;
  const buf = await res.body();
  return buf.length > 0 && buf.length <= MAX_ICON_BYTES ? buf : null;
}

// ── The name ────────────────────────────────────────────────────────────────

// The site's name as its pages write it: a run of words whose letters, put
// together, are the domain's ("Expand Testing" ↔ expandtesting). One-word
// spellings count only when they carry the site's own capitals ("GitHub",
// "OrangeHRM"); plain "expandtesting" in the text says nothing new.
export function nameFromTexts(siteKey: string, texts: string[]): string | undefined {
  const parsed = parse(siteKey, { allowPrivateDomains: false });
  const base = (parsed.domainWithoutSuffix || '').toLowerCase();
  const target = base.replace(/[^a-z0-9]/g, '');
  if (target.length < 3) return undefined;

  const counts = new Map<string, number>();
  for (const text of texts) {
    if (!text) continue;
    const words: Array<{ w: string; start: number; end: number }> = [];
    for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) words.push({ w: m[0], start: m.index!, end: m.index! + m[0].length });
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(words.length, i + 6); j++) {
        // Words of one name sit on one line, apart only by spaces or a hyphen.
        if (j > i && !/^[ \t -]{1,3}$/.test(text.slice(words[j - 1].end, words[j].start))) break;
        joined += words[j].w.toLowerCase();
        if (!target.startsWith(joined)) break;
        if (joined === target) {
          const parts = words.slice(i, j + 1).map((x) => x.w);
          const name = tidy(parts);
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
          break;
        }
      }
    }
  }
  // Most often written; a tie goes to the spelling with more words.
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].split(' ').length - a[0].split(' ').length)[0]?.[0];
}

function tidy(parts: string[]): string | undefined {
  if (parts.length === 1) {
    const w = parts[0];
    const ownCapitals = /[a-z]/.test(w) && /[A-Z]/.test(w.slice(1));
    return ownCapitals ? w : undefined;
  }
  // "EXPAND TESTING" and "expand testing" both read "Expand Testing"; a
  // word with its own capitals ("HubSpot") keeps them.
  return parts.map((w) => {
    if (w === w.toUpperCase() || w === w.toLowerCase()) return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return w;
  }).join(' ');
}

// ── Capturing ───────────────────────────────────────────────────────────────

// Reads the page it's on, if that page is on the site. Never throws: a site
// without an icon or a findable name just keeps the defaults.
export async function captureSiteLook(page: Page, siteKey: string, want: { icon: boolean; name: boolean }): Promise<SiteLook> {
  const look: SiteLook = { iconSaved: false };
  try {
    const url = page.url();
    if (!/^https?:/i.test(url) || siteKeyFromUrl(url) !== siteKey) return look;
    const facts = (await page.evaluate(READ_PAGE)) as PageFacts;
    if (want.name) look.name = nameFromTexts(siteKey, facts.texts);
    if (want.icon) {
      for (const candidate of iconCandidates(facts, url).slice(0, 4)) {
        const buf = await fetchIcon(page, candidate).catch(() => null);
        const ext = buf && sniff(buf);
        if (buf && ext) {
          saveIcon(siteKey, buf, ext);
          look.iconSaved = true;
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[site-look] could not read the page:', err instanceof Error ? err.message.split('\n')[0] : err);
  }
  return look;
}

// A stored site name worth replacing: still the one made from the domain.
export function isDefaultSiteName(siteKey: string, name: string): boolean {
  return name === siteNameFromKey(siteKey);
}
