import React, { useCallback, useEffect, useState } from 'react';
import { ModelSelect } from '../ModelSelect';
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
  Ban,
  ScrollText,
  Database,
  Download,
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
    cancelled: '#94a3b8',
  };
  return colors[status] ?? '#374151';
}

interface AgentPanelProps {
  agent: Agent;
  onClose: () => void;
  onDelete: (id: string) => void;
}

type MemoryItem = { id: string; text: string; source: string; timestamp: string };

function AgentPanel({ agent, onClose, onDelete }: AgentPanelProps) {
  const { setActiveTab, setLogsFilterAgentId, updateAgent: storeUpdateAgent, availableModels } = useStore();
  const [tab, setTab] = useState<'config' | 'tasks' | 'memory'>('config');
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loadingMemory, setLoadingMemory] = useState(false);

  useEffect(() => {
    setLoadingTasks(true);
    api.getAgentTasks(agent.id)
      .then((t) => setTasks(t.slice(0, 10)))
      .catch(console.error)
      .finally(() => setLoadingTasks(false));
  }, [agent.id]);

  useEffect(() => {
    if (tab !== 'memory') return;
    setLoadingMemory(true);
    api.getAgentMemory(agent.id)
      .then(setMemories)
      .catch(console.error)
      .finally(() => setLoadingMemory(false));
  }, [agent.id, tab]);

  async function handleDeleteMemory(memoryId: string) {
    try {
      await api.deleteAgentMemory(agent.id, memoryId);
      setMemories((prev) => prev.filter((m) => m.id !== memoryId));
    } catch (err) {
      console.error(err);
    }
  }

  async function handleClearMemory() {
    if (!confirm(`Delete all memory for "${agent.name}"? This cannot be undone.`)) return;
    try {
      await api.clearAgentMemory(agent.id);
      setMemories([]);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleStop(taskId: string) {
    try {
      const updated = await api.stopTask(taskId);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
    } catch (err) {
      console.error(err);
    }
  }

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
            onClick={() => { setLogsFilterAgentId(agent.id); setActiveTab('dashboard'); onClose(); }}
            title="View logs"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-accent hover:bg-brain-accent/10 transition-colors"
          >
            <ScrollText size={13} />
          </button>
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

      {/* Tab bar */}
      <div className="flex border-b border-brain-border flex-shrink-0">
        {(['config', 'tasks', 'memory'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium transition-colors capitalize ${
              tab === t
                ? 'text-brain-accent border-b-2 border-brain-accent'
                : 'text-brain-text-dim hover:text-brain-text'
            }`}
          >
            {t === 'tasks' ? 'Task History' : t === 'memory' ? 'Memory' : 'Config'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Config tab */}
        {tab === 'config' && (<>

        {/* Agent Details */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider">Details</p>
          <div className="rounded-lg bg-brain-bg border border-brain-border p-3 space-y-2">
            <div className="flex justify-between text-xs">
              <span className="text-brain-text-dim">Provider</span>
              <span className="text-brain-text font-mono capitalize">{agent.provider}</span>
            </div>
            <div className="flex justify-between text-xs items-center">
              <span className="text-brain-text-dim">Model</span>
              <ModelSelect
                provider={agent.provider}
                model={agent.model}
                availableModels={availableModels}
                onChange={async (model) => {
                  try {
                    const updated = await api.updateAgent(agent.id, { model });
                    storeUpdateAgent(updated);
                  } catch (err) {
                    console.error(err);
                  }
                }}
              />
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
            <div className="flex items-center justify-between text-xs pt-1 border-t border-brain-border">
              <span className="text-brain-text-dim">Require approval for destructive actions</span>
              <button
                role="switch"
                aria-checked={!!agent.config.approvalMode}
                onClick={async () => {
                  try {
                    await api.updateAgent(agent.id, {
                      config: { ...agent.config, approvalMode: !agent.config.approvalMode },
                    });
                  } catch (err) {
                    console.error(err);
                  }
                }}
                className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${
                  agent.config.approvalMode ? 'bg-brain-accent' : 'bg-brain-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                    agent.config.approvalMode ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="flex items-center justify-between text-xs pt-1 border-t border-brain-border">
              <span className="text-brain-text-dim">Dry-run mode (skip writes)</span>
              <button
                role="switch"
                aria-checked={!!agent.config.dryRun}
                onClick={async () => {
                  try {
                    await api.updateAgent(agent.id, {
                      config: { ...agent.config, dryRun: !agent.config.dryRun },
                    });
                  } catch (err) {
                    console.error(err);
                  }
                }}
                className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${
                  agent.config.dryRun ? 'bg-yellow-500' : 'bg-brain-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${
                    agent.config.dryRun ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="flex flex-col gap-1 pt-1 border-t border-brain-border">
              <span className="text-brain-text-dim text-xs">Telegram chat ID</span>
              <input
                type="text"
                defaultValue={agent.config.telegramChatId ?? ''}
                placeholder="e.g. 8769725315"
                onBlur={async (e) => {
                  const val = e.target.value.trim() || undefined;
                  try {
                    await api.updateAgent(agent.id, {
                      config: { ...agent.config, telegramChatId: val },
                    });
                  } catch (err) {
                    console.error(err);
                  }
                }}
                className="w-full bg-brain-bg border border-brain-border rounded px-2 py-1 text-xs text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent font-mono"
              />
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

        <button
          onClick={() => {
            const template = {
              version: '1',
              name: agent.name,
              description: agent.description,
              agents: [{
                name: agent.name,
                description: agent.description,
                systemPrompt: agent.systemPrompt,
                provider: agent.provider,
                model: agent.model,
                ...(agent.schedule ? { schedule: agent.schedule } : {}),
                ...(agent.toolPermissions?.length ? { toolPermissions: agent.toolPermissions } : {}),
              }],
              connections: [],
              tags: [],
            };
            const blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${agent.name.toLowerCase().replace(/\s+/g, '-')}-template.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-muted rounded-lg transition-colors"
        >
          <Download size={11} /> Export as Template
        </button>

        </>)}

        {/* Tasks tab */}
        {tab === 'tasks' && (<>

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
                  <div className="flex items-center">
                    <button
                      onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
                      className="flex-1 flex items-center gap-2 p-2.5 text-left hover:bg-brain-border/30 transition-colors min-w-0"
                    >
                      {task.status === 'completed' && <CheckCircle size={11} className="text-brain-success flex-shrink-0" />}
                      {task.status === 'failed' && <XCircle size={11} className="text-brain-error flex-shrink-0" />}
                      {task.status === 'running' && <Loader2 size={11} className="animate-spin text-brain-accent flex-shrink-0" />}
                      {task.status === 'pending' && <Clock size={11} className="text-brain-warning flex-shrink-0" />}
                      {task.status === 'cancelled' && <Ban size={11} className="text-brain-text-dim flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-brain-text truncate">
                          {task.input ?? task.description ?? 'Task'}
                        </p>
                        <p className="text-xs text-brain-text-dim">
                          {new Date(task.createdAt).toLocaleString()}
                        </p>
                      </div>
                      {task.status === 'cancelled' && (
                        <span className="text-xs font-mono text-brain-text-dim flex-shrink-0">[CANCELLED]</span>
                      )}
                      {expandedTask === task.id
                        ? <ChevronUp size={11} className="text-brain-text-dim flex-shrink-0" />
                        : <ChevronDown size={11} className="text-brain-text-dim flex-shrink-0" />
                      }
                    </button>
                    {task.status === 'running' && (
                      <button
                        onClick={() => handleStop(task.id)}
                        className="flex-shrink-0 mx-1.5 px-2 py-1 text-xs text-red-400 border border-red-400/40 hover:bg-red-400/10 rounded transition-colors"
                      >
                        Stop
                      </button>
                    )}
                  </div>
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

        </>)}

        {/* Memory tab */}
        {tab === 'memory' && (
          <div className="space-y-2">
            {loadingMemory ? (
              <div className="flex items-center gap-2 text-xs text-brain-text-dim py-2">
                <Loader2 size={11} className="animate-spin" />
                Loading memory...
              </div>
            ) : memories.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-brain-text-dim">
                <Database size={22} className="opacity-40" />
                <p className="text-xs">No memory stored for this agent</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-brain-text-dim">{memories.length} chunk{memories.length !== 1 ? 's' : ''} stored</p>
                <div className="space-y-2">
                  {memories.map((m) => (
                    <div key={m.id} className="rounded-lg bg-brain-bg border border-brain-border p-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0 space-y-1">
                          <p className="text-xs text-brain-text leading-relaxed line-clamp-3">
                            {m.text.slice(0, 200)}{m.text.length > 200 ? '…' : ''}
                          </p>
                          <div className="flex items-center gap-2 text-xs text-brain-text-dim">
                            <span className="font-mono truncate max-w-32">{m.source}</span>
                            <span>·</span>
                            <span>{new Date(m.timestamp).toLocaleDateString()}</span>
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteMemory(m.id)}
                          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-brain-text-dim hover:text-brain-error hover:bg-brain-error/10 transition-colors"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={handleClearMemory}
                  className="w-full mt-2 py-1.5 text-xs text-brain-error border border-brain-error/30 hover:bg-brain-error/10 rounded-lg transition-colors"
                >
                  Clear all memory
                </button>
              </>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export function NodeGraph() {
  const { agents, removeAgent } = useStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);

  const onConnect = useCallback(
    async (params: Connection) => {
      if (!params.source || !params.target) return;
      try {
        const connection = await api.createAgentConnection(params.source, params.target);
        setEdges((eds) => [
          ...eds,
          {
            id: connection.id,
            source: params.source ?? '',
            target: params.target ?? '',
            sourceHandle: params.sourceHandle ?? null,
            targetHandle: params.targetHandle ?? null,
            animated: true,
            style: { stroke: '#6366f1', strokeWidth: 1.5 },
          },
        ]);
      } catch (err) {
        console.error('Failed to create agent connection:', err);
      }
    },
    [setEdges],
  );

  async function handleDeleteAgent(id: string) {
    await api.deleteAgent(id);
    removeAgent(id);
  }

  // Sync agents to nodes
  useEffect(() => {
    const savedPositions = (() => {
      try {
        return JSON.parse(localStorage.getItem('nodebrain-positions') ?? '{}') as Record<string, {x: number, y: number}>;
      } catch {
        return {} as Record<string, {x: number, y: number}>;
      }
    })();

    setNodes((currentNodes) => {
      const currentPositions: Record<string, {x: number, y: number}> = {};
      currentNodes.forEach((n) => { currentPositions[n.id] = n.position; });

      return agents.map((agent, i) => {
        const cols = 3;
        const col = i % cols;
        const row = Math.floor(i / cols);
        const defaultPos = { x: 60 + col * 260, y: 60 + row * 200 };

        // Priority: current in-memory position > saved localStorage > default grid
        const position = currentPositions[agent.id] ?? savedPositions[agent.id] ?? defaultPos;

        return {
          id: agent.id,
          type: 'agentNode',
          position,
          data: {
            agent,
            onSelect: setSelectedAgent,
          },
        };
      });
    });
  }, [agents]);

  // Load edges from backend
  useEffect(() => {
    api.getAgentConnections().then(connections => {
      setEdges(connections.map(conn => ({
        id: conn.id,
        source: conn.sourceAgentId,
        target: conn.targetAgentId,
        animated: true,
        style: { stroke: '#6366f1', strokeWidth: 1.5 },
      })));
    }).catch(console.error);
  }, []);

  // Update selected agent when agents store updates
  useEffect(() => {
    if (selectedAgent) {
      const updated = agents.find((a) => a.id === selectedAgent.id);
      if (updated) setSelectedAgent(updated);
    }
  }, [agents]);

  const onNodeDragStop = useCallback((_event: React.MouseEvent, _node: Node) => {
    const positions: Record<string, { x: number; y: number }> = {};
    nodes.forEach((n) => { positions[n.id] = n.position; });
    localStorage.setItem('nodebrain-positions', JSON.stringify(positions));
  }, [nodes]);

  const onNodesDelete = useCallback((deletedNodes: Node[]) => {
    const deletedIds = new Set(deletedNodes.map((n) => n.id));
    const positions: Record<string, { x: number; y: number }> = {};
    nodes.filter((n) => !deletedIds.has(n.id)).forEach((n) => { positions[n.id] = n.position; });
    localStorage.setItem('nodebrain-positions', JSON.stringify(positions));
  }, [nodes]);

  const onEdgesChangeWithSync = useCallback(
    (changes: any[]) => {
      onEdgesChange(changes);
      changes.forEach(change => {
        if (change.type === 'remove') {
          api.deleteAgentConnection(change.id).catch(console.error);
        }
      });
    },
    [onEdgesChange],
  );

  return (
    <div className="h-full relative">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChangeWithSync}
        onConnect={onConnect}
        onNodeDragStop={onNodeDragStop}
        onNodesDelete={onNodesDelete}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="#2a2e47" />
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