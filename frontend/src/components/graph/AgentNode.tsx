import { Handle, Position } from 'reactflow';
import { Bot, AlertCircle } from 'lucide-react';
import type { Agent } from '@shared/types';

interface AgentNodeData {
  agent: Agent;
  onSelect: (agent: Agent) => void;
}

export function AgentNode({ data }: { data: AgentNodeData }) {
  const { agent, onSelect } = data;

  const statusColors: Record<string, string> = {
    idle: '#374151',
    running: '#6366f1',
    error: '#ef4444',
    stopped: '#94a3b8',
  };

  const statusColor = statusColors[agent.status] ?? '#374151';

  return (
    <div
      className="relative cursor-pointer"
      style={{ minWidth: 200 }}
      onClick={() => onSelect(agent)}
    >
      <Handle type="target" position={Position.Top} className="!bg-brain-border !border-brain-muted" />

      <div
        className="rounded-xl border bg-brain-surface p-3 shadow-xl transition-all duration-200 hover:scale-105"
        style={{
          borderColor: agent.status === 'running'
            ? '#6366f1'
            : agent.status === 'error'
            ? '#ef4444'
            : '#1e1e2e',
          boxShadow: agent.status === 'running'
            ? '0 0 20px rgba(99,102,241,0.2)'
            : agent.status === 'error'
            ? '0 0 20px rgba(239,68,68,0.15)'
            : undefined,
        }}
      >
        <div className="flex items-center gap-2 mb-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: statusColor + '22', border: '1px solid ' + statusColor + '44' }}
          >
            <Bot size={14} style={{ color: statusColor }} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-brain-text truncate">{agent.name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  backgroundColor: statusColor,
                  animation: agent.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : undefined,
                }}
              />
              <span className="text-xs capitalize" style={{ color: statusColor }}>
                {agent.status}
              </span>
            </div>
          </div>
          {agent.status === 'error' && (
            <AlertCircle size={14} className="text-brain-error flex-shrink-0" />
          )}
        </div>

        <p className="text-xs text-brain-text-dim leading-relaxed mb-3 line-clamp-2">
          {agent.description || 'No description'}
        </p>

        <div className="flex gap-2 text-xs text-brain-text-dim">
          <span className="bg-brain-bg border border-brain-border rounded px-1.5 py-0.5 font-mono truncate max-w-32">
            {agent.model}
          </span>
          {agent.schedule && (
            <span className="bg-brain-bg border border-brain-border rounded px-1.5 py-0.5">
              scheduled
            </span>
          )}
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-brain-border !border-brain-muted" />
    </div>
  );
}