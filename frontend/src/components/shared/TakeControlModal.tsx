import { useState } from 'react';
import { Hand, Play, Square } from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';

// Take Control: NodeBrain is paused and the person does a step in the browser
// window (a one-time code, a check before submitting). Read by non-technical
// users, so plain words only: no step keys, no selectors, no technical detail.
// Ported from the spike/playwright-biberk agent handover; answers go to the
// shared /api/take-control endpoint.
export function TakeControlModal() {
  const { pendingTakeControls, removePendingTakeControl, agents } = useStore();
  const [loading, setLoading] = useState(false);

  // Agent tasks only. A workflow run's pause is answered in its run view
  // (the banner's Done), reached from Continue on its row in the Workflows list.
  const shown = pendingTakeControls.find((r) => !r.runId);
  if (!shown) return null;
  const current = shown;

  const who = current.title
    || agents.find((a) => a.id === current.agentId)?.name
    || 'NodeBrain';

  async function respond(done: boolean) {
    setLoading(true);
    try {
      await api.respondToTakeControl(current.requestId, done);
    } catch {
      // Already answered elsewhere or the run ended; the dialog closes either way.
    } finally {
      removePendingTakeControl(current.requestId);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative w-full max-w-md mx-4 bg-brain-surface border border-brain-border rounded-xl shadow-2xl animate-slide-up">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brain-border">
          <div className="w-8 h-8 rounded-lg bg-brain-warning/10 border border-brain-warning/30 flex items-center justify-center flex-shrink-0">
            <Hand size={15} className="text-brain-warning" />
          </div>
          <div>
            <p className="text-sm font-semibold text-brain-text">Your turn in the browser</p>
            <p className="text-xs text-brain-text-dim">{who} is paused and waiting for you</p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-brain-text">{current.reason}</p>
          <p className="text-xs text-brain-text-dim">
            Switch to the browser window NodeBrain opened. When you're finished there,
            come back here and click Done. NodeBrain picks up from there.
          </p>
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-brain-border">
          <button
            onClick={() => respond(false)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors"
          >
            <Square size={14} />
            Stop
          </button>
          <button
            onClick={() => respond(true)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            <Play size={14} />
            Done, continue
          </button>
        </div>
      </div>
    </div>
  );
}
