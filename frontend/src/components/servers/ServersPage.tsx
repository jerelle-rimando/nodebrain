import { useState, useEffect } from 'react';
import { Mail } from 'lucide-react';

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

        {/* Heading */}
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-xl font-bold text-brain-text">Servers</h1>
            <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-brain-accent/20 border border-brain-accent/30 text-brain-accent">
              Beta
            </span>
          </div>
        </div>

        {/* Section B — Coming soon */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-brain-text mb-1">Run NodeBrain 24/7.</h2>
            <p className="text-sm text-brain-text-dim">
              Keep your agents running around the clock and sync across devices — self-hosted or via managed cloud. Join the waitlist to be notified when it ships.
            </p>
          </div>
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
            <p className="text-xs text-brain-success">Thanks — we'll email you when it ships.</p>
          )}
          {notifyStatus === 'error' && (
            <p className="text-xs text-brain-warning">Something went wrong, try again later.</p>
          )}
        </div>

        {/* Section A — Advanced */}
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4 space-y-3">
          <div>
            <h2 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-1">Advanced</h2>
            <p className="text-xs text-brain-text-dim">Point NodeBrain at a custom backend if you're running one.</p>
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
          <p className="text-xs text-brain-text-dim">For advanced users. You're responsible for the security of any backend you connect to.</p>
        </div>

      </div>
    </div>
  );
}
