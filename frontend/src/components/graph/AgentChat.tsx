import { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Loader2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import type { Agent, ChatMessage } from '@shared/types';
import { ModelSelect } from '../ModelSelect';
import { EmojiPicker } from '../dashboard/EmojiPicker';
import { AiDisclaimer } from '../shared/AiDisclaimer';

// One agent's own chat, opened from its panel on the NodeGraph. Each message
// runs the agent with that text; both turns are saved so the thread is there
// next time.

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

export function AgentChat({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { updateAgent: storeUpdateAgent, availableModels } = useStore();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMessages([]);
    setShowEmojiPicker(false);
    api.getChatHistory()
      .then((all) => setMessages(all.filter((m) => m.agentId === agent.id)))
      .catch(console.error);
    inputRef.current?.focus();
  }, [agent.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, sending]);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setSending(true);
    const userMsg: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      agentId: agent.id,
    };
    setMessages((prev) => [...prev, userMsg]);
    try {
      const result = await api.executeAgent(agent.id, text);
      const assistantMsg: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: result.message ?? '(no response)',
        timestamp: new Date().toISOString(),
        agentId: agent.id,
      };
      setMessages((prev) => [...prev, assistantMsg]);
      api.saveMessages([userMsg, assistantMsg]).catch(console.error);
    } catch (err) {
      setMessages((prev) => [...prev, {
        id: Date.now().toString(),
        role: 'assistant',
        content: 'Error: ' + (err instanceof Error ? err.message : 'Unknown error'),
        timestamp: new Date().toISOString(),
        agentId: agent.id,
      }]);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function handleEmojiSelect(emoji: string) {
    try {
      storeUpdateAgent(await api.updateAgent(agent.id, { emoji }));
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <section aria-label={`Chat with ${agent.name}`} className="relative flex flex-col h-full min-w-0 bg-brain-surface overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-brain-border">
        <div className="relative flex-shrink-0">
          <button
            onClick={() => setShowEmojiPicker((v) => !v)}
            title="Change agent emoji"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-base leading-none border border-brain-border bg-brain-bg hover:border-brain-muted transition-colors"
          >
            <span aria-hidden>{agent.emoji ?? '🤖'}</span>
          </button>
          {showEmojiPicker && (
            <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmojiPicker(false)} className="left-0" />
          )}
        </div>
        <div
          className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: agent.status === 'running' ? '#6366f1' : agent.status === 'error' ? '#ef4444' : '#22c55e' }}
        />
        <h2 className="min-w-0 text-sm font-semibold text-brain-text truncate">{agent.name}</h2>
        {agent.config.dryRun && (
          <span className="flex-shrink-0 bg-yellow-500/10 border border-yellow-500/40 text-yellow-400 rounded px-1.5 py-0.5 text-xs font-semibold tracking-wide">
            DRY-RUN
          </span>
        )}
        <ModelSelect
          provider={agent.provider}
          model={agent.model}
          availableModels={availableModels}
          onChange={async (model) => {
            try {
              storeUpdateAgent(await api.updateAgent(agent.id, { model }));
            } catch (err) {
              console.error(err);
            }
          }}
          className="ml-auto min-w-0 max-w-[45%]"
        />
        <button
          onClick={onClose}
          title="Close chat"
          aria-label="Close chat"
          className="w-6 h-6 flex items-center justify-center rounded-lg text-brain-text-dim hover:text-brain-text hover:bg-brain-border transition-colors flex-shrink-0"
        >
          <X size={14} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !sending && (
          <div className="flex flex-col items-center justify-center h-full text-center space-y-3 py-16">
            <div className="w-12 h-12 rounded-xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center text-3xl leading-none">
              {agent.emoji ? <span aria-hidden>{agent.emoji}</span> : <Bot size={22} className="text-brain-accent" />}
            </div>
            <div>
              <h3 className="text-brain-text font-semibold mb-1">{agent.name}</h3>
              <p className="text-brain-text-dim text-xs max-w-xs">{agent.description}</p>
            </div>
            <p className="text-xs text-brain-text-dim">Ask this agent anything or give it a task</p>
          </div>
        )}

        {messages.map((msg) => <MessageBubble key={msg.id} message={msg} />)}

        {sending && (
          <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-brain-accent/20 flex items-center justify-center flex-shrink-0">
              <Bot size={14} className="text-brain-accent" />
            </div>
            <div className="bg-brain-bg border border-brain-border rounded-xl px-4 py-3 flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-brain-text-dim flex-shrink-0" />
              <span className="text-sm text-brain-text-dim">Working…</span>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 border-t border-brain-border">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend(); } }}
            placeholder={'Ask ' + agent.name + ' anything...'}
            rows={1}
            className="flex-1 bg-brain-bg border border-brain-border rounded-lg px-3 py-2.5 text-sm text-brain-text placeholder-brain-text-dim resize-none focus:outline-none focus:border-brain-accent transition-colors font-sans"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />
          <button
            onClick={() => void handleSend()}
            disabled={!input.trim() || sending}
            aria-label="Send"
            className="flex-shrink-0 w-10 h-10 rounded-lg bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
          >
            <Send size={15} className="text-white" />
          </button>
        </div>
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
        {isUser ? <User size={14} className="text-brain-accent" /> : <Bot size={14} className="text-brain-text-dim" />}
      </div>
      <div className={'max-w-[80%] rounded-xl px-4 py-3 text-sm ' + (
        isUser
          ? 'bg-brain-accent/10 border border-brain-accent/20 text-brain-text'
          : 'bg-brain-bg border border-brain-border text-brain-text-dim'
      )}>
        {isUser
          ? <p className="whitespace-pre-wrap break-words">{message.content}</p>
          : <MarkdownMessage content={message.content} />}
        <p className="text-xs text-brain-text-dim mt-1 opacity-60">
          {new Date(message.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
        </p>
      </div>
    </div>
  );
}
