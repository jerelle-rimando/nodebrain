import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronDown, ChevronLeft, CircleDashed, Loader2, Sparkles } from 'lucide-react';
import type { SiteSummary } from '@shared/types';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { ModelPickerButton } from '../dashboard/ModelPickerButton';
import { AiDisclaimer } from '../shared/AiDisclaimer';
import { CHAT_MODEL_KEY, CHAT_PROVIDER_KEY } from '../../utils/chatModel';
import { useAiSetup } from '../../utils/aiSetup';

// The Dashboard's chat: you talk to one site (Jimcor), and it knows the
// workflows recorded there — what they ask for, their steps, how recent runs
// went. It explains; it can't run, record or fix anything (those are the
// list's buttons). The site picker lives in its header and also scopes the
// list beside it, on the right.
//
// The conversation is kept per site while the app is open; it isn't saved.

export interface PickerSite extends SiteSummary { recordingOnly?: boolean }

interface Turn { role: 'user' | 'assistant'; content: string; failed?: boolean }

export function SiteChatPanel({ sites, current, onChoose, onCollapse }: {
  sites: PickerSite[];
  current: PickerSite | null;
  onChoose: (siteKey: string) => void;
  onCollapse: () => void;
}) {
  const availableModels = useStore((s) => s.availableModels);
  const credentials = useStore((s) => s.credentials);
  const local = useAiSetup((s) => s.local);
  const refreshLocal = useAiSetup((s) => s.refreshLocal);
  useEffect(() => { void refreshLocal(); }, [refreshLocal]);

  // The model the chat uses. A pick made here is kept while that AI is still
  // set up. Without one: the local AI when it's installed, else the first AI
  // the person has a key for. With neither there's no AI, and the panel says
  // so instead of showing a model they don't have. The default isn't saved,
  // so setting up local later takes effect.
  const [picked, setPicked] = useState(() => ({
    provider: localStorage.getItem(CHAT_PROVIDER_KEY) ?? '',
    model: localStorage.getItem(CHAT_MODEL_KEY) ?? '',
  }));
  const keyed = credentials.map((c) => c.provider).filter((p) => p in availableModels);
  const localModel = local?.available ? local.model : local?.ownModel;
  const usable = (p: string) => keyed.includes(p) || (p === local?.provider && !!localModel);
  let provider = '';
  let model = '';
  if (picked.provider && picked.model && usable(picked.provider)) {
    ({ provider, model } = picked);
  } else if (local && localModel) {
    provider = local.provider;
    model = localModel;
  } else if (keyed.length > 0) {
    provider = keyed[0];
    model = availableModels[provider]?.[0] ?? '';
  }
  // Still asking whether the local AI is installed.
  const checking = local === undefined && keyed.length === 0;
  const hasAi = !!provider && !!model;
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
      <div className="h-[72px] flex items-center gap-2 px-[22px] flex-shrink-0">
        {current ? <SitePicker sites={sites} current={current} onChoose={onChoose} /> : (
          <p className="flex-1 flex items-center gap-2 text-[15px] font-medium text-brain-text-muted">
            <CircleDashed size={17} aria-hidden="true" />
            No site yet
            <ChevronDown size={15} aria-hidden="true" />
          </p>
        )}
        <button type="button" onClick={onCollapse} aria-label="Hide the chat" title="Hide the chat"
          className="p-1.5 rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border/60 transition-colors flex-shrink-0">
          <ChevronLeft size={16} />
        </button>
      </div>

      {checking ? (
        <div className="flex-1 flex items-center justify-center"><Loader2 size={16} className="animate-spin text-brain-text-dim" /></div>
      ) : !hasAi ? <NoAiState /> : (<>

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
                setPicked({ provider: p, model: m });
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
      </>)}
    </aside>
  );
}

// ── No AI set up ────────────────────────────────────────────────────────────

// In place of the chat when no AI is set up: download the local one here, or
// add a key in the Vault. Workflows don't need either.
function NoAiState() {
  const download = useAiSetup((s) => s.download);
  const startDownload = useAiSetup((s) => s.startDownload);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const running = download.state === 'running';
  const pct = download.total > 0 ? Math.min(100, (download.received / download.total) * 100) : 0;
  const what = download.step === 'engine' ? 'the engine' : 'the AI';

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
      <span className="w-10 h-10 rounded-full bg-brain-accent/10 border border-brain-accent/30 flex items-center justify-center">
        <Sparkles size={16} className="text-brain-accent" />
      </span>
      <h2 className="text-[15px] text-brain-text mt-3">No AI set up yet</h2>
      <p className="text-[13px] text-brain-text-dim mt-1.5 leading-relaxed max-w-sm">
        Download one and you can ask questions about whatever site you're working on. Your workflows run either way.
      </p>

      {running ? (
        <div className="w-full max-w-xs mt-5" role="status">
          <div className="h-1.5 rounded-full bg-brain-border overflow-hidden">
            <div className="h-full bg-brain-accent rounded-full transition-[width] duration-300" style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <p className="text-xs text-brain-text-dim mt-2">
            Downloading {what}{download.total > 0 ? `: ${formatBytes(download.received)} of ${formatBytes(download.total)}` : '…'}
          </p>
          <p className="text-xs text-brain-text-muted mt-1">You can keep working while it downloads.</p>
        </div>
      ) : (
        <>
          {download.state === 'failed' && download.error && (
            <p role="alert" className="text-xs text-brain-error mt-4 max-w-sm">{download.error}</p>
          )}
          <button type="button" onClick={startDownload}
            className="mt-4 px-4 py-2 text-sm rounded-lg bg-brain-accent hover:bg-brain-accent-dim text-white transition-colors">
            {download.state === 'failed' ? 'Try again' : 'Download an AI · 2.5 GB'}
          </button>
          <p className="text-xs text-brain-text-dim mt-5">
            Already have an API key?{' '}
            <button type="button" onClick={() => setActiveTab('vault')} className="text-brain-accent hover:underline underline-offset-2">
              Use that instead
            </button>
          </p>
          <p className="text-[11px] text-brain-text-muted mt-1 max-w-sm">Your prompts go to that provider rather than staying on your machine.</p>
        </>
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

// ── The site picker ─────────────────────────────────────────────────────────

export function SitePicker({ sites, current, onChoose }: {
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
// has none or it won't load. Workflow rows use it too.
export function SiteIcon({ icon, favicon }: { icon: string; favicon?: string }) {
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
