// Turns what a person typed into the address to start recording at, or a
// plain reason it can't be used. No network involved.

export type AddressCheck = { ok: true; url: string; host: string } | { ok: false; message: string };

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

export function checkStartAddress(typed: string): AddressCheck {
  let text = typed.trim();
  if (!text) return { ok: false, message: 'Type the address of the page to start on, like example.com.' };
  if (/\s/.test(text)) {
    return { ok: false, message: "A web address can't have spaces in it. Copy it from your browser's address bar." };
  }
  // Copied with angle brackets or quotes around it.
  text = text.replace(/^[<"']+|[>"']+$/g, '');

  // "mailto:…", "tel:…" and the like: a scheme that isn't a web page. Not
  // "localhost:4180", where the part before the colon is a host and a port follows.
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/)/i.test(text) && !/^[^:/]+:\d+(\/|$|\?|#)/.test(text)) {
    return { ok: false, message: 'Recording works on web pages only, so the address should start with http:// or https://.' };
  }

  // No "http://" or "https://": add one. Local test pages usually don't
  // have a secure version, so they get http://.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/?#]/)[0];
    text = `${LOCAL.test(host) ? 'http' : 'https'}://${text.replace(/^\/+/, '')}`;
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: "That doesn't look like a web address. Try something like example.com." };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Recording works on web pages only, so the address should start with http:// or https://.' };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Leave your sign-in out of the address. You'll sign in on the page itself while recording." };
  }
  const host = url.hostname.toLowerCase();
  const local = LOCAL.test(url.host) || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (!local && !host.includes('.')) {
    return { ok: false, message: `"${host}" isn't a full web address. It usually ends in something like .com.` };
  }
  return { ok: true, url: url.href, host };
}

// Whether a recording's site (its registrable domain, e.g. "jimcor.com")
// is the site this host belongs to (app.jimcor.com is jimcor.com).
export function hostIsOnSite(host: string, siteKey: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const s = siteKey.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}
