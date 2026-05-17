import { useState } from 'react';
import { ShieldAlert, CheckCircle, XCircle } from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';

export function ApprovalModal() {
  const { pendingApprovals, removePendingApproval, agents } = useStore();
  const [loading, setLoading] = useState(false);

  const current = pendingApprovals[0];
  if (!current) return null;

  const agentName = agents.find((a) => a.id === current.agentId)?.name ?? current.agentId.slice(0, 8);

  async function respond(approved: boolean) {
    setLoading(true);
    try {
      await api.respondToApproval(current.taskId, current.approvalId, approved);
    } catch {
      // backend resolves even if SSE dropped; best-effort
    } finally {
      removePendingApproval(current.approvalId);
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
            <ShieldAlert size={15} className="text-brain-warning" />
          </div>
          <div>
            <p className="text-sm font-semibold text-brain-text">Tool Approval Required</p>
            <p className="text-xs text-brain-text-dim">Agent: {agentName}</p>
          </div>
          {pendingApprovals.length > 1 && (
            <span className="ml-auto text-xs font-mono text-brain-text-dim">
              1 of {pendingApprovals.length}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-3">
          <div>
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-1">Tool</p>
            <p className="text-sm font-mono text-brain-accent">{current.toolName}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-1">Arguments</p>
            <pre className="text-xs text-brain-text bg-brain-bg border border-brain-border rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words">
              {JSON.stringify(current.args, null, 2)}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-brain-border">
          <button
            onClick={() => respond(false)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors"
          >
            <XCircle size={14} />
            Deny
          </button>
          <button
            onClick={() => respond(true)}
            disabled={loading}
            className="flex-1 flex items-center justify-center gap-2 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            <CheckCircle size={14} />
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
