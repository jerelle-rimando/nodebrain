import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { Send, Bot, User, Loader2, Zap, ArrowLeft, ArrowDown, PanelRightOpen, PanelRightClose, X, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import type { Agent, ChatMessage } from '@shared/types';
import { ModelSelect } from '../ModelSelect';
import { ModelPickerButton } from './ModelPickerButton';
import { EmojiPicker } from './EmojiPicker';
import { LogsPanel } from '../shared/LogsPanel';
import { useSmoothedStream } from '../../hooks/useSmoothedStream';
import { useRightPanel, type DotState } from '../../hooks/useRightPanel';

type ChatMode = 'chat' | 'agent';

// Right column is now just the Active Agents + Live Logs stack (w-72 = 288).
// Execution Logs moved to an on-demand overlay opened from Live Logs.
const RIGHT_PANEL_WIDTH = 288;

// Sticky-bottom threshold: while the chat is scrolled to within this many px of
// the bottom, streamed tokens and new messages keep the newest content in view.
// Scrolled further up than this, auto-follow disengages until the user returns.
const NEAR_BOTTOM_PX = 100;

const DOT_BG: Record<Exclude<DotState, null>, string> = {
  error: 'bg-brain-error',
  approval: 'bg-brain-warning',
  running: 'bg-brain-accent',
  success: 'bg-brain-success',
};

const DOT_TITLE: Record<Exclude<DotState, null>, string> = {
  error: 'A task failed since you last opened this panel',
  approval: 'A task is awaiting approval',
  running: 'A task is running',
  success: 'A task completed since you last opened this panel',
};

// Assistant messages are Markdown. react-markdown builds a React element tree
// (no dangerouslySetInnerHTML) and rehype-raw is deliberately NOT installed, so
// any literal HTML in model output renders as inert text — that's the XSS guard.
// Links are forced to open in a new tab so they never navigate the app away.
function MarkdownMessage({ content }: { content: string }) {
  return (
    <div className="chat-content leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

// Shown beneath a Chat-mode reply when the backend detected an unambiguous
// agent-creation request. Chat mode stays non-acting; this points the user at
// the toggle that would actually build it. Styled distinctly (brain-accent) so
// it reads as app guidance, not part of the model's response.
function AgentModeHint() {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 flex-shrink-0" />
      <div className="max-w-[80%] flex items-start gap-2 rounded-lg border border-brain-accent/30 bg-brain-accent/10 px-3 py-2 text-xs text-brain-accent">
        <Sparkles size={13} className="flex-shrink-0 mt-0.5" />
        <span>
          It looks like you want to build an agent — switch to <strong>Agent</strong> mode
          with the Chat / Agent toggle below the message box, then send that again and I'll
          create it for you.
        </span>
      </div>
    </div>
  );
}

export function Dashboard() {
  const { chatMessages, setChatMessages, addChatMessage, agents, logs, updateAgent: storeUpdateAgent, availableModels, chatPhase, setChatPhase } = useStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [streamingRequestId, setStreamingRequestId] = useState<string | null>(null);
  // Id of the assistant message that should show the "switch to Agent mode"
  // nudge beneath it. Transient — set when the backend flags a Chat-mode
  // creation request, cleared on the next send.
  const [agentModeHintFor, setAgentModeHintFor] = useState<string | null>(null);
  const { displayedText: streamingText, flush: flushStream } = useSmoothedStream(streamingRequestId);
  const logsMarkRef = useRef(0);
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [agentMessages, setAgentMessages] = useState<Record<string, ChatMessage[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  // True while the view is pinned to the bottom. The streaming path reads this
  // ref (not state) so a ~60/s token cadence doesn't trigger re-renders;
  // `awayFromBottom` mirrors it only to drive the "jump to latest" button.
  const stickToBottomRef = useRef(true);
  const scrollTickRef = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [defaultProvider, setDefaultProvider] = useState<string>(() => localStorage.getItem('nb_default_provider') ?? 'groq');
  const [defaultModel, setDefaultModel] = useState<string>(() => localStorage.getItem('nb_default_model') ?? 'openai/gpt-oss-120b');
  const [chatMode, setChatMode] = useState<ChatMode>(() => (localStorage.getItem('nb_chat_mode') as ChatMode) ?? 'chat');
  const { collapsed: rightCollapsed, toggle: toggleRight, dotState, pulsing } = useRightPanel(logs);
  // Transient view only — never persisted, always starts closed on load.
  const [showLogsOverlay, setShowLogsOverlay] = useState(false);

  // Collapsing the right column also dismisses the overlay.
  useEffect(() => {
    if (rightCollapsed) setShowLogsOverlay(false);
  }, [rightCollapsed]);

  // Close the overlay on Escape while it's open.
  useEffect(() => {
    if (!showLogsOverlay) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setShowLogsOverlay(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showLogsOverlay]);

  useEffect(() => { localStorage.setItem('nb_default_provider', defaultProvider); }, [defaultProvider]);
  useEffect(() => { localStorage.setItem('nb_default_model', defaultModel); }, [defaultModel]);
  useEffect(() => { localStorage.setItem('nb_chat_mode', chatMode); }, [chatMode]);

  // Auto-grow the composer textarea with content, capped at maxHeight so row 2
  // (mode toggle + send) gets pushed down instead of the box scrolling internally.
  useEffect(() => {
    if (selectedAgent) return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input, selectedAgent]);

  // One-time migration: llama-3.3-70b-versatile was decommissioned on Groq.
  // Users with that stale value already persisted in localStorage need it
  // overwritten; a deliberate choice of any other model is left untouched.
  useEffect(() => {
    if (localStorage.getItem('nb_default_model') === 'llama-3.3-70b-versatile') {
      setDefaultModel('openai/gpt-oss-120b');
    }
  }, []);

  useEffect(() => {
    api.getChatHistory().then((messages) => {
      setChatMessages(messages.filter((m) => !m.agentId));
      const byAgent: Record<string, ChatMessage[]> = {};
      messages
        .filter((m) => m.agentId)
        .forEach((m) => {
          if (!byAgent[m.agentId!]) byAgent[m.agentId!] = [];
          byAgent[m.agentId!].push(m);
        });
      setAgentMessages(byAgent);
    }).catch(console.error);
  }, [setChatMessages]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    stickToBottomRef.current = true;
    setAwayFromBottom(false);
  }, []);

  // rAF-throttled: a wheel/touch scroll fires this repeatedly per gesture, but
  // one measurement per frame is enough. Reads scroll position only — never
  // writes it — so it can't fight the browser's overflow-anchor scroll
  // anchoring during the right-panel collapse/expand reflow.
  const handleChatScroll = useCallback(() => {
    if (scrollTickRef.current !== null) return;
    scrollTickRef.current = requestAnimationFrame(() => {
      scrollTickRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = distance <= NEAR_BOTTOM_PX;
      stickToBottomRef.current = near;
      setAwayFromBottom(!near);
    });
  }, []);

  useEffect(() => () => {
    if (scrollTickRef.current !== null) cancelAnimationFrame(scrollTickRef.current);
  }, []);

  // Switching between the main chat and an agent thread starts pinned to newest.
  useEffect(() => {
    scrollChatToBottom('auto');
    setShowEmojiPicker(false);
  }, [selectedAgent, scrollChatToBottom]);

  // A new message landed (user send, or the finalized assistant reply) — follow
  // it down only if the user was already at the bottom.
  useEffect(() => {
    if (stickToBottomRef.current) scrollChatToBottom('smooth');
  }, [chatMessages, agentMessages, scrollChatToBottom]);

  // Streamed tokens: keep the tail in view while pinned. This runs at the
  // smoothing buffer's rAF cadence; a bare scrollTop assignment is cheap and
  // 'auto' (not 'smooth') avoids queuing an animation on every frame.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamingText]);

  // While a request is in flight, surface the latest relevant SSE log
  // (tool calls, agent activity) as an in-progress status line.
  useEffect(() => {
    if (!sending) return;
    if (logs.length <= logsMarkRef.current) return;
    logsMarkRef.current = logs.length;
    const latest = logs[logs.length - 1];
    if (latest) setStatusText(latest.message);
  }, [logs, sending]);

  async function handleSend() {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setStatusText(null);
    setChatPhase(null);
    setAgentModeHintFor(null);
    logsMarkRef.current = logs.length;
    setSending(true);
    let requestId: string | null = null;

    try {
      if (selectedAgent) {
        const userMsg: ChatMessage = {
          id: Date.now().toString(),
          role: 'user',
          content: text,
          timestamp: new Date().toISOString(),
          agentId: selectedAgent.id,
        };
        setAgentMessages((prev) => ({
          ...prev,
          [selectedAgent.id]: [...(prev[selectedAgent.id] ?? []), userMsg],
        }));

        const result = await api.executeAgent(selectedAgent.id, text);
        const assistantMsg: ChatMessage = {
          id: (Date.now() + 1).toString(),
          role: 'assistant',
          content: result.message ?? '(no response)',
          timestamp: new Date().toISOString(),
          agentId: selectedAgent.id,
        };
        setAgentMessages((prev) => ({
          ...prev,
          [selectedAgent.id]: [...(prev[selectedAgent.id] ?? []), assistantMsg],
        }));
        api.saveMessages([userMsg, assistantMsg]).catch(console.error);
      } else {
        const userMsg: ChatMessage = {
          id: Date.now().toString(),
          role: 'user',
          content: text,
          timestamp: new Date().toISOString(),
        };
        addChatMessage(userMsg);

        requestId = crypto.randomUUID();
        setStreamingRequestId(requestId);

        const { assistantMessage, suggestAgentMode } = await api.sendChatMessage(text, requestId, {
          mode: chatMode,
          provider: defaultProvider,
          model: defaultModel,
        });
        addChatMessage(assistantMessage);
        if (suggestAgentMode) setAgentModeHintFor(assistantMessage.id);
      }
    } catch (err) {
      const errorMsg: ChatMessage = {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'Error: ' + (err instanceof Error ? err.message : 'Unknown error'),
        timestamp: new Date().toISOString(),
      };
      if (selectedAgent) {
        setAgentMessages((prev) => ({
          ...prev,
          [selectedAgent.id]: [...(prev[selectedAgent.id] ?? []), errorMsg],
        }));
      } else {
        addChatMessage(errorMsg);
      }
    } finally {
      // Drain any text still sitting in the pending buffer immediately so the
      // last words don't keep trickling in after the real response is known.
      if (requestId) flushStream();
      setStreamingRequestId(null);
      setSending(false);
      setStatusText(null);
      setChatPhase(null);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeMessages = selectedAgent
    ? (agentMessages[selectedAgent.id] ?? [])
    : chatMessages;

  const recentLogs = logs.slice(-5);

  // Placeholder shown before the first token / log line arrives. If the backend
  // has signalled this request was routed to agent creation, say "Creating…";
  // otherwise fall back to the generic "Thinking…" (Chat mode, and any
  // non-creation path). A real streamed log line in `statusText` still wins.
  const fallbackStatus =
    chatPhase?.requestId === streamingRequestId && chatPhase?.phase === 'creating'
      ? 'Creating…'
      : 'Thinking…';

  const placeholder = selectedAgent
    ? 'Ask ' + selectedAgent.name + ' anything...'
    : chatMode === 'agent'
      ? 'Describe an agent, or give one a task…'
      : 'Ask NodeBrain anything…';

  async function handleEmojiSelect(emoji: string) {
    if (!selectedAgent) return;
    try {
      const updated = await api.updateAgent(selectedAgent.id, { emoji });
      storeUpdateAgent(updated);
      setSelectedAgent(updated);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <div className="flex h-full p-4">
      <div className="relative flex flex-col flex-1 min-w-0 rounded-xl border border-brain-border bg-brain-surface overflow-hidden">

        <div className="flex items-center gap-3 px-4 py-3 border-b border-brain-border">
          {selectedAgent ? (
            <>
              <button
                onClick={() => setSelectedAgent(null)}
                className="w-6 h-6 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors flex-shrink-0"
              >
                <ArrowLeft size={13} />
              </button>
              <div className="relative flex-shrink-0">
                <button
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  title="Change agent emoji"
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none border border-brain-border bg-brain-bg hover:border-brain-muted transition-colors"
                >
                  <span aria-hidden>{selectedAgent.emoji ?? '🤖'}</span>
                </button>
                {showEmojiPicker && (
                  <EmojiPicker
                    onSelect={handleEmojiSelect}
                    onClose={() => setShowEmojiPicker(false)}
                    className="left-0"
                  />
                )}
              </div>
              <div
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{
                  backgroundColor:
                    selectedAgent.status === 'running' ? '#6366f1' :
                    selectedAgent.status === 'error' ? '#ef4444' :
                    '#22c55e',
                }}
              />
              <h2 className="text-sm font-semibold text-brain-text truncate">{selectedAgent.name}</h2>
              {selectedAgent.config.dryRun && (
                <span className="flex-shrink-0 bg-yellow-500/10 border border-yellow-500/40 text-yellow-400 rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide">
                  DRY-RUN
                </span>
              )}
              <ModelSelect
                provider={selectedAgent.provider}
                model={selectedAgent.model}
                availableModels={availableModels}
                onChange={async (model) => {
                  try {
                    const updated = await api.updateAgent(selectedAgent.id, { model });
                    storeUpdateAgent(updated);
                    setSelectedAgent(updated);
                  } catch (err) {
                    console.error(err);
                  }
                }}
                className="ml-auto"
              />
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-brain-success animate-pulse-slow" />
              <h2 className="text-sm font-semibold text-brain-text">Agent Studio</h2>
              <span className="ml-auto text-xs text-brain-text-dim font-mono">
                {agents.length} active
              </span>
            </>
          )}
        </div>

        <div ref={scrollRef} onScroll={handleChatScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
          {activeMessages.length === 0 && !selectedAgent && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4 py-16">
              <div className="w-16 h-16 rounded-2xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center">
                <Zap size={28} className="text-brain-accent" />
              </div>
              <div>
                <h3 className="text-brain-text font-semibold mb-2">Create your first agent</h3>
                <p className="text-brain-text-dim text-sm max-w-xs">
                Describe what you want an agent to do. Connect integrations to give it real tools — file access, messaging, code, and more.
                </p>
              </div>
              <div className="space-y-2 text-left w-full max-w-sm">
                {[
                  'Create a file manager agent that reads and summarizes my local documents',
                  'Build a Telegram agent that sends me a daily briefing every morning at 9am',
                  'Make a GitHub agent that monitors my repos and summarizes new issues',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="w-full text-left text-xs text-brain-text-dim hover:text-brain-text bg-brain-bg hover:bg-brain-border border border-brain-border rounded-lg px-3 py-2 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {activeMessages.length === 0 && selectedAgent && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-3 py-16">
              <div className="w-12 h-12 rounded-xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center text-3xl leading-none">
                {selectedAgent.emoji
                  ? <span aria-hidden>{selectedAgent.emoji}</span>
                  : <Bot size={22} className="text-brain-accent" />}
              </div>
              <div>
                <h3 className="text-brain-text font-semibold mb-1">{selectedAgent.name}</h3>
                <p className="text-brain-text-dim text-xs max-w-xs">{selectedAgent.description}</p>
              </div>
              <p className="text-xs text-brain-text-dim">Ask this agent anything or give it a task</p>
            </div>
          )}

          {activeMessages.map((msg) => (
            <Fragment key={msg.id}>
              <MessageBubble message={msg} />
              {!selectedAgent && agentModeHintFor === msg.id && <AgentModeHint />}
            </Fragment>
          ))}

          {sending && (
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-lg bg-brain-accent/20 flex items-center justify-center flex-shrink-0">
                <Bot size={14} className="text-brain-accent" />
              </div>
              {streamingText ? (
                <div className="max-w-[80%] bg-brain-bg border border-brain-border rounded-xl px-4 py-3 text-sm text-brain-text-dim">
                  <MarkdownMessage content={streamingText} />
                </div>
              ) : (
                <div className="bg-brain-bg border border-brain-border rounded-xl px-4 py-3 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-brain-text-dim flex-shrink-0" />
                  <span className="text-sm text-brain-text-dim">{statusText ?? fallbackStatus}</span>
                </div>
              )}
            </div>
          )}

        </div>

        {/* Re-engage auto-follow with one click when the user has scrolled up
            while a response is still streaming in. */}
        {awayFromBottom && sending && (
          <button
            type="button"
            onClick={() => scrollChatToBottom('smooth')}
            className="absolute left-1/2 bottom-20 z-20 -translate-x-1/2 flex items-center gap-1.5 rounded-full bg-brain-accent px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-brain-accent/30 hover:bg-brain-accent-dim transition-colors"
          >
            <ArrowDown size={13} />
            Jump to latest
          </button>
        )}

        <div className="p-3 border-t border-brain-border">
          {selectedAgent ? (
            <div className="flex gap-2 items-end">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                rows={1}
                className="flex-1 bg-brain-bg border border-brain-border rounded-lg px-3 py-2.5 text-sm text-brain-text placeholder-brain-text-dim resize-none focus:outline-none focus:border-brain-accent transition-colors font-sans"
                style={{ minHeight: '40px', maxHeight: '120px' }}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || sending}
                className="flex-shrink-0 w-10 h-10 rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
              >
                <Send size={15} className="text-white" />
              </button>
            </div>
          ) : (
            <div className="rounded-xl border border-brain-border bg-brain-bg focus-within:border-brain-accent transition-colors overflow-hidden">
              <div className="flex items-start gap-2 px-2.5 pt-2">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={placeholder}
                  rows={1}
                  className="flex-1 bg-transparent py-1 text-sm text-brain-text placeholder-brain-text-dim resize-none focus:outline-none font-sans"
                  style={{ minHeight: '28px', maxHeight: '160px' }}
                />
                <div className="flex-shrink-0">
                  <ModelPickerButton
                    provider={defaultProvider}
                    model={defaultModel}
                    availableModels={availableModels}
                    onChange={(p, m) => {
                      setDefaultProvider(p);
                      setDefaultModel(m);
                    }}
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-2.5 pt-1 pb-2">
                <div className="flex items-center rounded-md border border-brain-border overflow-hidden text-xs font-medium flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setChatMode('chat')}
                    className={
                      'px-2.5 py-1 transition-colors ' +
                      (chatMode === 'chat'
                        ? 'bg-brain-accent text-white'
                        : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border')
                    }
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={() => setChatMode('agent')}
                    className={
                      'px-2.5 py-1 transition-colors ' +
                      (chatMode === 'agent'
                        ? 'bg-brain-accent text-white'
                        : 'text-brain-text-dim hover:text-brain-text hover:bg-brain-border')
                    }
                  >
                    Agent
                  </button>
                </div>
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || sending}
                  className="flex-shrink-0 w-8 h-8 rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                >
                  <Send size={14} className="text-white" />
                </button>
              </div>
            </div>
          )}
        </div>

        {/*
          Execution Logs overlay — a transient view slid in over the chat area
          from the Live Logs "See all" control. Not a persistent column: no
          stored open-state, and it closes on the scrim, Escape, its own close
          button, or the right column collapsing. LogsPanel is used verbatim;
          the wrapper just relocates it and gives it far more width so tool
          names like telegram__SEND_MESSAGE aren't truncated.
        */}
        <div
          className={
            'absolute inset-0 z-30 transition-opacity duration-200 ease-in-out ' +
            (showLogsOverlay ? 'opacity-100' : 'opacity-0 pointer-events-none')
          }
          aria-hidden={!showLogsOverlay}
        >
          {/* Scrim — dims the chat and reads as "temporary"; click to dismiss. */}
          <div
            className="absolute inset-0 bg-brain-bg/70"
            onClick={() => setShowLogsOverlay(false)}
          />
          {/* Sliding panel */}
          <div
            role="dialog"
            aria-label="Execution logs"
            className={
              'absolute inset-y-0 right-0 w-[min(560px,85%)] flex flex-col bg-brain-surface ' +
              'border-l border-brain-border shadow-2xl transition-transform duration-200 ease-in-out ' +
              (showLogsOverlay ? 'translate-x-0' : 'translate-x-full')
            }
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-brain-border flex-shrink-0">
              <span className="text-[10px] text-brain-text-muted uppercase tracking-wider">Esc to close</span>
              <button
                onClick={() => setShowLogsOverlay(false)}
                aria-label="Close execution logs"
                className="w-6 h-6 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              <LogsPanel />
            </div>
          </div>
        </div>
      </div>

      {/*
        Collapsible right region — Active Agents + Live Logs, hidden together.
        Only `width`/`margin` animate; the inner column keeps a fixed width
        (flex-shrink-0) and is clipped by overflow-hidden, so nothing reflows
        visibly during the transition.
      */}
      <div
        className="flex min-h-0 overflow-hidden transition-[width,margin] duration-200 ease-in-out"
        style={{
          width: rightCollapsed ? 0 : RIGHT_PANEL_WIDTH,
          marginLeft: rightCollapsed ? 0 : 16,
        }}
        aria-hidden={rightCollapsed}
      >
      <div className="w-72 flex flex-col gap-4 flex-shrink-0 min-h-0">
        <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex-1 flex flex-col min-h-0">
          <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-3 flex-shrink-0">Active Agents</h3>
          {agents.length === 0 ? (
            <p className="text-xs text-brain-text-dim text-center py-4">No agents yet</p>
          ) : (
            <div className="space-y-2 overflow-y-auto flex-1 min-h-0">
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  onClick={() => setSelectedAgent(agent)}
                  className={
                    'w-full flex items-center gap-2 p-2 rounded-lg border transition-all text-left ' + (
                      selectedAgent?.id === agent.id
                        ? 'border-brain-accent/40 bg-brain-accent/10'
                        : 'border-brain-border bg-brain-bg hover:border-brain-muted hover:bg-brain-border'
                    )
                  }
                >
                  <span className="text-base leading-none flex-shrink-0" aria-hidden>{agent.emoji ?? '🤖'}</span>
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor:
                        agent.status === 'running' ? '#6366f1' :
                        agent.status === 'error' ? '#ef4444' :
                        agent.status === 'stopped' ? '#94a3b8' :
                        '#22c55e',
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-brain-text truncate">{agent.name}</p>
                    <p className="text-xs text-brain-text-dim capitalize">{agent.status}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Live Logs */}
        <div className="rounded-xl border border-brain-border bg-brain-surface p-4 h-48">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider">Live Logs</h3>
            <button
              onClick={() => setShowLogsOverlay(true)}
              className="text-xs font-medium text-brain-accent hover:text-brain-accent-dim transition-colors"
            >
              See all
            </button>
          </div>
          <div className="space-y-1 overflow-y-auto h-32">
            {recentLogs.length === 0 ? (
              <p className="text-xs text-brain-text-dim">No activity yet</p>
            ) : (
              recentLogs.map((log) => (
                <div key={log.id} className="flex gap-2 text-xs group overflow-hidden">
                  <span className={
                    'flex-shrink-0 font-mono ' + (
                      log.level === 'error' ? 'text-brain-error' :
                      log.level === 'warn' ? 'text-brain-warning' :
                      'text-brain-text-dim'
                    )
                  }>
                    [{log.level}]
                  </span>
                  <div className="flex-1 overflow-hidden">
                    <span
                      className="text-brain-text-dim whitespace-nowrap inline-block max-w-full group-hover:animate-marquee"
                    >
                      {log.message}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      </div>

      {/* Right rail — always visible; holds the collapse toggle and, when
          collapsed, a small activity dot derived from task-log status. */}
      <div
        className={
          'flex-shrink-0 w-[34px] ml-2 flex flex-col items-center py-3 rounded-xl border border-brain-border bg-brain-surface ' +
          (pulsing ? 'animate-rail-alert' : '')
        }
      >
        <button
          onClick={toggleRight}
          title={rightCollapsed ? 'Expand panel' : 'Collapse panel'}
          aria-label={rightCollapsed ? 'Expand right panel' : 'Collapse right panel'}
          aria-expanded={!rightCollapsed}
          className="relative w-7 h-7 rounded-lg flex items-center justify-center text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors"
        >
          {rightCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
          {rightCollapsed && dotState && (
            <span
              title={DOT_TITLE[dotState]}
              className={
                'absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ring-2 ring-brain-surface ' +
                DOT_BG[dotState] +
                (dotState === 'running' ? ' animate-pulse' : '')
              }
            />
          )}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={'flex items-start gap-3 animate-slide-up ' + (isUser ? 'flex-row-reverse' : '')}>
      <div className={'w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ' + (
        isUser ? 'bg-brain-accent/20' : 'bg-brain-surface border border-brain-border'
      )}>
        {isUser
          ? <User size={14} className="text-brain-accent" />
          : <Bot size={14} className="text-brain-text-dim" />
        }
      </div>
      <div className={'max-w-[80%] rounded-xl px-4 py-3 text-sm ' + (
        isUser
          ? 'bg-brain-accent/10 border border-brain-accent/20 text-brain-text'
          : 'bg-brain-bg border border-brain-border text-brain-text-dim'
      )}>
        {isUser
          ? <p className="whitespace-pre-wrap break-words">{message.content}</p>
          : <MarkdownMessage content={message.content} />
        }
        <p className="text-xs text-brain-text-dim mt-1 opacity-60">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
        </p>
      </div>
    </div>
  );
}