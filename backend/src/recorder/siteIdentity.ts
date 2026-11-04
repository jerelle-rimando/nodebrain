import { parse } from 'tldts';

// A site's identity is its registrable domain ("eTLD+1" from the Public
// Suffix List): app.jimcor.com and login.jimcor.com are one site, jimcor.com.
// Hosts with no registrable domain (localhost, IP addresses, intranet names)
// use the hostname itself.
export function siteKeyFromUrl(url: string): string {
  const u = new URL(url);
  const parsed = parse(u.hostname, { allowPrivateDomains: false });
  return (parsed.domain ?? u.hostname).toLowerCase();
}

// "jimcor.com" → "Jimcor"; "abc-insurance.co.uk" → "Abc Insurance";
// "localhost" → "Localhost". No model involved: it's the domain with its
// public suffix removed, split on separators, each word capitalised.
export function siteNameFromKey(siteKey: string): string {
  const parsed = parse(siteKey, { allowPrivateDomains: false });
  const base = parsed.domainWithoutSuffix || parsed.hostname || siteKey;
  return base
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Folder-safe form of a site key, for the per-site browser profile.
export function siteKeyToFolderName(siteKey: string): string {
  return siteKey.replace(/[^a-z0-9.-]/gi, '_');
}
