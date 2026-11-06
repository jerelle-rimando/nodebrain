import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { Send, Bot, User, Loader2, ArrowLeft, ArrowDown, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import { toStatusText } from '../../utils/statusText';
import type { ChatMessage } from '@shared/types';
import { ModelSelect } from '../ModelSelect';
import { ModelPickerButton } from '../dashboard/ModelPickerButton';
import { EmojiPicker } from '../dashboard/EmojiPicker';
import { AiDisclaimer } from '../shared/AiDisclaimer';
import { CHAT_MODEL_KEY, CHAT_PROVIDER_KEY, CLOUD_DEFAULT_PROVIDER, CLOUD_DEFAULT_MODEL } from '../../utils/chatModel';
import { useSmoothedStream } from '../../hooks/useSmoothedStream';

// Agent Studio: the chat beside the NodeGraph. In Agent mode, describing an
// agent creates one; in Chat mode it just talks. Picking an agent on the
// graph and pressing Chat opens that agent's own thread here instead.

type ChatMode = 'chat' | 'agent';

// Static empty state shown in the Agent Studio thread before any chat
// history exists. Deliberately hard-coded text, not a model call: it must
// render instantly, before any provider is even confirmed working, and it is
// never persisted — see the render site for why.
const WELCOME_EXAMPLES = [
  'Watch a folder and tell me when new files show up',
  'Summarize PDFs in my Downloads folder and save notes to a file',
  'Search the web for AI news and save a summary',
];

const WELCOME_MARKDOWN = `Tell me what you want done and I'll build an AI agent to do it. Switch to Agent mode, then try:

- ${WELCOME_EXAMPLES[0]}
- ${WELCOME_EXAMPLES[1]}
- ${WELCOME_EXAMPLES[2]}

Or tell me what you're tired of doing by hand. I'll figure out if I can take it off you.`;

// Flattens a react-markdown children tree back to plain text so a rendered
// <li> can be matched against WELCOME_EXAMPLES regardless of the inline
// markup remark wraps it in.
function getNodeText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getNodeText).join('');
  if (node && typeof node === 'object' && 'props' in (node as any)) {
    return getNodeText((node as any).props.children);
  }
  return '';
}

// Sticky-bottom threshold: while the chat is scrolled to within this many px of
// the bottom, streamed tokens and new messages keep the newest content in view.
// Scrolled further up than this, auto-follow disengages until the user returns.
const NEAR_BOTTOM_PX = 100;

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

// Shown above a Chat-mode reply when the backend detected an unambiguous
// agent-creation request — first thing the user sees, before they read a long
// explanation. Chat mode stays non-acting; this points the user at the toggle
// that would actually build it. Styled distinctly (brain-accent) so it reads as
// app guidance, not part of the model's response.
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

// Empty state for the Agent Studio thread. Styled like a real assistant
// bubble and rendered through the same Markdown pipeline so the bullets/bold
// match a real reply, but it's a pure UI empty-state: it holds no
// ChatMessage, is never sent to the API, and never written to chat history —
// so it simply stops appearing once `chatMessages` is non-empty.
function WelcomeMessage({ onExampleClick }: { onExampleClick: (text: string) => void }) {
  return (
    <div className="flex items-start gap-3 animate-slide-up">
      <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 bg-brain-surface border border-brain-border">
        <Bot size={14} className="text-brain-text-dim" />
      </div>
      <div className="max-w-[80%] rounded-xl px-4 py-3 text-sm bg-brain-bg border border-brain-border text-brain-text-dim">
        <div className="chat-content leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ node: _node, ...props }) => (
                <a {...props} target="_blank" rel="noopener noreferrer" />
              ),
              li: ({ node: _node, children, ...props }) => {
                const text = getNodeText(children).trim();
                if (!WELCOME_EXAMPLES.includes(text)) {
                  return <li {...props}>{children}</li>;
                }
                return (
                  <li {...props}>
                    <button
                      type="button"
                      onClick={() => onExampleClick(text)}
                      className="text-left text-brain-accent hover:text-brain-accent-dim hover:underline transition-colors"
                    >
                      {children}
                    </button>
                  </li>
                );
              },
            }}
          >
            {WELCOME_MARKDOWN}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  );
}

// `agentId` picks the thread: null is Agent Studio itself, an id is that
// agent's own chat. The NodeGraph owns the choice.
export function AgentStudioChat({ agentId, onAgentChange }: {
  agentId: string | null;
  onAgentChange: (agentId: string | null) => void;
}) {
  const { chatMessages, setChatMessages, addChatMessage, agents, logs, updateAgent: storeUpdateAgent, availableModels, chatPhase, setChatPhase } = useStore();
  // Looked up from the store so a rename, emoji or model change shows at once,
  // and a deleted agent drops the thread back to Agent Studio.
  const selectedAgent = agentId ? agents.find((a) => a.id === agentId) ?? null : null;
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [streamingRequestId, setStreamingRequestId] = useState<string | null>(null);
  // Id of the assistant message that should show the "switch to Agent mode"
  // nudge above it. Transient — set when the backend flags a Chat-mode
  // creation request, cleared on the next send.
  const [agentModeHintFor, setAgentModeHintFor] = useState<string | null>(null);
  const { displayedText: streamingText, flush: flushStream } = useSmoothedStream(streamingRequestId);
  const logsMarkRef = useRef(0);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [agentMessages, setAgentMessages] = useState<Record<string, ChatMessage[]>>({});
  // Gates the welcome message: stays false until the history fetch below
  // resolves, so a returning user with real history never sees a flash of
  // the welcome state before it's replaced.
  const [chatHistoryLoaded, setChatHistoryLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // True while the view is pinned to the bottom. The streaming path reads this
  // ref (not state) so a ~60/s token cadence doesn't trigger re-renders;
  // `awayFromBottom` mirrors it only to drive the "jump to latest" button.
  const stickToBottomRef = useRef(true);
  const scrollTickRef = useRef<number | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [defaultProvider, setDefaultProvider] = useState<string>(() => localStorage.getItem(CHAT_PROVIDER_KEY) ?? CLOUD_DEFAULT_PROVIDER);
  const [defaultModel, setDefaultModel] = useState<string>(() => localStorage.getItem(CHAT_MODEL_KEY) ?? CLOUD_DEFAULT_MODEL);
  const [chatMode, setChatMode] = useState<ChatMode>(() => (localStorage.getItem('nb_chat_mode') as ChatMode) ?? 'chat');

  useEffect(() => { localStorage.setItem(CHAT_PROVIDER_KEY, defaultProvider); }, [defaultProvider]);
  useEffect(() => { localStorage.setItem(CHAT_MODEL_KEY, defaultModel); }, [defaultModel]);
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
    if (localStorage.getItem(CHAT_MODEL_KEY) === 'llama-3.3-70b-versatile') {
      setDefaultModel(CLOUD_DEFAULT_MODEL);
    }
  }, []);

  // Local-first default: if the local engine + model are installed, seed them
  // instead of the cloud fallback. Only ever replaces the untouched cloud seed
  // (never a model the user picked), and never again once the user has picked
  // anything via the model picker (nb_default_model_chosen). Existing installs
  // hold the cloud seed in localStorage indistinguishably from a fresh one, so
  // this also moves a local-onboarded user off it once.
  useEffect(() => {
    if (localStorage.getItem('nb_default_model_chosen') === '1') return;
    const storedProvider = localStorage.getItem(CHAT_PROVIDER_KEY) ?? CLOUD_DEFAULT_PROVIDER;
    const storedModel = localStorage.getItem(CHAT_MODEL_KEY) ?? CLOUD_DEFAULT_MODEL;
    if (storedProvider !== CLOUD_DEFAULT_PROVIDER || storedModel !== CLOUD_DEFAULT_MODEL) return;
    api.getLocalEngineStatus()
      .then((status) => {
        if (!status.available) return;
        setDefaultProvider(status.provider);
        setDefaultModel(status.model);
      })
      .catch(() => { /* backend unreachable: keep the cloud fallback */ });
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
    }).catch(console.error)
      .finally(() => setChatHistoryLoaded(true));
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
  // writes it.
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

  // Switching between Agent Studio and an agent thread starts pinned to newest.
  useEffect(() => {
    scrollChatToBottom('auto');
    setShowEmojiPicker(false);
  }, [agentId, scrollChatToBottom]);

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
    if (latest) setStatusText(toStatusText(latest.message));
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

  // Clicking a welcome-message example fills the composer and switches to
  // Agent mode, but never auto-sends — the user still presses enter.
  function handleWelcomeExampleClick(text: string) {
    setInput(text);
    setChatMode('agent');
    inputRef.current?.focus();
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
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <section aria-label="Agent Studio" className="relative flex flex-col h-full min-w-0 bg-brain-surface overflow-hidden">

        <div className="flex items-center gap-3 px-4 py-3 border-b border-brain-border">
          {selectedAgent ? (
            <>
              <button
                onClick={() => onAgentChange(null)}
                title="Back to Agent Studio"
                aria-label="Back to Agent Studio"
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
              <h2 className="min-w-0 text-sm font-semibold text-brain-text truncate">{selectedAgent.name}</h2>
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
                  } catch (err) {
                    console.error(err);
                  }
                }}
                className="ml-auto min-w-0 max-w-[45%]"
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
          {activeMessages.length === 0 && !selectedAgent && chatHistoryLoaded && (
            <WelcomeMessage onExampleClick={handleWelcomeExampleClick} />
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
              {!selectedAgent && agentModeHintFor === msg.id && <AgentModeHint />}
              <MessageBubble message={msg} />
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
                aria-label="Send"
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
                      localStorage.setItem('nb_default_model_chosen', '1');
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
                  aria-label="Send"
                  className="flex-shrink-0 w-8 h-8 rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                >
                  <Send size={14} className="text-white" />
                </button>
              </div>
            </div>
          )}
          <AiDisclaimer className="mt-2" />
        </div>
    </section>
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
