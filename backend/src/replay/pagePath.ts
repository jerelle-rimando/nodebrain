// Whether the browser is on the page a step was recorded on, judged from the
// address's path.
//
// A strict comparison got single-page apps wrong. HubSpot's contact record
// lives at /contacts/<portal>/record/0-1/<contact id>, and a workflow that
// creates a contact gets a new contact id every run. The screen is the same
// form; the path never matches the recorded one. Every miss on it then said
// "The browser is on a different page…", and a repair there was saved as an
// alternative (both steps optional) instead of a fix, so a step marked
// "always this" could be skipped silently.
//
// So segments that are record ids are compared as "an id here", not by
// value. Everything else still has to match:
//   - the number of segments;
//   - every other segment, exactly (case aside).
// /login vs /dashboard, /quote/step/1 vs /quote/step/2, /contacts vs
// /contacts/123/record all stay different pages. Query and fragment were
// never compared and still aren't.
//
// What counts as an id: all digits and at least 4 long (short numbers are
// usually steps, pages or versions: /step/2), a UUID, a run of 12+ hex
// characters with a digit in it (Mongo-style ids), or 10+ letters and digits
// mixed (opaque ids like "a8Kz03PqLm"). Words, slugs and short codes like
// HubSpot's object type "0-1" are compared as they are.

export function pathOf(url: string): string | undefined {
  try { return new URL(url).pathname; } catch { return undefined; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIdSegment(segment: string): boolean {
  let s = segment;
  try { s = decodeURIComponent(segment); } catch { /* keep as is */ }
  if (/^\d{4,}$/.test(s)) return true;
  if (UUID.test(s)) return true;
  if (/^[0-9a-f]{12,}$/i.test(s) && /\d/.test(s)) return true;
  if (/^[A-Za-z0-9]{10,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return true;
  return false;
}

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

// True when the two paths are the same page: equal, or differing only in
// record ids (see above). A trailing slash doesn't count.
export function samePagePath(recorded: string, here: string): boolean {
  if (recorded === here) return true;
  const a = segments(recorded);
  const b = segments(here);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => {
    const other = b[i];
    if (seg.toLowerCase() === other.toLowerCase()) return true;
    return isIdSegment(seg) && isIdSegment(other);
  });
}

// The browser is on a different page from the one recorded at `recordedPath`.
// False when either is unknown: no claim without both.
export function onAnotherPage(recordedPath: string | undefined, url: string): boolean {
  const here = pathOf(url);
  return !!recordedPath && !!here && !samePagePath(recordedPath, here);
}
