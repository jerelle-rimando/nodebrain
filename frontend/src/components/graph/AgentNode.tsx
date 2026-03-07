import { Handle, Position } from 'reactflow';
import { Bot, Play, Trash2, AlertCircle } from 'lucide-react';
import type { Agent } from '@shared/types';

interface AgentNodeData {
  agent: Agent;
  onExecute: (agent: Agent) => void;
  onDelete: (id: string) => void;
}

export function AgentNode({ data }: { data: AgentNodeData }) {
  const { agent, onExecute, onDelete } = data;

  const statusColors: Record<string, string> = {
    idle: '#374151',
    running: '#6366f1',
    error: '#ef4444',
    stopped: '#94a3b8',
  };

  const statusColor = statusColors[agent.status] ?? '#374151';

  return (
    <div className="relative group" style={{ minWidth: 200 }}>
      <Handle type="target" position={Position.Top} className="!bg-brain-border !border-brain-muted" />

      <div
        className="rounded-xl border bg-brain-surface p-3 shadow-xl transition-all duration-200 cursor-default"
        style={{
          borderColor: agent.status === 'running' ? '#6366f1' : '#1e1e2e',
          boxShadow: agent.status === 'running' ? '0 0 20px rgba(99,102,241,0.15)' : undefined,
        }}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: `${statusColor}22`, border: `1px solid ${statusColor}44` }}
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
              <span className="text-xs capitalize" style={{ color: statusColor }}>{agent.status}</span>
            </div>
          </div>

          {agent.status === 'error' && (
            <AlertCircle size={14} className="text-brain-error flex-shrink-0" />
          )}
        </div>

        {/* Description */}
        <p className="text-xs text-brain-text-dim leading-relaxed mb-3 line-clamp-2">
          {agent.description || 'No description'}
        </p>

        {/* Meta */}
        <div className="flex gap-2 text-xs text-brain-text-dim mb-3">
          <span className="bg-brain-bg border border-brain-border rounded px-1.5 py-0.5 font-mono">{agent.model}</span>
          {agent.schedule && (
            <span className="bg-brain-bg border border-brain-border rounded px-1.5 py-0.5">⏱ scheduled</span>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <button
            onClick={() => onExecute(agent)}
            disabled={agent.status === 'running'}
            className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-brain-accent/10 hover:bg-brain-accent/20 disabled:opacity-40 disabled:cursor-not-allowed border border-brain-accent/20 rounded-lg py-1.5 text-brain-accent transition-colors"
          >
            <Play size={11} />
            Run
          </button>
          <button
            onClick={() => onDelete(agent.id)}
            className="w-8 flex items-center justify-center bg-brain-error/10 hover:bg-brain-error/20 border border-brain-error/20 rounded-lg py-1.5 text-brain-error transition-colors"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      <Handle type="source" position={Position.Bottom} className="!bg-brain-border !border-brain-muted" />
    </div>
  );
}
