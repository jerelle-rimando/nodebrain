import { useEffect } from 'react';
import { MessageSquare, GitFork, Shield, Activity } from 'lucide-react';
import { Dashboard } from './components/dashboard/Dashboard';
import { NodeGraph } from './components/graph/NodeGraph';
import { CredentialVault } from './components/vault/CredentialVault';
import { LogsPanel } from './components/shared/LogsPanel';
import { useStore } from './stores/appStore';
import { useEventStream } from './hooks/useEventStream';
import { api } from './utils/api';

const NAV_ITEMS = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: MessageSquare },
  { id: 'graph' as const, label: 'NodeGraph', icon: GitFork },
  { id: 'vault' as const, label: 'Vault', icon: Shield },
];

export default function App() {
  const { activeTab, setActiveTab, setAgents, setLogs } = useStore();
  useEventStream();

  useEffect(() => {
    // Bootstrap data
    api.getAgents().then(setAgents).catch(console.error);
    api.getLogs().then(setLogs).catch(console.error);
  }, [setAgents, setLogs]);

  return (
    <div className="flex h-screen bg-brain-bg overflow-hidden">
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 border-r border-brain-border bg-brain-surface flex-shrink-0">
        {/* Logo */}
        <div className="w-8 h-8 rounded-lg bg-brain-accent flex items-center justify-center mb-3">
          <span className="text-white text-xs font-bold">JR</span>
        </div>

        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            title={label}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
              activeTab === id
                ? 'bg-brain-accent/20 border border-brain-accent/30 text-brain-accent'
                : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border'
            }`}
          >
            <Icon size={18} />
          </button>
        ))}

        <div className="mt-auto">
          <StatusDot />
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Top bar */}
        <header className="h-10 flex items-center px-4 border-b border-brain-border bg-brain-surface flex-shrink-0">
          <span className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">
            {NAV_ITEMS.find((n) => n.id === activeTab)?.label}
          </span>
          <div className="ml-auto flex items-center gap-2 text-xs text-brain-text-dim font-mono">
             <img src="/newnodebrainlogodashboard.png" alt="" className="w-7 h-7 object-contain" />
            <span>NodeBrain v0.1.0</span>
          </div>
        </header>

        {/* Content + Logs */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-hidden">
            {activeTab === 'dashboard' && <Dashboard />}
            {activeTab === 'graph' && <NodeGraph />}
            {activeTab === 'vault' && <CredentialVault />}
          </main>

          {/* Persistent logs panel */}
          <div className="w-80 flex-shrink-0 border-l border-brain-border p-3 overflow-hidden">
            <LogsPanel />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusDot() {
  return (
    <div title="Backend connected" className="w-2 h-2 rounded-full bg-brain-success animate-pulse-slow" />
  );
}
