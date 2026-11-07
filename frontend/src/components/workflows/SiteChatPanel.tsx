import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, CircleDashed, Loader2 } from 'lucide-react';
import type { SiteSummary } from '@shared/types';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { ModelPickerButton } from '../dashboard/ModelPickerButton';
import { AiDisclaimer } from '../shared/AiDisclaimer';
import { CHAT_MODEL_KEY, CHAT_PROVIDER_KEY, CLOUD_DEFAULT_MODEL, CLOUD_DEFAULT_PROVIDER } from '../../utils/chatModel';

// The Dashboard's chat: you talk to one site (Jimcor), and it knows the
// workflows recorded there — what they ask for, their steps, how recent runs
// went. It explains; it can't run, record or fix anything (those are the
// list's buttons). The site picker lives in its header and also scopes the
// list beside it, on the right.
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
  // A model picked here is kept. Without one, the composer stays blank for the
  // moment it takes to ask whether the local engine is installed, then shows
  // the local model, or the cloud one when there's no local engine. That
  // default isn't saved, so installing local later takes effect.
  const [provider, setProvider] = useState(() => localStorage.getItem(CHAT_PROVIDER_KEY) ?? '');
  const [model, setModel] = useState(() => localStorage.getItem(CHAT_MODEL_KEY) ?? '');
  useEffect(() => {
    if (localStorage.getItem(CHAT_MODEL_KEY)) return;
    let cancelled = false;
    const use = (p: string, m: string) => { if (!cancelled) { setProvider(p); setModel(m); } };
    api.getLocalEngineStatus()
      .then((status) => status.available ? use(status.provider, status.model) : use(CLOUD_DEFAULT_PROVIDER, CLOUD_DEFAULT_MODEL))
      .catch(() => use(CLOUD_DEFAULT_PROVIDER, CLOUD_DEFAULT_MODEL));
    return () => { cancelled = true; };
  }, []);
  const [threads, setThreads] = useState<Record<string, Turn[]>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Text handed over from a stopped workflow's "ask the agent": it goes in
  // the box for the person to read and send.
  const chatDraft = useStore((s) => s.chatDraft);
  const setChatDraft = useStore((s) => s.setChatDraft);
  useEffect(() => {
    if (!chatDraft) return;
    setInput(chatDraft);
    setChatDraft(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [chatDraft, setChatDraft]);

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
    <aside aria-label="Chat about this site" className="h-full flex flex-col bg-brain-surface">
      <div className="h-[72px] flex items-center px-[22px] flex-shrink-0">
        {current ? <SitePicker sites={sites} current={current} onChoose={onChoose} /> : (
          <p className="flex items-center gap-2 text-[15px] font-medium text-brain-text-muted">
            <CircleDashed size={17} aria-hidden="true" />
            No site yet
            <ChevronDown size={15} aria-hidden="true" />
          </p>
        )}
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-[22px] py-4 space-y-3">
        {!current ? null : turns.length === 0 ? (
          // Empty until the first question. A site with only a recording
          // open says why the box is off.
          canAsk ? null : (
            <p className="text-xs text-brain-text-dim leading-relaxed">
              Finish the recording on {current.name} first, then you can ask about it here.
            </p>
          )
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

      <div className="px-[22px] pt-2 pb-3 flex-shrink-0">
        <div className="rounded-xl border border-brain-border bg-brain-bg focus-within:border-brain-accent transition-colors">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder="Ask anything about this site"
            aria-label="Ask anything about this site"
            disabled={!canAsk}
            rows={2}
            className="w-full bg-transparent px-3 pt-2.5 text-sm text-brain-text placeholder-brain-text-muted resize-none focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 pl-3 pr-2 pb-2">
            <ModelPickerButton
              plain
              provider={provider}
              model={model}
              availableModels={availableModels}
              onChange={(p, m) => {
                localStorage.setItem(CHAT_PROVIDER_KEY, p);
                localStorage.setItem(CHAT_MODEL_KEY, m);
                setProvider(p);
                setModel(m);
              }}
            />
            <button type="button" onClick={() => void send()} disabled={!input.trim() || sending || !canAsk} aria-label="Send"
              className="ml-auto w-[42px] h-[38px] rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors flex-shrink-0">
              <ArrowUp size={18} className="text-white" />
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
    <div ref={ref} className="relative flex-1 min-w-0">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}
        className="w-full flex items-center gap-2.5 rounded-lg px-1.5 py-0.5 hover:bg-brain-border/60 transition-colors text-left">
        <SiteIcon icon={current.icon} favicon={current.favicon} />
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
                <SiteIcon icon={s.icon} favicon={s.favicon} />
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

// The site's own favicon (saved while recording there); the emoji when it
// has none or it won't load.
function SiteIcon({ icon, favicon }: { icon: string; favicon?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  const showImage = !!favicon && broken !== favicon;
  return (
    <span className="w-8 h-8 rounded-lg bg-brain-bg border border-brain-border flex items-center justify-center text-base flex-shrink-0" aria-hidden="true">
      {showImage
        ? <img src={favicon} alt="" className="w-[18px] h-[18px] object-contain" onError={() => setBroken(favicon)} />
        : icon}
    </span>
  );
}
