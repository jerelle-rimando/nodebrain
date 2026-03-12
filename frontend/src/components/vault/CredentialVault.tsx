import { useEffect, useState } from 'react';
import { Key, Plus, Trash2, Eye, EyeOff, Shield, CheckCircle } from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { id: 'groq', label: 'Groq', placeholder: 'gsk_...' },
  { id: 'anthropic', label: 'Claude (Anthropic)', placeholder: 'sk-ant-...' },
  { id: 'gemini', label: 'Gemini', placeholder: 'AIzaSy...' },
  { id: 'ollama', label: 'Ollama (local)', placeholder: 'ollama' },
  { id: 'mistral', label: 'Mistral', placeholder: 'Enter key...' },
  { id: 'together', label: 'Together AI', placeholder: 'Enter key...' },
  { id: 'fireworks', label: 'Fireworks AI', placeholder: 'Enter key...' },
  { id: 'telegram', label: 'Telegram Bot', placeholder: 'bot123456:ABC...' },
  { id: 'google', label: 'Google Workspace', placeholder: 'OAuth token' },
  { id: 'github', label: 'GitHub', placeholder: 'ghp_...' },
  { id: 'slack', label: 'Slack', placeholder: 'xoxb-...' },
  { id: 'notion', label: 'Notion', placeholder: 'secret_...' },
  { id: 'brave', label: 'Brave Search', placeholder: 'BSA...' },
  { id: 'filesystem', label: 'Local Filesystem', placeholder: 'C:\\Users\\you\\Documents' },
  { id: 'fetch', label: 'Web Fetch', placeholder: 'no-key-needed' },
  { id: 'custom', label: 'Custom / Other', placeholder: 'Enter key...' },
];

export function CredentialVault() {
  const { credentials, setCredentials, addCredential, removeCredential } = useStore();
  const [showForm, setShowForm] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('openai');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.getCredentials().then(setCredentials).catch(console.error);
  }, [setCredentials]);

  async function handleCreate() {
    if (!name.trim() || !value.trim()) return;
    setSubmitting(true);
    try {
      const cred = await api.createCredential({ name, provider, value, description: description || undefined });
      addCredential(cred);
      setSaved(cred.id);
      setName('');
      setValue('');
      setDescription('');
      setShowForm(false);
      setTimeout(() => setSaved(null), 3000);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteCredential(id);
      removeCredential(id);
    } catch (err) {
      console.error(err);
    }
  }

  const selectedProvider = PROVIDERS.find((p) => p.id === provider);

  return (
    <div className="h-full p-4 overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center">
              <Shield size={18} className="text-brain-accent" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-brain-text">Credential Vault</h2>
              <p className="text-xs text-brain-text-dim">Credentials are encrypted and stored locally</p>
            </div>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="flex items-center gap-2 px-3 py-2 text-xs bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors"
          >
            <Plus size={13} />
            Add Credential
          </button>
        </div>

        {/* Security notice */}
        <div className="flex items-start gap-3 p-3 rounded-xl bg-brain-success/5 border border-brain-success/20">
          <Shield size={14} className="text-brain-success mt-0.5 flex-shrink-0" />
          <p className="text-xs text-brain-text-dim leading-relaxed">
            All credentials are encrypted with AES-256 before storage. Raw values are never exposed to the frontend or logs.
          </p>
        </div>

        {/* Add Credential Form */}
        {showForm && (
          <div className="rounded-xl border border-brain-border bg-brain-surface p-4 space-y-3 animate-slide-up">
            <h3 className="text-sm font-medium text-brain-text">New Credential</h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-brain-text-dim mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My OpenAI Key"
                  className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent"
                />
              </div>
              <div>
                <label className="block text-xs text-brain-text-dim mb-1">Provider</label>
                <select
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text focus:outline-none focus:border-brain-accent"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-brain-text-dim mb-1">API Key</label>
              <div className="relative">
                <input
                  type={showValue ? 'text' : 'password'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={selectedProvider?.placeholder ?? 'Enter key...'}
                  className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 pr-10 text-sm text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowValue(!showValue)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-brain-text-dim hover:text-brain-text"
                >
                  {showValue ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs text-brain-text-dim mb-1">Description (optional)</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Personal account, project key, etc."
                className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent"
              />
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => setShowForm(false)} className="flex-1 py-2 text-sm border border-brain-border rounded-lg text-brain-text-dim hover:text-brain-text transition-colors">
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={!name.trim() || !value.trim() || submitting}
                className="flex-1 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                {submitting ? 'Encrypting...' : 'Save Credential'}
              </button>
            </div>
          </div>
        )}

        {/* Credentials List */}
        <div className="space-y-2">
          {credentials.length === 0 ? (
            <div className="text-center py-12 text-brain-text-dim">
              <Key size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No credentials stored yet</p>
              <p className="text-xs mt-1">Add your API keys to enable agent execution</p>
            </div>
          ) : (
            credentials.map((cred) => (
              <div
                key={cred.id}
                className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${
                  saved === cred.id
                    ? 'border-brain-success/40 bg-brain-success/5'
                    : 'border-brain-border bg-brain-surface hover:border-brain-muted'
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center flex-shrink-0">
                  <Key size={14} className="text-brain-accent" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-brain-text">{cred.name}</p>
                    {saved === cred.id && <CheckCircle size={12} className="text-brain-success" />}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-xs text-brain-text-dim capitalize">{cred.provider}</span>
                    {cred.description && (
                      <>
                        <span className="text-brain-border">·</span>
                        <span className="text-xs text-brain-text-dim">{cred.description}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-brain-text-dim bg-brain-bg border border-brain-border rounded px-2 py-1">
                    ••••••••
                  </span>
                  <button
                    onClick={() => handleDelete(cred.id)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-error hover:bg-brain-error/10 transition-colors"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
