import type { WorkflowRunStatus } from '@shared/types';

// Pure helpers for the run form and run view. No React here.

export interface PastedRow {
  values: string[] | null; // null: nothing filled
  message: string; // plain words for the person
  tone: 'ok' | 'warn';
}

// Cells of one tab-separated row, as a spreadsheet copies it. A cell with a
// tab, line break or quote in it comes wrapped in quotes with "" for ".
// Only the first row is read.
export function splitRow(text: string): { cells: string[]; moreRows: boolean } {
  const cells: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  let atCellStart = true;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && atCellStart) { quoted = true; atCellStart = false; continue; }
    if (c === '\t') { cells.push(cell); cell = ''; atCellStart = true; continue; }
    if (c === '\r' || c === '\n') break;
    cell += c;
    atCellStart = false;
  }
  cells.push(cell);
  const rest = text.slice(i).replace(/^\r?\n/, '');
  return { cells: cells.map((c) => c.trim()), moreRows: rest.trim().length > 0 };
}

// Fills boxes in order from a pasted row. Never guesses which column is
// which: the first value goes in the first box, and so on.
export function fillFromRow(text: string, labels: string[]): PastedRow {
  if (!text.trim()) return { values: null, message: '', tone: 'ok' };
  const { cells, moreRows } = splitRow(text);
  const n = labels.length;
  if (cells.length === 1 && n > 1) {
    return {
      values: null, tone: 'warn',
      message: 'That looks like a single value. Copy the whole row from your spreadsheet, with its cells side by side.',
    };
  }
  const values = cells.slice(0, n);
  const parts: string[] = [];
  if (cells.length === n) {
    parts.push(n === 1 ? 'Filled the box from your row. Check it before you run.' : `Filled all ${n} boxes from your row. Check them before you run.`);
  } else if (cells.length < n) {
    const missing = labels.slice(cells.length).map((l) => `"${l}"`).join(', ');
    parts.push(`Your row had ${cells.length} value${cells.length === 1 ? '' : 's'} but there are ${n} boxes, so only the first ${cells.length} ${cells.length === 1 ? 'was' : 'were'} filled. ${missing} kept what ${n - cells.length === 1 ? 'it' : 'they'} had before.`);
  } else {
    parts.push(`Your row had ${cells.length} values but there ${n === 1 ? 'is 1 box' : `are ${n} boxes`}, so the first ${n} were used and the rest left out. Check they landed in the right boxes.`);
  }
  if (moreRows) parts.push('Only the first row was used.');
  return { values, message: parts.join(' '), tone: cells.length === n && !moreRows ? 'ok' : 'warn' };
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export const STATUS_WORDS: Record<WorkflowRunStatus, string> = {
  pending: 'Starting',
  running: 'Running',
  completed: 'Finished',
  failed: "Didn't finish",
  cancelled: 'Stopped',
  needs_attention: 'Stopped — needs you',
};

export const STATUS_TONE: Record<WorkflowRunStatus, string> = {
  pending: 'text-brain-text-dim',
  running: 'text-brain-accent',
  completed: 'text-brain-success',
  failed: 'text-brain-error',
  cancelled: 'text-brain-text-dim',
  needs_attention: 'text-brain-warning',
};
