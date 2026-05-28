import { useState, useEffect } from 'react';
import { Home, Smartphone, Lock, Wifi, AlertTriangle, Mail } from 'lucide-react';

const WHATS_COMING = [
  { icon: Home, label: 'One-click home server install' },
  { icon: Smartphone, label: 'Secure mobile access' },
  { icon: Lock, label: 'Built-in authentication' },
  { icon: Wifi, label: 'Auto device discovery' },
];

const SETUP_STEPS = [
  { label: 'Clone the repository', cmd: 'git clone <repo-url>' },
  { label: 'Install dependencies', cmd: 'cd nodebrain/backend && npm install' },
  { label: 'Build the backend', cmd: 'npm run build' },
  { label: 'Set environment variables', cmd: 'export VAULT_SECRET="your-secret"\nexport NODEBRAIN_DATA_DIR="/path/to/data"' },
  { label: 'Start the server', cmd: 'npm start' },
  { label: 'Find your local IP', cmd: '# macOS/Linux: ip addr  |  Windows: ipconfig\n# Then connect from other devices: http://<your-ip>:3001' },
];

export function ServersPage() {
  const [email, setEmail] = useState('');
  const [notifyStatus, setNotifyStatus] = useState<'idle' | 'sending' | 'success' | 'error' | 'invalid'>('idle');
  const [inputUrl, setInputUrl] = useState('http://localhost:3001');
  const [saveStatus, setSaveStatus] = useState<string | null>(null);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.getBackendUrl) return;
    api.getBackendUrl()
      .then((url: string) => { if (url) setInputUrl(url); })
      .catch(() => {});
  }, []);

  const handleNotify = async () => {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes('@') || !trimmed.includes('.')) {
      setNotifyStatus('invalid');
      return;
    }
    setNotifyStatus('sending');
    try {
      const res = await fetch('https://formspree.io/f/xjgzjqgb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: trimmed }),
      });
      if (res.ok) {
        setEmail('');
        setNotifyStatus('success');
      } else {
        setNotifyStatus('error');
      }
    } catch {
      setNotifyStatus('error');
    }
  };

  const handleSave = async () => {
    const api = (window as any).electronAPI;
    if (!api?.setBackendUrl) return;
    await api.setBackendUrl(inputUrl);
    setSaveStatus('Saved — restart NodeBrain for changes to take effect.');
  };

  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="max-w-2xl mx-auto space-y-5">

        {/* 1. Heading */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-bold text-brain-text">Servers</h1>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brain-accent/20 border border-brain-accent/30 text-brain-accent">
              Beta
            </span>
          </div>
          <p className="text-sm text-brain-text-dim">Run NodeBrain 24/7 on your own hardware.</p>
        </div>

        {/* 2. Status card */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-brain-success flex-shrink-0" />
            <span className="text-sm text-brain-text">Currently running locally</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={inputUrl}
              onChange={(e) => { setInputUrl(e.target.value); setSaveStatus(null); }}
              className="flex-1 font-mono text-xs bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-brain-text focus:outline-none focus:border-brain-accent/50 transition-colors"
            />
            <button
              type="button"
              onClick={handleSave}
              className="px-4 py-2 bg-brain-accent/20 border border-brain-accent/30 text-brain-accent text-sm font-semibold rounded-lg hover:bg-brain-accent/30 transition-colors whitespace-nowrap"
            >
              Save
            </button>
          </div>
          {saveStatus && (
            <p className="text-xs text-brain-success">{saveStatus}</p>
          )}
        </div>

        {/* 3. What's coming in v1.0 */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
          <h2 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-4">
            What's coming in v1.0
          </h2>
          <div className="grid grid-cols-2 gap-3">
            {WHATS_COMING.map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center flex-shrink-0">
                  <Icon size={14} className="text-brain-accent" />
                </div>
                <span className="text-sm text-brain-text">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 4. Power user setup */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
          <h2 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-1">
            Power user setup
          </h2>
          <p className="text-xs text-brain-success mb-4">Manual — available now</p>
          <ol className="space-y-3">
            {SETUP_STEPS.map(({ label, cmd }, i) => (
              <li key={i} className="flex gap-3 items-start">
                <span className="font-mono text-xs font-bold text-brain-accent flex-shrink-0 w-4 mt-2.5">
                  {i + 1}.
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-brain-text-dim mb-1">{label}</p>
                  <pre className="font-mono text-xs bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-brain-text whitespace-pre-wrap break-all select-all leading-relaxed">
                    {cmd}
                  </pre>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* 5. Warning callout */}
        <div className="border border-brain-warning/30 bg-brain-warning/10 rounded-xl p-4 flex gap-3">
          <AlertTriangle size={16} className="text-brain-warning flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-brain-warning mb-1.5">Security warning</p>
            <ul className="space-y-1 text-xs text-brain-text-dim list-disc list-inside">
              <li>Only use on trusted WiFi networks.</li>
              <li>Never expose to the public internet — v0.3 has no remote authentication.</li>
              <li>You are responsible for your own network security.</li>
            </ul>
          </div>
        </div>

        {/* 6. Email notify */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
          <h2 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-3">
            Get notified when v1.0 ships
          </h2>
          <div className="flex gap-2">
            <input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setNotifyStatus('idle'); }}
              className="flex-1 bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent/50 transition-colors"
            />
            <button
              type="button"
              onClick={handleNotify}
              disabled={notifyStatus === 'sending'}
              className="px-4 py-2 bg-brain-accent/20 border border-brain-accent/30 text-brain-accent text-sm font-semibold rounded-lg hover:bg-brain-accent/30 transition-colors whitespace-nowrap flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Mail size={14} />
              {notifyStatus === 'sending' ? 'Sending…' : 'Notify me'}
            </button>
          </div>
          {notifyStatus === 'invalid' && (
            <p className="text-xs text-brain-warning">Please enter a valid email.</p>
          )}
          {notifyStatus === 'success' && (
            <p className="text-xs text-brain-success">Thanks — we'll email you when v1.0 ships.</p>
          )}
          {notifyStatus === 'error' && (
            <p className="text-xs text-brain-warning">Something went wrong, try again later.</p>
          )}
        </div>

      </div>
    </div>
  );
}
