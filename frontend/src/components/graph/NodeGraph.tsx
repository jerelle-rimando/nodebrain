import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesState,
  useEdgesState,
  addEdge,
  type Connection,
  type Edge,
  type Node,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { AgentNode } from './AgentNode';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import type { Agent } from '@shared/types';

const nodeTypes = { agentNode: AgentNode };

interface ExecuteDialogProps {
  agent: Agent;
  onClose: () => void;
}

function ExecuteDialog({ agent, onClose }: ExecuteDialogProps) {
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  async function handleRun() {
    if (!input.trim()) return;
    setRunning(true);
    try {
      await api.executeAgent(agent.id, input.trim());
      setDone(true);
    } catch (err) {
      console.error(err);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="bg-brain-surface border border-brain-border rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <h3 className="text-base font-semibold text-brain-text mb-1">Execute Agent</h3>
        <p className="text-sm text-brain-text-dim mb-4">{agent.name}</p>

        {done ? (
          <div className="text-center py-4">
            <div className="w-10 h-10 rounded-full bg-brain-success/20 border border-brain-success/30 flex items-center justify-center mx-auto mb-3">
              <span className="text-brain-success text-lg">✓</span>
            </div>
            <p className="text-sm text-brain-text">Task started! Check the Logs panel for updates.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 text-sm bg-brain-accent text-white rounded-lg hover:bg-brain-accent-dim transition-colors">
              Close
            </button>
          </div>
        ) : (
          <>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`What should ${agent.name} do?`}
              rows={3}
              className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2.5 text-sm text-brain-text placeholder-brain-text-dim resize-none focus:outline-none focus:border-brain-accent mb-4"
            />
            <div className="flex gap-3">
              <button onClick={onClose} className="flex-1 py-2 text-sm border border-brain-border rounded-lg text-brain-text-dim hover:text-brain-text transition-colors">
                Cancel
              </button>
              <button
                onClick={handleRun}
                disabled={!input.trim() || running}
                className="flex-1 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                {running ? 'Starting...' : 'Run Task'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function NodeGraph() {
  const { agents, removeAgent } = useStore();
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [executeTarget, setExecuteTarget] = useState<Agent | null>(null);

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds) => addEdge(params, eds)),
    [setEdges],
  );

  async function handleDeleteAgent(id: string) {
    await api.deleteAgent(id);
    removeAgent(id);
  }

  // Sync agents → nodes
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
          onExecute: setExecuteTarget,
          onDelete: handleDeleteAgent,
        },
      };
    });
    setNodes(newNodes);
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
            const colors: Record<string, string> = {
              idle: '#374151',
              running: '#6366f1',
              error: '#ef4444',
              stopped: '#94a3b8',
            };
            return colors[agent.status] ?? '#374151';
          }}
          maskColor="rgba(10,10,15,0.8)"
        />
      </ReactFlow>

      {agents.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-brain-text-dim text-sm">No agents yet</p>
            <p className="text-brain-text-dim text-xs mt-1">Create agents from the Dashboard to see them here</p>
          </div>
        </div>
      )}

      {executeTarget && (
        <ExecuteDialog agent={executeTarget} onClose={() => setExecuteTarget(null)} />
      )}
    </div>
  );
}
