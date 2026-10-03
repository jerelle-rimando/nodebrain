import { useEffect, useRef } from 'react';
import { AlertTriangle, FolderOpen } from 'lucide-react';
import type { McpAccessTier, McpAccessWarning } from '@shared/types';

// Per-tier copy. What a server can reach comes from the backend's findings
// (backend/src/utils/mcpAccessRisk.ts); this only frames it.
const REACH_INTRO = 'Based on its command, this server will be able to reach:';

const TIER_COPY: Record<McpAccessTier, { title: string; intro: string; badge: string }> = {
  system: { title: 'This server can reach system-wide files', intro: REACH_INTRO, badge: 'Broad file access' },
  profile: { title: 'This server can reach your whole user folder', intro: REACH_INTRO, badge: 'User folder access' },
  unscoped: { title: 'This server has no clear folder', intro: 'Based on its command:', badge: 'Folder not set' },
};

interface ConfirmDialogProps {
  serverName: string;
  warning: McpAccessWarning;
  onConfirm: () => void;
  onCancel: () => void;
}

export function McpAccessConfirmDialog({ serverName, warning, onConfirm, onCancel }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  // Focus the safe choice so confirming always takes a deliberate click.
  useEffect(() => {
    cancelRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancelRef.current();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-access-title"
        className="relative w-full max-w-md mx-4 bg-brain-surface border border-brain-border rounded-xl shadow-2xl animate-slide-up"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brain-border">
          <div className="w-8 h-8 rounded-lg bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center flex-shrink-0">
            <FolderOpen size={15} className="text-brain-accent" />
          </div>
          <div className="min-w-0">
            <p id="mcp-access-title" className="text-sm font-semibold text-brain-text">
              {TIER_COPY[warning.tier].title}
            </p>
            <p className="text-xs text-brain-text-dim truncate">{serverName}</p>
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-xs text-brain-text-dim">{TIER_COPY[warning.tier].intro}</p>
          <ul className="space-y-2">
            {warning.findings.map((f, i) => (
              <li key={i} className="text-xs text-brain-text bg-brain-bg border border-brain-border rounded-lg p-3">
                {f.description}
              </li>
            ))}
          </ul>
          <p className="text-xs text-brain-text-dim">
            It runs on this computer with your permissions, and any agent with access to its tools can use them.
            If that's what you intend, add it. You can remove it from this list at any time.
          </p>
        </div>

        <div className="flex gap-2 px-5 py-4 border-t border-brain-border">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="flex-1 py-2 text-xs border border-brain-border rounded-lg text-brain-text-dim hover:text-brain-text transition-colors"
          >
            Go back
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2 text-xs bg-brain-accent-deep hover:bg-brain-accent-deep-dim text-white rounded-lg transition-colors"
          >
            Add server
          </button>
        </div>
      </div>
    </div>
  );
}

export function McpAccessBadge({ warning }: { warning: McpAccessWarning }) {
  return (
    <span
      title={warning.findings.map((f) => f.description).join('\n')}
      className="flex items-center gap-1 text-xs text-brain-warning bg-brain-warning/10 border border-brain-warning/30 rounded px-1.5 py-0.5 flex-shrink-0"
    >
      <AlertTriangle size={11} />
      {TIER_COPY[warning.tier].badge}
    </span>
  );
}
