import { useState, useEffect } from 'react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react';
import type { TaskLog } from '@shared/types';

type RunStatus = 'failed' | 'success' | 'approval' | 'running';

const LEVEL_COLORS: Record<string, string> = {
  info: '#94a3b8',
  warn: '#f59e0b',
  error: '#ef4444',
  debug: '#2dd4bf',
};

// h:mm AM/PM, no seconds — for card header and timestamps
function formatCardTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

// Full time with seconds — for raw log lines inside expanded detail
function formatLogTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function deriveStatus(groupLogs: TaskLog[]): RunStatus {
  const hasFailed = groupLogs.some(
    (l) => l.level === 'error' || l.message.includes('Task failed'),
  );
  if (hasFailed) return 'failed';

  const hasCompleted = groupLogs.some(
    (l) => l.message === 'Task completed successfully.',
  );
  if (hasCompleted) return 'success';

  const sorted = [...groupLogs].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  if (sorted[sorted.length - 1]?.message.includes('Awaiting approval')) return 'approval';

  return 'running';
}

// Parse unique tool names from "Calling tool: {name}" log messages
function parseToolNames(groupLogs: TaskLog[]): string[] {
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const log of groupLogs) {
    const match = log.message.match(/^Calling tool: (.+)$/);
    if (match) {
      const raw = match[1].trim();
      if (!seen.has(raw)) {
        seen.add(raw);
        tools.push(raw);
      }
    }
  }
  return tools;
}

// "telegram__SEND_MESSAGE" → "telegram: send message"
function humanizeTool(raw: string): string {
  const idx = raw.indexOf('__');
  if (idx === -1) return raw.replace(/_/g, ' ').toLowerCase();
  const server = raw.slice(0, idx);
  const tool = raw
    .slice(idx + 2)
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .toLowerCase();
  return `${server}: ${tool}`;
}

function composeDescription(tools: string[], status: RunStatus): string {
  if (tools.length > 0) return tools.map(humanizeTool).join(' · ');
  switch (status) {
    case 'failed':   return 'Task failed';
    case 'success':  return 'Completed';
    case 'approval': return 'Awaiting approval';
    default:         return 'In progress';
  }
}

const STATUS_BADGE_CLASSES: Record<RunStatus, { label: string; className: string }> = {
  failed:   { label: 'Failed',   className: 'bg-brain-error/15 text-brain-error border-brain-error/30' },
  success:  { label: 'Done',     className: 'bg-brain-success/15 text-brain-success border-brain-success/30' },
  approval: { label: 'Approval', className: 'bg-brain-warning/15 text-brain-warning border-brain-warning/30' },
  running:  { label: 'Running',  className: 'bg-brain-accent/15 text-brain-accent border-brain-accent/30' },
};

function StatusBadge({ status }: { status: RunStatus }) {
  const { label, className } = STATUS_BADGE_CLASSES[status];
  return (
    <span className={`flex-shrink-0 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${className}`}>
      {label}
    </span>
  );
}

const OUTCOME_CLASS: Record<RunStatus, string> = {
  failed:   'text-brain-error',
  success:  'text-brain-success',
  approval: 'text-brain-warning',
  running:  'text-brain-accent',
};

const OUTCOME_LABEL: Record<RunStatus, string> = {
  failed:   'Failed',
  success:  'Completed',
  approval: 'Awaiting approval',
  running:  'In progress',
};

export function LogsPanel() {
  const { logs, agents, tasks, updateTask } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');

  useEffect(() => {
    const id = useStore.getState().logsFilterAgentId;
    if (id) {
      setAgentFilter(id);
      useStore.getState().setLogsFilterAgentId(null);
    }
  }, []);

  // Build a map of taskId → all logs (unfiltered, sorted asc) for status derivation
  const allLogsByTask = new Map<string, TaskLog[]>();
  for (const log of logs) {
    const arr = allLogsByTask.get(log.taskId) ?? [];
    arr.push(log);
    allLogsByTask.set(log.taskId, arr);
  }

  // Apply filters to determine which task groups are visible
  const filteredLogs = logs.filter((log) => {
    if (agentFilter && log.agentId !== agentFilter) return false;
    if (levelFilter && log.level !== levelFilter) return false;
    return true;
  });
  const visibleTaskIds = new Set(filteredLogs.map((l) => l.taskId));

  // Build one group per visible task, sorted newest-first by latest log timestamp
  const groups = Array.from(visibleTaskIds)
    .map((taskId) => {
      const allLogs = (allLogsByTask.get(taskId) ?? []).slice().sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
      return {
        taskId,
        agentId: allLogs[0]?.agentId ?? '',
        allLogs,
        latestTimestamp: allLogs[allLogs.length - 1]?.timestamp ?? '',
      };
    })
    .sort(
      (a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime(),
    );

  const totalRuns = allLogsByTask.size;

  function getAgentName(agentId: string): string {
    return agents.find((a) => a.id === agentId)?.name ?? agentId.slice(0, 8);
  }

  async function handleStop(taskId: string) {
    try {
      const updated = await api.stopTask(taskId);
      updateTask(updated);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="h-full flex flex-col rounded-xl border border-brain-border bg-brain-surface overflow-hidden">

      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-brain-border flex-shrink-0">
        <Terminal size={14} className="text-brain-text-dim" />
        <span className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">Execution Logs</span>
        <span className="ml-auto text-xs font-mono text-brain-text-dim">{groups.length} runs</span>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-brain-border flex-shrink-0">
        <select
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          className="flex-1 bg-brain-bg border border-brain-border rounded px-2 py-1 text-xs text-brain-text focus:outline-none focus:border-brain-accent"
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="w-36 bg-brain-bg border border-brain-border rounded px-2 py-1 text-xs text-brain-text focus:outline-none focus:border-brain-accent"
        >
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>
      </div>

      {/* Filter summary bar */}
      <div className="px-3 py-1.5 border-b border-brain-border flex-shrink-0 flex items-center justify-between">
        <span className="text-xs text-brain-text-dim">
          {(agentFilter || levelFilter)
            ? `${groups.length} of ${totalRuns} runs`
            : `${groups.length} run${groups.length !== 1 ? 's' : ''}`}
        </span>
        {(agentFilter || levelFilter) && (
          <button
            onClick={() => { setAgentFilter(''); setLevelFilter(''); }}
            className="text-xs text-brain-accent hover:underline"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Run cards */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {groups.length === 0 ? (
          <p className="text-brain-text-dim text-center py-4 text-xs">
            {logs.length === 0
              ? 'No logs yet. Execute an agent task to see output here.'
              : 'No runs match the current filters.'}
          </p>
        ) : (
          groups.map((group) => {
            const status = deriveStatus(group.allLogs);
            const tools = parseToolNames(group.allLogs);
            const description = composeDescription(tools, status);
            const agentName = getAgentName(group.agentId);
            const isExpanded = expanded === group.taskId;
            const task = tasks.find((t) => t.id === group.taskId);
            const taskInput = task?.input ?? task?.description ?? null;

            return (
              <div
                key={group.taskId}
                className="rounded-lg overflow-hidden border border-brain-border bg-brain-bg hover:border-brain-muted transition-colors"
              >
                {/* Collapsed card row */}
                <button
                  onClick={() => setExpanded(isExpanded ? null : group.taskId)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-brain-border/30 transition-colors text-left"
                >
                  <StatusBadge status={status} />
                  <span className="text-brain-accent/70 flex-shrink-0 font-medium text-xs max-w-[5.5rem] truncate">
                    {agentName}
                  </span>
                  <span className="text-brain-text-dim text-xs flex-1 truncate min-w-0">
                    {description}
                  </span>
                  <span className="text-[10px] font-mono text-brain-text-dim opacity-60 flex-shrink-0 whitespace-nowrap">
                    {formatCardTime(group.latestTimestamp)}
                  </span>
                  {isExpanded
                    ? <ChevronUp size={10} className="text-brain-text-dim flex-shrink-0" />
                    : <ChevronDown size={10} className="text-brain-text-dim flex-shrink-0" />
                  }
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-brain-border">

                    {/* Task instruction text */}
                    {taskInput && (
                      <div className="px-3 pt-3 pb-2.5 border-b border-brain-border/60">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-brain-text-dim mb-1.5">
                          Task
                        </p>
                        <p className="text-xs text-brain-text leading-relaxed whitespace-pre-wrap break-words">
                          {taskInput}
                        </p>
                      </div>
                    )}

                    {/* Tools + outcome summary */}
                    <div className="px-3 py-2.5 border-b border-brain-border/60 space-y-1.5">
                      {tools.length > 0 && (
                        <div className="flex gap-3 text-xs">
                          <span className="text-brain-text-dim flex-shrink-0 w-14">Tools</span>
                          <span className="text-brain-text font-mono break-all">
                            {tools.map(humanizeTool).join(' · ')}
                          </span>
                        </div>
                      )}
                      <div className="flex gap-3 text-xs">
                        <span className="text-brain-text-dim flex-shrink-0 w-14">Outcome</span>
                        <span className={OUTCOME_CLASS[status]}>{OUTCOME_LABEL[status]}</span>
                      </div>
                    </div>

                    {/* Raw log lines */}
                    <div className="border-b border-brain-border/60">
                      <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-brain-text-dim">
                        Log · {group.allLogs.length} {group.allLogs.length === 1 ? 'entry' : 'entries'}
                      </p>
                      <div className="px-3 pb-2.5 space-y-0.5 font-mono max-h-44 overflow-y-auto">
                        {group.allLogs.map((log) => (
                          <div key={log.id} className="flex items-start gap-2 text-[10px]">
                            <span className="flex-shrink-0 text-brain-text-dim opacity-50 tabular-nums">
                              {formatLogTime(log.timestamp)}
                            </span>
                            <span
                              className="flex-shrink-0 w-11"
                              style={{ color: LEVEL_COLORS[log.level] ?? '#94a3b8' }}
                            >
                              [{log.level}]
                            </span>
                            <span className="text-brain-text-dim break-words min-w-0">
                              {log.message}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Task timing + Stop button */}
                    {task && (
                      <div className="px-3 py-2 flex items-center justify-between">
                        <span className="text-[10px] text-brain-text-dim opacity-60">
                          {task.completedAt
                            ? `Finished ${formatCardTime(task.completedAt)}`
                            : `Started ${formatCardTime(task.createdAt)}`}
                        </span>
                        <div>
                          {task.status === 'running' && (
                            <button
                              onClick={() => handleStop(task.id)}
                              className="px-2 py-0.5 text-xs text-red-400 border border-red-400/40 hover:bg-red-400/10 rounded transition-colors"
                            >
                              Stop
                            </button>
                          )}
                          {task.status === 'cancelled' && (
                            <span className="text-xs font-mono text-brain-text-dim">[CANCELLED]</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
