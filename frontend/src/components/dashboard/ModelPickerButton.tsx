import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronUp, Cpu, Search, Sparkles, Zap } from 'lucide-react';
import { SiAnthropic, SiGooglegemini, SiMistralai, SiOllama, SiOpenai } from 'react-icons/si';
import type { IconType } from 'react-icons';

interface Props {
  provider: string;
  model: string;
  availableModels: Record<string, string[]>;
  onChange: (provider: string, model: string) => void;
}

const PROVIDER_ICONS: Record<string, IconType> = {
  openai: SiOpenai,
  gemini: SiGooglegemini,
  google: SiGooglegemini,
  anthropic: SiAnthropic,
  claude: SiAnthropic,
  ollama: SiOllama,
  mistral: SiMistralai,
  groq: Zap,
  together: Cpu,
  fireworks: Sparkles,
};

function ProviderIcon({ provider }: { provider: string }) {
  const Icon = PROVIDER_ICONS[provider.toLowerCase()] ?? Cpu;
  return <Icon size={14} className="text-brain-text-dim flex-shrink-0" />;
}

export function ModelPickerButton({ provider, model, availableModels, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      const target = e.target as Node;
      const insideButton = containerRef.current?.contains(target);
      const insideMenu = menuRef.current?.contains(target);
      if (!insideButton && !insideMenu) {
        setOpen(false);
      }
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onOutsideClick);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery('');
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function updatePosition() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({
        bottom: window.innerHeight - rect.top + 4,
        right: window.innerWidth - rect.right,
      });
    }
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const lowerQuery = query.trim().toLowerCase();
  const groups = Object.entries(availableModels)
    .map(([p, models]) => ({
      provider: p,
      models: models.filter((m) => !lowerQuery || m.toLowerCase().includes(lowerQuery) || p.toLowerCase().includes(lowerQuery)),
    }))
    .filter((g) => g.models.length > 0);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-mono text-brain-text-dim hover:text-brain-text bg-brain-elevated border border-brain-border rounded-md px-2 py-1 transition-colors max-w-[220px]"
      >
        <ProviderIcon provider={provider} />
        <span className="truncate min-w-0 flex-1">{model || 'Select model'}</span>
        <ChevronUp size={12} className={'flex-shrink-0 transition-transform ' + (open ? 'rotate-180' : '')} />
      </button>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{ position: 'fixed', bottom: menuPos.bottom, right: menuPos.right }}
          className="w-72 max-h-80 flex flex-col bg-brain-elevated border border-brain-border rounded-lg shadow-xl z-50 overflow-hidden"
        >
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-brain-border flex-shrink-0">
            <Search size={13} className="text-brain-text-dim flex-shrink-0" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="flex-1 bg-transparent text-xs text-brain-text placeholder-brain-text-dim focus:outline-none"
            />
          </div>
          <div className="overflow-y-auto py-1">
            {groups.length === 0 && (
              <p className="text-xs text-brain-text-dim px-3 py-3 text-center">No models found</p>
            )}
            {groups.map((g) => (
              <div key={g.provider} className="mb-1 last:mb-0">
                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-brain-text-muted">
                  {g.provider}
                </p>
                {g.models.map((m) => {
                  const active = g.provider === provider && m === model;
                  return (
                    <button
                      key={`${g.provider}:${m}`}
                      type="button"
                      onClick={() => {
                        onChange(g.provider, m);
                        setOpen(false);
                      }}
                      className={
                        'w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs font-mono transition-colors ' +
                        (active
                          ? 'text-brain-accent bg-brain-accent/10'
                          : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border')
                      }
                    >
                      <ProviderIcon provider={g.provider} />
                      <span className="truncate">{m}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
