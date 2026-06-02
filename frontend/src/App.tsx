import { useEffect, useState } from 'react';
import { MessageSquare, GitFork, LayoutTemplate, Shield, Plug, BarChart3, User, Cloud } from 'lucide-react';
import { Dashboard } from './components/dashboard/Dashboard';
import { NodeGraph } from './components/graph/NodeGraph';
import { CredentialVault } from './components/vault/CredentialVault';
import { LogsPanel } from './components/shared/LogsPanel';
import { useStore } from './stores/appStore';
import { useLiveSync } from './hooks/useLiveSync';
import { api } from './utils/api';
import { IntegrationsPage } from './components/integrations/IntegrationsPage';
import { AnalyticsPage } from './components/analytics/AnalyticsPage';
import { ServersPage } from './components/servers/ServersPage';
import { TemplatesPage } from './components/templates/TemplatesPage';
import { ToastContainer } from './components/shared/Toast';
import { ApprovalModal } from './components/shared/ApprovalModal';
import { toast } from './components/shared/Toast';
import TitleBar from './components/shared/TitleBar';
import { OnboardingScreen } from './components/onboarding/OnboardingScreen';

const NAV_ITEMS = [
  { id: 'dashboard' as const, label: 'Dashboard', icon: MessageSquare },
  { id: 'graph' as const, label: 'NodeGraph', icon: GitFork },
  { id: 'templates' as const, label: 'Templates', icon: LayoutTemplate },
  { id: 'vault' as const, label: 'Vault', icon: Shield },
  { id: 'integrations' as const, label: 'Integrations', icon: Plug },
  { id: 'analytics' as const, label: 'Analytics', icon: BarChart3 },
];

export default function App() {
  const { activeTab, setActiveTab, agents, setAgents, setCredentials, setTasks, setLogs } = useStore();
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [showServers, setShowServers] = useState(false);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  useLiveSync();

  useEffect(() => {
    const electronAPI = (window as any).electronAPI;
    if (electronAPI) {
      electronAPI.isOnboardingComplete().then((complete: boolean) => {
        setOnboardingComplete(complete);
      }).catch(() => setOnboardingComplete(true));
    } else {
      setOnboardingComplete(true);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      api.getAgents(),
      api.getCredentials(),
      api.getTasks(),
      api.getLogs(),
    ])
      .then(([agents, credentials, tasks, logs]) => {
        setAgents(agents);
        setCredentials(credentials);
        setTasks(tasks);
        setLogs(logs);
      })
      .catch(console.error)
      .finally(() => setAgentsLoaded(true));

    const params = new URLSearchParams(window.location.search);
    const authStatus = params.get('auth');
    const provider = params.get('provider');
    if (authStatus === 'success' && provider) {
      toast.success('Google Workspace connected successfully');
      window.history.replaceState({}, '', '/');
      setActiveTab('integrations');
    } else if (authStatus === 'error' && provider) {
      toast.error('Google connection failed. Check your .env and try again.');
      window.history.replaceState({}, '', '/');
    }
  }, [setAgents, setCredentials, setTasks, setLogs, setActiveTab]);

  if (onboardingComplete === null || !agentsLoaded) return null;

  if (!onboardingComplete && agents.length === 0) {
    return <OnboardingScreen onComplete={() => setOnboardingComplete(true)} />;
  }

  return (
    <div className="flex flex-col h-screen bg-brain-bg overflow-hidden">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-14 flex flex-col items-center py-4 gap-2 border-r border-brain-border bg-brain-surface flex-shrink-0">
        {/* Logo */}
        <div className="w-8 h-8 rounded-lg bg-brain-accent flex items-center justify-center mb-3">
          <User size={16} className="text-white" />
        </div>

        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => { setShowServers(false); setActiveTab(id); }}
            title={label}
            className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
              !showServers && activeTab === id
                ? 'bg-brain-accent/20 border border-brain-accent/30 text-brain-accent'
                : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border'
            }`}
          >
            <Icon size={18} />
          </button>
        ))}

        <button
          onClick={() => setShowServers(true)}
          title="Servers"
          className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${
            showServers
              ? 'bg-brain-accent/20 border border-brain-accent/30 text-brain-accent'
              : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border'
          }`}
        >
          <Cloud size={18} />
        </button>

        <div className="mt-auto">
          <StatusDot />
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Top bar */}
        <header className="h-10 flex items-center px-4 border-b border-brain-border bg-brain-surface flex-shrink-0">
          <span className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">
            {showServers ? 'Servers' : NAV_ITEMS.find((n) => n.id === activeTab)?.label}
          </span>
          <div className="ml-auto text-xs text-brain-text-dim font-mono">
            v0.3.4
          </div>
        </header>

        {/* Content + Logs */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-hidden">
            {showServers && <ServersPage />}
            {!showServers && activeTab === 'dashboard' && <Dashboard />}
            {!showServers && activeTab === 'graph' && <NodeGraph />}
            {!showServers && activeTab === 'templates' && <TemplatesPage />}
            {!showServers && activeTab === 'vault' && <CredentialVault />}
            {!showServers && activeTab === 'integrations' && <IntegrationsPage />}
            {!showServers && activeTab === 'analytics' && <AnalyticsPage />}
          </main>

          {/* Logs panel only in dashboard */}
          {!showServers && activeTab === 'dashboard' && (
            <div className="w-80 flex-shrink-0 border-l border-brain-border p-3 overflow-hidden">
              <LogsPanel />
            </div>
          )}
        </div>
      </div>
      </div>
      <ApprovalModal />
      <ToastContainer />
    </div>
  );
}

function StatusDot() {
  return (
    <div title="Backend connected" className="w-2 h-2 rounded-full bg-brain-success animate-pulse-slow" />
  );
}
