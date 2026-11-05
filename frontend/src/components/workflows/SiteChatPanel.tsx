import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Circle, Loader2, Send } from 'lucide-react';
import type { SiteSummary } from '@shared/types';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { ModelPickerButton } from '../dashboard/ModelPickerButton';
import { AiDisclaimer } from '../shared/AiDisclaimer';
import { CHAT_MODEL_KEY, CHAT_PROVIDER_KEY, CLOUD_DEFAULT_MODEL, CLOUD_DEFAULT_PROVIDER } from '../../utils/chatModel';

// The Workflows tab's chat: you talk to one site (Jimcor), and it knows the
// workflows recorded there — what they ask for, their steps, how recent runs
// went. It explains; it can't run, record or fix anything (those are the
// list's buttons). The site picker lives in its header and also scopes the
// list beside it.
//
// The conversation is kept per site while the app is open; it isn't saved.

export interface PickerSite extends SiteSummary { recordingOnly?: boolean }

interface Turn { role: 'user' | 'assistant'; content: string; failed?: boolean }

export function SiteChatPanel({ sites, current, onChoose }: {
  sites: PickerSite[];
  current: PickerSite | null;
  onChoose: (siteKey: string) => void;
}) {
  const availableModels = useStore((s) => s.availableModels);
  const [provider, setProvider] = useState(() => localStorage.getItem(CHAT_PROVIDER_KEY) ?? CLOUD_DEFAULT_PROVIDER);
  const [model, setModel] = useState(() => localStorage.getItem(CHAT_MODEL_KEY) ?? CLOUD_DEFAULT_MODEL);
  const [threads, setThreads] = useState<Record<string, Turn[]>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const turns = current ? threads[current.siteKey] ?? [] : [];
  // A site with only a recording open has no saved workflows to ask about yet.
  const canAsk = !!current && !current.recordingOnly;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns.length, sending]);

  async function send() {
    const text = input.trim();
    if (!text || sending || !current || !canAsk) return;
    const key = current.siteKey;
    const asked: Turn[] = [...(threads[key] ?? []).filter((t) => !t.failed), { role: 'user', content: text }];
    setThreads((t) => ({ ...t, [key]: asked }));
    setInput('');
    setSending(true);
    try {
      const { reply } = await api.askAboutSite(current.id, asked.map(({ role, content }) => ({ role, content })), provider, model);
      setThreads((t) => ({ ...t, [key]: [...asked, { role: 'assistant', content: reply }] }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setThreads((t) => ({ ...t, [key]: [...asked, {
        role: 'assistant', failed: true,
        content: msg === 'backend unreachable' ? "Couldn't reach NodeBrain. Try again in a moment." : msg || "Couldn't get an answer. Try again.",
      }] }));
    } finally {
      setSending(false);
    }
  }

  return (
    <aside aria-label="Chat about this site" className="h-full flex flex-col border-l border-brain-border bg-brain-surface">
      <div className="px-3 py-2.5 border-b border-brain-border flex-shrink-0">
        {current ? <SitePicker sites={sites} current={current} onChoose={onChoose} />
          : <p className="px-1 py-1.5 text-sm text-brain-text-dim">No site yet</p>}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {!current ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-4">
            <span className="w-10 h-10 rounded-full bg-brain-error/10 border border-brain-error/30 flex items-center justify-center">
              <Circle size={14} className="text-brain-error fill-brain-error" />
            </span>
            <p className="text-sm font-medium text-brain-text mt-3">Nothing recorded yet</p>
            <p className="text-xs text-brain-text-dim mt-1.5 leading-relaxed max-w-[260px]">
              Press Record to walk through a task in your browser. NodeBrain will remember the steps and set up an agent for that site.
            </p>
          </div>
        ) : turns.length === 0 ? (
          <p className="text-xs text-brain-text-dim leading-relaxed">
            {canAsk
              ? `Ask about the workflows recorded on ${current.name}: what they need from you, what each step does, or why one stopped.`
              : `Finish the recording on ${current.name} first, then you can ask about it here.`}
          </p>
        ) : turns.map((t, i) => (
          <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex'}>
            <p className={`max-w-[88%] whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed ${
              t.role === 'user' ? 'bg-brain-accent/15 text-brain-text'
                : t.failed ? 'bg-brain-error/10 text-brain-error' : 'bg-brain-bg border border-brain-border text-brain-text'
            }`}>{t.content}</p>
          </div>
        ))}
        {sending && (
          <p className="flex items-center gap-1.5 text-xs text-brain-text-dim"><Loader2 size={12} className="animate-spin" /> Thinking…</p>
        )}
      </div>

      <div className="px-3 pt-2 pb-2.5 border-t border-brain-border flex-shrink-0">
        <div className="rounded-xl border border-brain-border bg-brain-bg focus-within:border-brain-accent transition-colors">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Ask anything about this project"
            aria-label="Ask anything about this project"
            disabled={!canAsk}
            rows={2}
            className="w-full bg-transparent px-3 pt-2 text-sm text-brain-text placeholder-brain-text-dim resize-none focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-2 pb-2">
            <ModelPickerButton
              provider={provider}
              model={model}
              availableModels={availableModels}
              onChange={(p, m) => {
                localStorage.setItem(CHAT_PROVIDER_KEY, p);
                localStorage.setItem(CHAT_MODEL_KEY, m);
                localStorage.setItem('nb_default_model_chosen', '1');
                setProvider(p);
                setModel(m);
              }}
            />
            <button type="button" onClick={() => void send()} disabled={!input.trim() || sending || !canAsk} aria-label="Send"
              className="ml-auto w-8 h-8 rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors">
              <Send size={14} className="text-white" />
            </button>
          </div>
        </div>
        <AiDisclaimer className="mt-2" />
      </div>
    </aside>
  );
}

// ── The site picker ─────────────────────────────────────────────────────────

function SitePicker({ sites, current, onChoose }: {
  sites: PickerSite[];
  current: PickerSite;
  onChoose: (siteKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}
        className="w-full flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-brain-border/60 transition-colors text-left">
        <SiteIcon icon={current.icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-brain-text truncate">{current.name}</span>
          <span className="block text-xs text-brain-text-dim truncate">{current.siteKey}</span>
        </span>
        <ChevronDown size={15} className="text-brain-text-dim flex-shrink-0" />
      </button>

      {open && (
        <div role="listbox" aria-label="Sites"
          className="absolute z-40 left-0 right-0 mt-1 rounded-xl border border-brain-border bg-brain-surface shadow-2xl py-1.5">
          {sites.map((s) => {
            const isCurrent = s.siteKey === current.siteKey;
            return (
              <button key={s.siteKey} type="button" role="option" aria-selected={isCurrent}
                onClick={() => { onChoose(s.siteKey); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-brain-border/60 transition-colors">
                <SiteIcon icon={s.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-brain-text truncate">{s.name}</span>
                  <span className={`block text-xs truncate ${s.attention ? 'text-brain-warning' : 'text-brain-text-dim'}`}>
                    {s.attention ?? s.siteKey}
                  </span>
                </span>
                {isCurrent && <Check size={15} className="text-brain-accent flex-shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SiteIcon({ icon }: { icon: string }) {
  return (
    <span className="w-8 h-8 rounded-lg bg-brain-bg border border-brain-border flex items-center justify-center text-base flex-shrink-0" aria-hidden="true">
      {icon}
    </span>
  );
}
