import { Loader2 } from 'lucide-react';
import { useStore } from '../../stores/appStore';

export function ConnectionBanner() {
  const backendConnected = useStore((s) => s.backendConnected);

  if (backendConnected) return null;

  return (
    <div className="flex items-center justify-center gap-2 h-7 flex-shrink-0 bg-brain-warning/10 border-b border-brain-warning/30 text-brain-warning text-xs">
      <Loader2 size={12} className="animate-spin" />
      <span>Reconnecting to NodeBrain…</span>
    </div>
  );
}
