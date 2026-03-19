import { useState } from 'react';
import {
  Plug,
  CheckCircle,
  XCircle,
  Loader,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import { toast } from '../shared/Toast';

interface Integration {
  id: string;
  label: string;
  description: string;
  credentialProvider: string;
  credentialPlaceholder: string;
  oauthProvider?: string;
  tools: string[];
  setupSteps: string[];
  docsUrl?: string;
}

const INTEGRATIONS: Integration[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    description: 'Send messages, receive commands, and interact via a Telegram bot.',
    credentialProvider: 'telegram',
    credentialPlaceholder: 'bot123456:ABC-DEF...',
    tools: ['Send message', 'Send photo', 'Send document', 'Get chat info', 'Forward message'],
    setupSteps: [
      'Open Telegram and search for @BotFather',
      'Send /newbot and follow the prompts',
      'Copy the bot token BotFather gives you',
      'Paste it below and click Connect',
    ],
    docsUrl: 'https://core.telegram.org/bots',
  },
  {
    id: 'google',
    label: 'Google Workspace',
    description: 'Access Gmail, Google Docs, Sheets, Drive, and Calendar.',
    credentialProvider: 'google',
    credentialPlaceholder: 'Connects via OAuth',
    oauthProvider: 'google',
    tools: ['Read/send Gmail', 'Create/edit Docs', 'Read/write Sheets', 'List Drive files', 'Create Calendar events'],
    setupSteps: [
      'Create a Google Cloud project at console.cloud.google.com',
      'Enable Gmail, Drive, Docs, Sheets, and Calendar APIs',
      'Create OAuth credentials (Web application type)',
      'Add redirect URI: http://localhost:3001/api/auth/google/callback',
      'Copy Client ID and Secret into your .env file',
      'Restart NodeBrain then click Connect Google below',
    ],
    docsUrl: 'https://workspace.google.com',
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'Read repos, create issues, open pull requests, and manage code.',
    credentialProvider: 'github',
    credentialPlaceholder: 'ghp_...',
    tools: ['List repos', 'Create issue', 'Create PR', 'Read file contents', 'Push commits'],
    setupSteps: [
      'Go to GitHub Settings then Developer Settings',
      'Click Personal Access Tokens then Tokens classic',
      'Click Generate new token',
      'Select scopes: repo, read:org',
      'Copy the token and paste it below',
    ],
    docsUrl: 'https://github.com/settings/tokens',
  },
  {
    id: 'slack',
    label: 'Slack',
    description: 'Send messages and interact with Slack workspaces.',
    credentialProvider: 'slack',
    credentialPlaceholder: 'xoxb-...',
    tools: ['Send message', 'List channels', 'Read messages', 'Upload file', 'Set status'],
    setupSteps: [
      'Go to api.slack.com/apps and create a new app',
      'Under OAuth and Permissions add bot scopes: chat:write, channels:read',
      'Install the app to your workspace',
      'Copy the Bot User OAuth Token',
      'Paste it below and click Connect',
    ],
    docsUrl: 'https://api.slack.com/apps',
  },
  {
    id: 'notion',
    label: 'Notion',
    description: 'Read and write Notion pages and databases.',
    credentialProvider: 'notion',
    credentialPlaceholder: 'ntn_...',
    tools: ['Read page', 'Create page', 'Update page', 'Query database', 'Create database entry'],
    setupSteps: [
      'Go to notion.so/my-integrations',
      'Click New Integration and give it a name',
      'Copy the Internal Integration Token',
      'In Notion open pages you want agents to access',
      'Click the three dots then Connections then add your integration',
      'Paste the token below and click Connect',
    ],
    docsUrl: 'https://www.notion.so/my-integrations',
  },
  {
    id: 'brave',
    label: 'Brave Search',
    description: 'Give agents the ability to search the web.',
    credentialProvider: 'brave',
    credentialPlaceholder: 'BSA...',
    tools: ['Web search', 'News search', 'Image search'],
    setupSteps: [
      'Go to brave.com/search/api',
      'Sign up for a free API key (2000 queries/month free)',
      'Copy your API key',
      'Paste it below and click Connect',
    ],
    docsUrl: 'https://brave.com/search/api/',
  },
  {
    id: 'filesystem',
    label: 'Local Filesystem',
    description: 'Let agents read and write files on your local machine.',
    credentialProvider: 'filesystem',
    credentialPlaceholder: 'Windows: C:\\Users\\you\\Documents | Mac: /Users/you/Documents',
    tools: ['Read file', 'Write file', 'List directory', 'Create folder', 'Delete file'],
    setupSteps: [
      'Enter the folder path you want agents to have access to',
      'Agents will only be able to access files inside this folder',
      'Use an absolute path like C:\\Users\\you\\Documents',
    ],
  },
];

interface ConnectSectionProps {
  integration: Integration;
  connected: boolean;
  saving: string | null;
  tokenInputs: Record<string, string>;
  onTokenChange: (id: string, value: string) => void;
  onConnect: (integration: Integration) => void;
  onDisconnect: (integration: Integration) => void;
  onOAuth: (provider: string) => void;
}

function ConnectSection(props: ConnectSectionProps) {
  const { integration, connected, saving, tokenInputs, onTokenChange, onConnect, onDisconnect, onOAuth } = props;

  if (connected) {
    return (
      <button
        onClick={() => onDisconnect(integration)}
        className="w-full py-2 text-xs border border-brain-error/30 text-brain-error hover:bg-brain-error/10 rounded-lg transition-colors"
      >
        Disconnect {integration.label}
      </button>
    );
  }

  if (integration.oauthProvider) {
    return (
      <button
        onClick={() => onOAuth(integration.oauthProvider as string)}
        className="w-full py-2 text-xs bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors"
      >
        Connect {integration.label} via OAuth
      </button>
    );
  }

  return (
    <div className="flex gap-2">
      <input
        type="password"
        value={tokenInputs[integration.id] ?? ''}
        onChange={(e) => onTokenChange(integration.id, e.target.value)}
        placeholder={integration.credentialPlaceholder}
        className="flex-1 bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-xs text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent font-mono"
      />
      <button
        onClick={() => onConnect(integration)}
        disabled={!tokenInputs[integration.id]?.trim() || saving === integration.id}
        className="px-4 py-2 text-xs bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
      >
        {saving === integration.id ? 'Saving...' : 'Connect'}
      </button>
    </div>
  );
}

function ExpandedSection(props: ConnectSectionProps) {
  const { integration } = props;

  return (
    <div className="px-4 pb-4 space-y-4 border-t border-brain-border pt-4">
      <div>
        <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-2">
          Unlocks
        </p>
        <div className="flex flex-wrap gap-2">
          {integration.tools.map((tool) => (
            <span
              key={tool}
              className="text-xs bg-brain-accent/10 border border-brain-accent/20 text-brain-accent rounded-full px-2 py-0.5"
            >
              {tool}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-2">
          Setup
        </p>
        <ol className="space-y-1">
          {integration.setupSteps.map((step, i) => (
            <li key={i} className="flex items-start gap-2 text-xs text-brain-text-dim">
              <span className="w-4 h-4 rounded-full bg-brain-border flex items-center justify-center flex-shrink-0 mt-0.5 text-xs">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        {integration.docsUrl != null && (
          <a
            href={integration.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brain-accent hover:underline mt-2"
          >
            Official docs
            <ExternalLink size={10} />
          </a>
        )}
      </div>

      <ConnectSection {...props} />
    </div>
  );
}

export function IntegrationsPage() {
  const { credentials } = useStore();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, 'ok' | 'fail'>>({});
  const [tokenInputs, setTokenInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  function isConnected(integration: Integration): boolean {
    return credentials.some((c) => c.provider === integration.credentialProvider);
  }

  async function handleTest(integration: Integration) {
    setTesting(integration.id);
    try {
      const res = await api.testIntegration(integration.credentialProvider);
      setTestResults((prev) => ({
        ...prev,
        [integration.id]: res.success ? 'ok' : 'fail',
      }));
    } catch {
      toast.error('Could not reach' + integration.label + '. Check your credential.');
      setTestResults((prev) => ({ ...prev, [integration.id]: 'fail' }));
    } finally {
      setTesting(null);
    }
  }

  async function handleConnect(integration: Integration) {
    const token = tokenInputs[integration.id]?.trim();
    if (!token) return;
    setSaving(integration.id);
    try {
      await api.createCredential({
        name: integration.label,
        provider: integration.credentialProvider,
        value: token,
      });
      const creds = await api.getCredentials();
      useStore.getState().setCredentials(creds);
      setTokenInputs((prev) => ({ ...prev, [integration.id]: '' }));
            toast.success(integration.label + ' connected successfully');
    } catch (err) {
          toast.error('Failed to save credential. Check your input and try again.');
          console.error(err);
    } finally {
      setSaving(null);
    }
  }

  async function handleDisconnect(integration: Integration) {
    const cred = credentials.find((c) => c.provider === integration.credentialProvider);
    if (!cred) return;
    try {
      await api.deleteCredential(cred.id);
      const creds = await api.getCredentials();
      useStore.getState().setCredentials(creds);
            toast.success(integration.label + ' disconnected');
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[integration.id];
        return next;
      });
    } catch (err) {
          toast.error('Failed to disconnect. Try again.');
          console.error(err);
    }
  }

  function handleOAuth(provider: string) {
    window.location.href = 'http://localhost:3001/api/auth/' + provider;
  }

  function handleTokenChange(id: string, value: string) {
    setTokenInputs((prev) => ({ ...prev, [id]: value }));
  }

  return (
    <div className="h-full p-4 overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-4">

        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center">
            <Plug size={18} className="text-brain-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-brain-text">Integrations</h2>
            <p className="text-xs text-brain-text-dim">
              Connect services so your agents can take action in the world
            </p>
          </div>
        </div>

        {INTEGRATIONS.map((integration) => {
          const connected = isConnected(integration);
          const testResult = testResults[integration.id];
          const isExpanded = expanded === integration.id;

          return (
            <div
              key={integration.id}
              className={
                connected
                  ? 'rounded-xl border border-brain-success/30 bg-brain-success/5 transition-all'
                  : 'rounded-xl border border-brain-border bg-brain-surface transition-all'
              }
            >
              <div className="flex items-center gap-3 p-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-brain-text">{integration.label}</p>
                    {connected ? (
                      <span className="flex items-center gap-1 text-xs text-brain-success">
                        <CheckCircle size={11} />
                        Connected
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-xs text-brain-text-dim">
                        <XCircle size={11} />
                        Not connected
                      </span>
                    )}
                    {testResult === 'ok' && (
                      <span className="text-xs text-brain-success bg-brain-success/10 px-2 py-0.5 rounded-full">
                        Working
                      </span>
                    )}
                    {testResult === 'fail' && (
                      <span className="text-xs text-brain-error bg-brain-error/10 px-2 py-0.5 rounded-full">
                        Failed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-brain-text-dim mt-0.5">{integration.description}</p>
                </div>

                <div className="flex items-center gap-2">
                  {connected && (
                    <button
                      onClick={() => handleTest(integration)}
                      disabled={testing === integration.id}
                      className="px-3 py-1.5 text-xs border border-brain-border rounded-lg text-brain-text-dim hover:text-brain-text transition-colors disabled:opacity-40"
                    >
                      {testing === integration.id ? (
                        <Loader size={11} className="animate-spin" />
                      ) : (
                        'Test'
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => setExpanded(isExpanded ? null : integration.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors"
                  >
                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
              </div>

              {isExpanded && (
                <ExpandedSection
                  integration={integration}
                  connected={connected}
                  saving={saving}
                  tokenInputs={tokenInputs}
                  onTokenChange={handleTokenChange}
                  onConnect={handleConnect}
                  onDisconnect={handleDisconnect}
                  onOAuth={handleOAuth}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
