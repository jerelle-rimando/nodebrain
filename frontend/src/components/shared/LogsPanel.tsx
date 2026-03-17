import { useState } from 'react';
import { useStore } from '../../stores/appStore';
import { Terminal, ChevronDown, ChevronUp } from 'lucide-react';

const LEVEL_COLORS: Record<string, string> = {
  info: '#94a3b8',
  warn: '#f59e0b',
  error: '#ef4444',
  debug: '#6366f1',
};

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function LogsPanel() {
  const { logs, agents } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);

  function getAgentName(agentId: string): string {
    return agents.find((a) => a.id === agentId)?.name ?? agentId.slice(0, 8);
  }

  return (
    <div className="h-full flex flex-col rounded-xl border border-brain-border bg-brain-surface overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-brain-border">
        <Terminal size={14} className="text-brain-text-dim" />
        <span className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">Execution Logs</span>
        <span className="ml-auto text-xs font-mono text-brain-text-dim">{logs.length} entries</span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs space-y-1">
        {logs.length === 0 ? (
          <p className="text-brain-text-dim text-center py-4">No logs yet. Execute an agent task to see output here.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="rounded overflow-hidden border border-transparent hover:border-brain-border transition-colors">
              <button
                onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                className="w-full flex items-center gap-2 px-2 py-1 hover:bg-brain-bg transition-colors text-left"
              >
                <span className="flex-shrink-0 w-14 text-brain-text-dim opacity-60">
                  {formatTime(log.timestamp)}
                </span>
                <span
                  className="flex-shrink-0 w-12"
                  style={{ color: LEVEL_COLORS[log.level] ?? '#94a3b8' }}
                >
                  [{log.level}]
                </span>
                <span className="text-brain-accent/70 flex-shrink-0 max-w-24 truncate">
                  {getAgentName(log.agentId)}
                </span>
                <span className="text-brain-text-dim flex-1 truncate">{log.message}</span>
                {expanded === log.id
                  ? <ChevronUp size={10} className="text-brain-text-dim flex-shrink-0" />
                  : <ChevronDown size={10} className="text-brain-text-dim flex-shrink-0" />
                }
              </button>
              {expanded === log.id && (
                <div className="px-3 py-2 bg-brain-bg border-t border-brain-border space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-brain-text-dim">Agent</span>
                    <span className="text-brain-accent/70">{getAgentName(log.agentId)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-brain-text-dim">Level</span>
                    <span style={{ color: LEVEL_COLORS[log.level] ?? '#94a3b8' }}>{log.level}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-brain-text-dim">Time</span>
                    <span className="text-brain-text-dim">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-brain-border">
                    <p className="text-brain-text-dim text-xs mb-1">Message</p>
                    <p className="text-brain-text text-xs leading-relaxed whitespace-pre-wrap break-words">
                      {log.message}
                    </p>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}