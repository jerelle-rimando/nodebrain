import { useEffect, useRef } from 'react';

// Curated, offline, zero-dependency emoji set for agent identities. No CDN, no
// runtime data fetch — just a fixed list rendered as a grid.
export const AGENT_EMOJIS: readonly string[] = [
  '🤖', '🧠', '✨', '⚡', '🚀', '🎯', '🧩', '♟️',
  '📄', '📝', '📋', '📑', '📊', '📈', '📉', '🧮',
  '📁', '📂', '🗂️', '🗃️', '🗄️', '📦', '🏷️', '📌',
  '💬', '📧', '📨', '📥', '📤', '✉️', '📣', '📢',
  '🔍', '🔎', '🌐', '🧭', '🗺️', '📡', '🛰️', '🔗',
  '📅', '📆', '🗓️', '⏰', '⏱️', '⌛', '⏳', '🕒',
  '🔔', '🚨', '⚠️', '✅', '🛡️', '🔒', '🔑', '👁️',
  '💻', '🖥️', '⌨️', '🐙', '🔧', '🛠️', '⚙️', '🧰',
  '🧪', '🧬', '🩺', '📚', '📖', '💡', '🪄', '🧵',
  '💰', '🧾', '🛒', '🏦', '🌤️', '🗞️', '🎲', '🦾',
];

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Extra classes for positioning the popover relative to its trigger. */
  className?: string;
}

/**
 * Small popover grid. Render inside a `position: relative` container next to the
 * trigger. Closes on outside click or Escape.
 */
export function EmojiPicker({ onSelect, onClose, className = '' }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      className={
        'absolute z-50 mt-2 w-64 rounded-xl border border-brain-border bg-brain-surface p-2 shadow-2xl ' +
        className
      }
    >
      <div className="grid grid-cols-8 gap-1 max-h-56 overflow-y-auto">
        {AGENT_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => {
              onSelect(emoji);
              onClose();
            }}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none hover:bg-brain-border transition-colors"
          >
            <span aria-hidden>{emoji}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
