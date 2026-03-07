import { useStore } from '../../stores/appStore';
import { Terminal } from 'lucide-react';

const LEVEL_COLORS: Record<string, string> = {
  info: '#94a3b8',
  warn: '#f59e0b',
  error: '#ef4444',
  debug: '#6366f1',
};

export function LogsPanel() {
  const { logs, agents } = useStore();

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
            <div key={log.id} className="flex gap-3 hover:bg-brain-bg rounded px-1 py-0.5 group">
              <span className="text-brain-text-dim opacity-50 flex-shrink-0 w-20 truncate">
                {new Date(log.timestamp).toLocaleTimeString()}
              </span>
              <span className="flex-shrink-0 w-14" style={{ color: LEVEL_COLORS[log.level] ?? '#94a3b8' }}>
                [{log.level}]
              </span>
              <span className="text-brain-accent/70 flex-shrink-0 max-w-[120px] truncate">
                {getAgentName(log.agentId)}
              </span>
              <span className="text-brain-text-dim flex-1">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
