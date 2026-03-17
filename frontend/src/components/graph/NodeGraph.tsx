import { useCallback, useEffect, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { AgentNode } from './AgentNode';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import type { Agent, Task } from '@shared/types';
import {
  Bot,
  X,
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Trash2,
} from 'lucide-react';

const nodeTypes = { agentNode: AgentNode };

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    idle: '#374151',
    running: '#6366f1',
    error: '#ef4444',
    stopped: '#94a3b8',
    completed: '#22c55e',
    failed: '#ef4444',
    pending: '#f59e0b',
  };
  return colors[status] ?? '#374151';
}

interface AgentPanelProps {
  agent: Agent;
  onClose: () => void;
  onDelete: (id: string) => void;
}

function AgentPanel({ agent, onClose, onDelete }: AgentPanelProps) {
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  useEffect(() => {
    setLoadingTasks(true);
    api.getAgentTasks(agent.id)
      .then((t) => setTasks(t.slice(0, 10)))
      .catch(console.error)
      .finally(() => setLoadingTasks(false));
  }, [agent.id]);

  async function handleRun() {
    if (!input.trim()) return;
    setRunning(true);
    setOutput(null);
    setError(null);
    try {
      await api.executeAgent(agent.id, input.trim());
      // Refresh tasks after run
      const updated = await api.getAgentTasks(agent.id);
      setTasks(updated.slice(0, 10));
      const latest = updated[0];
      if (latest?.output) setOutput(latest.output);
      if (latest?.error) setError(latest.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="absolute top-0 right-0 h-full w-80 bg-brain-surface border-l border-brain-border flex flex-col z-10 animate-slide-up">
      
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-brain-border flex-shrink-0">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: statusColor(agent.status) + '22', border: '1px solid ' + statusColor(agent.status) + '44' }}
        >
          <Bot size={15} style={{ color: statusColor(agent.status) }} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-brain-text truncate">{agent.name}</p>
          <p className="text-xs text-brain-text-dim capitalize">{agent.status}</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { onDelete(agent.id); onClose(); }}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-error hover:bg-brain-error/10 transition-colors"
          >
            <Trash2 size={13} />
          </button>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Agent Details */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">Details</p>
          <div className="rounded-lg bg-brain-bg border border-brain-border p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-brain-text-dim">Provider</span>
              <span className="text-brain-text font-mono capitalize">{agent.provider}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-brain-text-dim">Model</span>
              <span className="text-brain-text font-mono truncate max-w-36">{agent.model}</span>
            </div>
            {agent.schedule && (
              <div className="flex justify-between text-xs">
                <span className="text-brain-text-dim">Schedule</span>
                <span className="text-brain-text font-mono">{agent.schedule}</span>
              </div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-brain-text-dim">Created</span>
              <span className="text-brain-text">{new Date(agent.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
          {agent.description && (
            <p className="text-xs text-brain-text-dim leading-relaxed">{agent.description}</p>
          )}
          {agent.systemPrompt && (
            <div className="rounded-lg bg-brain-bg border border-brain-border p-3">
              <p className="text-xs text-brain-text-dim font-medium mb-1">System Prompt</p>
              <p className="text-xs text-brain-text leading-relaxed line-clamp-4">{agent.systemPrompt}</p>
            </div>
          )}
        </div>

        {/* Run Task */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">Run Task</p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'What should ' + agent.name + ' do?'}
            rows={3}
            className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-xs text-brain-text placeholder-brain-text-dim resize-none focus:outline-none focus:border-brain-accent"
          />
          <button
            onClick={handleRun}
            disabled={!input.trim() || running}
            className="w-full flex items-center justify-center gap-2 py-2 text-xs bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {running ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play size={12} />
                Run Task
              </>
            )}
          </button>

          {/* Output */}
          {output && (
            <div className="rounded-lg bg-brain-success/5 border border-brain-success/20 p-3">
              <div className="flex items-center gap-1.5 mb-2">
                <CheckCircle size={11} className="text-brain-success" />
                <p className="text-xs font-medium text-brain-success">Output</p>
              </div>
              <p className="text-xs text-brain-text leading-relaxed whitespace-pre-wrap">{output}</p>
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-brain-error/5 border border-brain-error/20 p-3">
              <div className="flex items-center gap-1.5 mb-1">
                <XCircle size={11} className="text-brain-error" />
                <p className="text-xs font-medium text-brain-error">Failed</p>
              </div>
              <p className="text-xs text-brain-text-dim">{error}</p>
            </div>
          )}
        </div>

        {/* Task History */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">
            Task History
          </p>
          {loadingTasks ? (
            <div className="flex items-center gap-2 text-xs text-brain-text-dim py-2">
              <Loader2 size={11} className="animate-spin" />
              Loading...
            </div>
          ) : tasks.length === 0 ? (
            <p className="text-xs text-brain-text-dim py-2">No tasks yet</p>
          ) : (
            <div className="space-y-2">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="rounded-lg bg-brain-bg border border-brain-border overflow-hidden"
                >
                  <button
                    onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                    className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-brain-border/30 transition-colors"
                  >
                    {task.status === 'completed' && <CheckCircle size={11} className="text-brain-success flex-shrink-0" />}
                    {task.status === 'failed' && <XCircle size={11} className="text-brain-error flex-shrink-0" />}
                    {task.status === 'running' && <Loader2 size={11} className="animate-spin text-brain-accent flex-shrink-0" />}
                    {task.status === 'pending' && <Clock size={11} className="text-brain-warning flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-brain-text truncate">
                        {task.input ?? task.description ?? 'Task'}
                      </p>
                      <p className="text-xs text-brain-text-dim">
                        {new Date(task.createdAt).toLocaleString()}
                      </p>
                    </div>
                    {expandedTask === task.id
                      ? <ChevronUp size={11} className="text-brain-text-dim flex-shrink-0" />
                      : <ChevronDown size={11} className="text-brain-text-dim flex-shrink-0" />
                    }
                  </button>
                  {expandedTask === task.id && (
                    <div className="px-3 pb-3 space-y-2 border-t border-brain-border pt-2">
                      {task.input && (
                        <div>
                          <p className="text-xs text-brain-text-dim font-medium mb-1">Input</p>
                          <p className="text-xs text-brain-text whitespace-pre-wrap">{task.input}</p>
                        </div>
                      )}
                      {task.output && (
                        <div>
                          <p className="text-xs text-brain-text-dim font-medium mb-1">Output</p>
                          <p className="text-xs text-brain-text whitespace-pre-wrap">{task.output}</p>
                        </div>
                      )}
                      {task.error && (
                        <div>
                          <p className="text-xs text-brain-text-dim font-medium mb-1">Error</p>
                          <p className="text-xs text-brain-error">{task.error}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function NodeGraph() {
  const { agents, removeAgent } = useStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges , onEdgesChange] = useEdgesState([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const onConnect = useCallback(
    (params: Connection) => {
      setEdges((eds) => [
        ...eds,
        {
          id: params.source + '-' + params.target,
          source: params.source ?? '',
          target: params.target ?? '',
          sourceHandle: params.sourceHandle ?? null,
          targetHandle: params.targetHandle ?? null,
          animated: true,
          style: { stroke: '#6366f1', strokeWidth: 1.5 },
        },
      ]);
    },
    [setEdges],
  );

  async function handleDeleteAgent(id: string) {
    await api.deleteAgent(id);
    removeAgent(id);
  }

  // Sync agents to nodes
  useEffect(() => {
    const newNodes: Node[] = agents.map((agent, i) => {
      const cols = 3;
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        id: agent.id,
        type: 'agentNode',
        position: { x: 60 + col * 260, y: 60 + row * 200 },
        data: {
          agent,
          onSelect: setSelectedAgent,
        },
      };
    });
    setNodes(newNodes);
  }, [agents]);

  // Update selected agent when agents store updates
  useEffect(() => {
    if (selectedAgent) {
      const updated = agents.find((a) => a.id === selectedAgent.id);
      if (updated) setSelectedAgent(updated);
    }
  }, [agents]);

  return (
    <div className="h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#1e1e2e" />
        <Controls />
        <MiniMap
          nodeColor={(n) => {
            const agent = agents.find((a) => a.id === n.id);
            if (!agent) return '#1e1e2e';
            return statusColor(agent.status);
          }}
          maskColor="rgba(10,10,15,0.8)"
        />
      </ReactFlow>

      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-brain-text-dim text-sm">No agents yet</p>
            <p className="text-brain-text-dim text-xs mt-1">
              Create agents from the Dashboard to see them here
            </p>
          </div>
        </div>
      )}

      {selectedAgent && (
        <AgentPanel
          agent={selectedAgent}
          onClose={() => setSelectedAgent(null)}
          onDelete={handleDeleteAgent}
        />
      )}
    </div>
  );
}