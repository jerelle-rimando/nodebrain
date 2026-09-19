import { useEffect, useState } from 'react';
import { Settings } from 'lucide-react';

export function SettingsPage() {
  const isElectron = !!(window as any).electronAPI;
  const [launchOnStartup, setLaunchOnStartupState] = useState(false);
  const [telemetryEnabled, setTelemetryEnabledState] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    (window as any).electronAPI.getLaunchOnStartup().then(setLaunchOnStartupState).catch(console.error);
  }, [isElectron]);

  useEffect(() => {
    if (!isElectron || !(window as any).electronAPI.getTelemetryConsent) return;
    (window as any).electronAPI.getTelemetryConsent()
      .then((consent: string) => setTelemetryEnabledState(consent === 'granted'))
      .catch(console.error);
  }, [isElectron]);

  async function handleLaunchOnStartupChange(enabled: boolean) {
    try {
      const newState = await (window as any).electronAPI.setLaunchOnStartup(enabled);
      setLaunchOnStartupState(newState);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleTelemetryChange(enabled: boolean) {
    try {
      const consent = await (window as any).electronAPI.setTelemetryConsent(enabled ? 'granted' : 'denied');
      setTelemetryEnabledState(consent === 'granted');
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="h-full p-4 overflow-y-auto">
      <div className="max-w-2xl mx-auto space-y-6">

        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center">
            <Settings size={18} className="text-brain-accent" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-brain-text">Settings</h2>
            <p className="text-xs text-brain-text-dim">App behavior, data sharing, and data management</p>
          </div>
        </div>

        {isElectron && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">General</h3>
            <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex items-center justify-between gap-4">
              <p className="text-sm text-brain-text">Launch NodeBrain at system startup</p>
              <button
                role="switch"
                aria-checked={launchOnStartup}
                onClick={() => handleLaunchOnStartupChange(!launchOnStartup)}
                className={`relative inline-flex w-10 h-6 rounded-full transition-colors flex-shrink-0 ${launchOnStartup ? 'bg-brain-accent' : 'bg-brain-border'}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${launchOnStartup ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
          </section>
        )}

        {isElectron && (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">Data sharing</h3>
            <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm text-brain-text">Share anonymous usage data</p>
                <p className="text-xs text-brain-text-dim mt-0.5">Includes feature usage, agents created and run, connected integrations, model provider type, error categories, and setup completion. Never your prompts, agent names, file paths, message contents, or credentials. Off by default.</p>
              </div>
              <button
                role="switch"
                aria-checked={telemetryEnabled}
                onClick={() => handleTelemetryChange(!telemetryEnabled)}
                className={`relative inline-flex w-10 h-6 rounded-full transition-colors flex-shrink-0 ${telemetryEnabled ? 'bg-brain-accent' : 'bg-brain-border'}`}
              >
                <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white transition-transform ${telemetryEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
          </section>
        )}

        <section className="pt-6 mt-8 border-t border-brain-border space-y-2">
          <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider">Danger zone</h3>
          <button
            onClick={() => {
              if (confirm('This will permanently delete all agents, credentials, tasks, and memory. NodeBrain will restart. Continue?')) {
                (window as any).electronAPI?.resetAllData();
              }
            }}
            className="w-full py-2 text-sm text-red-400 border border-red-500/30 hover:bg-red-500/10 rounded-lg transition-colors"
          >
            Reset all data
          </button>
        </section>

      </div>
    </div>
  );
}
