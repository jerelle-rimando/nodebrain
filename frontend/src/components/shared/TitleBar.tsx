import { Minus, Square, X } from 'lucide-react';

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

export default function TitleBar() {
  const api = (window as any).electronAPI;
  if (!api) return null;

  return (
    <div
      className="flex items-center justify-between w-full h-9 bg-brain-surface border-b border-brain-border px-3 select-none shrink-0"
      style={drag}
    >
      <div className="flex items-center gap-2">
        <img
          src="/newnodebrainlogodashboard.png"
          alt=""
          className="w-4 h-4 object-contain"
          draggable={false}
        />
        <span className="text-sm font-semibold text-brain-text">NodeBrain</span>
      </div>

      <div className="flex items-center" style={noDrag}>
        <button
          onClick={() => api.windowMinimize()}
          className="flex items-center justify-center w-10 h-9 text-brain-text-dim hover:bg-brain-border hover:text-brain-text transition-colors"
        >
          <Minus size={14} />
        </button>
        <button
          onClick={() => api.windowMaximize()}
          className="flex items-center justify-center w-10 h-9 text-brain-text-dim hover:bg-brain-border hover:text-brain-text transition-colors"
        >
          <Square size={14} />
        </button>
        <button
          onClick={() => api.windowClose()}
          className="flex items-center justify-center w-10 h-9 text-brain-text-dim hover:bg-[#e81123] hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
