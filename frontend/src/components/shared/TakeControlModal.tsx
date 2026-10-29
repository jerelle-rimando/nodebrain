import { useState } from 'react';
import { Hand, Play, Square } from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';

// Take Control: the agent is paused and the person finishes a step in the browser
// window (a code, a CAPTCHA). Everything here is read by non-technical users, so it
// shows plain words only: no tool names, no technical detail.
export function TakeControlModal() {
  const { pendingTakeControls, removePendingTakeControl, agents } = useStore();
  const [loading, setLoading] = useState(false);

  const current = pendingTakeControls[0];
  if (!current) return null;

  const agentName = agents.find((a) => a.id === current.agentId)?.name ?? 'Your agent';

  async function respond(done: boolean) {
    setLoading(true);
    try {
      await api.respondToTakeControl(current.taskId, current.requestId, done);
    } catch {
      // backend resolves even if SSE dropped; best-effort
    } finally {
      removePendingTakeControl(current.requestId);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Dialog */}
      <div className="relative w-full max-w-md mx-4 bg-brain-surface border border-brain-border rounded-xl shadow-2xl animate-slide-up">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brain-border">
          <div className="w-8 h-8 rounded-lg bg-brain-warning/10 border border-brain-warning/30 flex items-center justify-center flex-shrink-0">
            <Hand size={15} className="text-brain-warning" />
          </div>
          <div>
            <p className="text-sm font-semibold text-brain-text">Your turn in the browser</p>
            <p className="text-xs text-brain-text-dim">{agentName} is paused and waiting for you</p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-brain-text">{current.reason}</p>
          <p className="text-xs text-brain-text-dim">
            Switch to the browser window NodeBrain opened and do this step yourself.
            When you're finished, come back here and click Done. The agent picks up from there.
          </p>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-brain-border">
          <button
            onClick={() => respond(false)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors"
          >
            <Square size={14} />
            Stop the task
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
