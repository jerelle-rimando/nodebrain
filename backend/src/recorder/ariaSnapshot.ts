// Reads the target element's facts out of the "ai"-mode aria snapshot that
// Playwright's recorder attaches to each action, using the action's ref.
//
// Refs are only meaningful inside the snapshot they came from: across page
// loads they were re-found 4 times in 28 in the 2026-11 check (the spike's
// e96 → f7e96). They're used here only to locate the element in this
// snapshot, and are never stored as a locator.
//
// Line shapes (YAML; a line may be wrapped in single quotes):
//   - textbox "Username" [ref=e114]: practice
//   - heading "Login" [level=1] [ref=e92]
//   - 'img "a \"quoted\" name" [ref=e13]'
//   - button [ref=f1e7]                  (f1 = first iframe)

export interface SnapshotFacts {
  role?: string;
  name?: string;
  heading?: string;
  landmark?: string; // nearest enclosing landmark/dialog, e.g. 'form "Login"'
  container?: string; // name of the enclosing list or group (listbox, radiogroup, fieldset)
  ordinal?: number; // index among earlier elements with the same role and name
  frameRef?: string; // 'f1' when the element is inside an iframe
}

interface Line {
  indent: number;
  role: string;
  name?: string;
  ref?: string;
}

const LINE_RE = /^(\s*)-\s+'?([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?/;
const REF_RE = /\[ref=([a-z0-9]+)\]/;

const CONTAINERS = new Set(['listbox', 'radiogroup', 'group', 'menu', 'tree', 'grid', 'tablist']);

const LANDMARKS = new Set([
  'banner', 'navigation', 'main', 'contentinfo', 'complementary', 'form', 'search', 'region', 'dialog', 'alertdialog',
]);

function parseLine(raw: string): Line | null {
  const m = LINE_RE.exec(raw);
  if (!m) return null;
  return {
    indent: m[1].length,
    role: m[2],
    name: m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : undefined,
    ref: REF_RE.exec(raw)?.[1],
  };
}

export function factsForRef(snapshot: string | undefined, ref: string | undefined): SnapshotFacts {
  if (!snapshot || !ref) return {};
  const lines = snapshot.split('\n').map(parseLine);
  const idx = lines.findIndex((l) => l?.ref === ref);
  if (idx < 0) return {};
  const target = lines[idx]!;
  const facts: SnapshotFacts = { role: target.role, name: target.name };

  let ordinal = 0;
  let lastHeading: string | undefined;
  for (let i = 0; i < idx; i++) {
    const l = lines[i];
    if (!l) continue;
    if (l.role === 'heading' && l.name) lastHeading = l.name;
    if (l.role === target.role && l.name === target.name) ordinal++;
  }
  facts.heading = lastHeading;
  facts.ordinal = ordinal;

  // Walk up: each earlier line with a smaller indent is an ancestor.
  let indent = target.indent;
  for (let i = idx - 1; i >= 0 && indent > 0; i--) {
    const l = lines[i];
    if (!l || l.indent >= indent) continue;
    indent = l.indent;
    // The named group an option or radio sits in: a list's label, a
    // fieldset's legend.
    if (!facts.container && l.name && CONTAINERS.has(l.role)) facts.container = l.name;
    if (LANDMARKS.has(l.role)) {
      facts.landmark = l.name ? `${l.role} "${l.name}"` : l.role;
      break;
    }
  }

  const frame = /^(f\d+)e\d+$/.exec(ref);
  if (frame) facts.frameRef = frame[1];
  return facts;
}

// Replaces every occurrence of each secret, and the value shown on the
// password field's own line, before a snapshot is written to disk. The
// snapshot includes field values: a typed password appears as
// `textbox "Password" [ref=e117]: SuperSecretPassword!`.
export function redactSnapshot(snapshot: string, secrets: string[], secretRefs: string[]): string {
  let out = snapshot;
  for (const s of secrets) {
    if (!s) continue;
    if (s.length >= 4) {
      out = out.split(s).join('[hidden]');
    } else {
      // Too short to replace everywhere without mangling unrelated text
      // ("TX", "12"): only where it stands as a name or a field's value.
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.split(`"${s}"`).join('"[hidden]"').replace(new RegExp(`(: )${esc}$`, 'gm'), '$1[hidden]');
    }
  }
  if (secretRefs.length) {
    out = out.split('\n').map((line) => {
      const l = parseLine(line);
      if (l?.ref && secretRefs.includes(l.ref)) return line.replace(/(\[ref=[a-z0-9]+\][^:]*):\s.*$/, '$1: [hidden]');
      return line;
    }).join('\n');
  }
  return out;
}

// The page's main heading: the first heading of the highest level present
// (an <h1> if there is one). Used to suggest a workflow name.
export function topHeading(snapshot: string | undefined): string | undefined {
  if (!snapshot) return undefined;
  let best: { level: number; name: string } | undefined;
  for (const raw of snapshot.split('\n')) {
    const l = parseLine(raw);
    if (l?.role !== 'heading' || !l.name) continue;
    const level = Number(/\[level=(\d)\]/.exec(raw)?.[1] ?? 9);
    if (!best || level < best.level) best = { level, name: l.name };
    if (level === 1) break;
  }
  return best?.name;
}
