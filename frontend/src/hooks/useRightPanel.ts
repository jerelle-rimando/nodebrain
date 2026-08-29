import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskLog } from '@shared/types';
import { deriveStatus, type RunStatus } from '../components/shared/LogsPanel';

const COLLAPSED_KEY = 'nb_right_panel_collapsed';
const OPENED_AT_KEY = 'nb_right_panel_opened_at';

/** Attention-pulse duration on the rail after a fresh failure, in ms. */
const PULSE_MS = 2500;

export type DotState = 'error' | 'approval' | 'running' | 'success' | null;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function readOpenedAt(): number {
  try {
    const raw = localStorage.getItem(OPENED_AT_KEY);
    if (raw) {
      const n = Number(raw);
      if (Number.isFinite(n)) return n;
    }
  } catch {
    /* ignore */
  }
  return Date.now();
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

interface TaskGroup {
  status: RunStatus;
  /** Newest log timestamp in the group, epoch ms. */
  latest: number;
}

/**
 * Group logs by taskId and derive each task's status — the exact same grouping
 * + derivation LogsPanel uses, just without the rendering. `deriveStatus` is
 * imported straight from LogsPanel so the two never drift.
 */
function deriveTaskGroups(logs: TaskLog[]): TaskGroup[] {
  const byTask = new Map<string, TaskLog[]>();
  for (const log of logs) {
    const arr = byTask.get(log.taskId);
    if (arr) arr.push(log);
    else byTask.set(log.taskId, [log]);
  }

  const groups: TaskGroup[] = [];
  for (const groupLogs of byTask.values()) {
    let latest = 0;
    for (const l of groupLogs) {
      const t = new Date(l.timestamp).getTime();
      if (t > latest) latest = t;
    }
    groups.push({ status: deriveStatus(groupLogs), latest });
  }
  return groups;
}

interface RightPanel {
  collapsed: boolean;
  toggle: () => void;
  /** Dot to show on the collapsed rail, or null for nothing. */
  dotState: DotState;
  /** True for ~2.5s after a task fails while collapsed — drives the rail glow. */
  pulsing: boolean;
}

export function useRightPanel(logs: TaskLog[]): RightPanel {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);

  // Epoch ms of the last time the panel was open. Failures/successes at or
  // before this instant count as "already seen" and don't light the dot.
  // Seeded from storage only when we mount already-collapsed; otherwise the
  // panel is visible right now, so "now" is the reference.
  const openedAtRef = useRef<number>(readCollapsed() ? readOpenedAt() : Date.now());

  const [pulsing, setPulsing] = useState(false);
  const prevFailCountRef = useRef(0);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mounting expanded: stamp "opened now" so a reload while open keeps the
  // since-last-opened window anchored to the present.
  useEffect(() => {
    if (!collapsed) persist(OPENED_AT_KEY, String(openedAtRef.current));
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
    },
    [],
  );

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      persist(COLLAPSED_KEY, next ? '1' : '0');

      if (!next) {
        // Expanding: reset the since-last-opened window so one stale failure
        // doesn't pin the dot red forever. Running/approval still surface on
        // their own because they aren't time-gated.
        const now = Date.now();
        openedAtRef.current = now;
        persist(OPENED_AT_KEY, String(now));
        prevFailCountRef.current = 0;
        setPulsing(false);
        if (pulseTimer.current) {
          clearTimeout(pulseTimer.current);
          pulseTimer.current = null;
        }
      }
      return next;
    });
  }, []);

  const groups = deriveTaskGroups(logs);
  const openedAt = openedAtRef.current;

  const failCount = groups.filter(
    (g) => g.status === 'failed' && g.latest > openedAt,
  ).length;
  const anyFailedSinceOpen = failCount > 0;
  const anySucceededSinceOpen = groups.some(
    (g) => g.status === 'success' && g.latest > openedAt,
  );
  const anyApproval = groups.some((g) => g.status === 'approval');
  const anyRunning = groups.some((g) => g.status === 'running');

  // Priority: red (failure since open) → amber (approval) → blue (running)
  // → green (success since open) → nothing.
  let dotState: DotState = null;
  if (anyFailedSinceOpen) dotState = 'error';
  else if (anyApproval) dotState = 'approval';
  else if (anyRunning) dotState = 'running';
  else if (anySucceededSinceOpen) dotState = 'success';

  // A new failure while collapsed → brief attention glow, then settle to the
  // static red dot. No-op while expanded (the panel itself shows the failure).
  useEffect(() => {
    if (collapsed && failCount > prevFailCountRef.current) {
      setPulsing(true);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(() => setPulsing(false), PULSE_MS);
    }
    prevFailCountRef.current = failCount;
  }, [failCount, collapsed]);

  return { collapsed, toggle, dotState, pulsing };
}
