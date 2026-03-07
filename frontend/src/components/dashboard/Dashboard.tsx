import { useState, useEffect, useRef } from 'react';
import { Send, Bot, User, Loader2, Zap } from 'lucide-react';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import type { ChatMessage } from '@shared/types';

function formatContent(content: string): string {
  return content
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

export function Dashboard() {
  const { chatMessages, setChatMessages, addChatMessage, agents, logs } = useStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.getChatHistory().then(setChatMessages).catch(console.error);
  }, [setChatMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  async function handleSend() {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput('');
    setSending(true);

    try {
      const { userMessage, assistantMessage } = await api.sendChatMessage(text);
      addChatMessage(userMessage);
      addChatMessage(assistantMessage);
    } catch (err) {
      addChatMessage({
        id: Date.now().toString(),
        role: 'assistant',
        content: `Error: ${err instanceof Error ? err.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
      });
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const recentLogs = logs.slice(-5);

  return (
    <div className="flex h-full gap-4 p-4">
      {/* Chat Panel */}
      <div className="flex flex-col flex-1 rounded-xl border border-brain-border bg-brain-surface overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-brain-border">
          <div className="w-2 h-2 rounded-full bg-brain-accent animate-pulse-slow" />
          <h2 className="text-sm font-semibold text-brain-text">NodeBrain Command Interface</h2>
          <span className="ml-auto text-xs text-brain-text-dim font-mono">{agents.length} agents active</span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {chatMessages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4 py-16">
              <div className="w-16 h-16 rounded-2xl bg-brain-accent/10 border border-brain-accent/20 flex items-center justify-center">
                <Zap size={28} className="text-brain-accent" />
              </div>
              <div>
                <h3 className="text-brain-text font-semibold mb-2">Create your first agent</h3>
                <p className="text-brain-text-dim text-sm max-w-xs">
                  Describe what you want an agent to do in plain English and NodeBrain will configure it automatically.
                </p>
              </div>
              <div className="space-y-2 text-left w-full max-w-sm">
                {[
                  'Create an agent that summarizes RSS feeds every hour',
                  'Build a research agent that answers questions about topics',
                  'Make an agent that monitors news and sends summaries',
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="w-full text-left text-xs text-brain-text-dim hover:text-brain-text bg-brain-bg hover:bg-brain-border border border-brain-border rounded-lg px-3 py-2 transition-colors"
                  >
                    "{suggestion}"
                  </button>
                ))}
              </div>
            </div>
          )}

          {chatMessages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {sending && (
            <div className="flex items-start gap-3">
              <div className="w-7 h-7 rounded-lg bg-brain-accent/20 flex items-center justify-center flex-shrink-0">
                <Bot size={14} className="text-brain-accent" />
              </div>
              <div className="bg-brain-bg border border-brain-border rounded-xl px-4 py-3">
                <Loader2 size={14} className="animate-spin text-brain-text-dim" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-3 border-t border-brain-border">
          <div className="flex gap-2 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Create an agent, assign tasks, or ask questions..."
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
          <p className="text-xs text-brain-text-dim mt-2 px-1">Enter to send · Shift+Enter for newline</p>
        </div>
      </div>

      {/* Right Sidebar */}
      <div className="w-72 flex flex-col gap-4">
        {/* Agent Status */}
        <div className="rounded-xl border border-brain-border bg-brain-surface p-4 flex-1">
          <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-3">Active Agents</h3>
          {agents.length === 0 ? (
            <p className="text-xs text-brain-text-dim text-center py-4">No agents yet</p>
          ) : (
            <div className="space-y-2">
              {agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 p-2 rounded-lg bg-brain-bg border border-brain-border">
                  <span className={`status-dot status-${agent.status}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-brain-text truncate">{agent.name}</p>
                    <p className="text-xs text-brain-text-dim capitalize">{agent.status}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Live Logs */}
        <div className="rounded-xl border border-brain-border bg-brain-surface p-4 h-48">
          <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-3">Live Logs</h3>
          <div className="space-y-1 overflow-y-auto h-32">
            {recentLogs.length === 0 ? (
              <p className="text-xs text-brain-text-dim">No activity yet</p>
            ) : (
              recentLogs.map((log) => (
                <div key={log.id} className="flex gap-2 text-xs">
                  <span className={`flex-shrink-0 font-mono ${
                    log.level === 'error' ? 'text-brain-error' :
                    log.level === 'warn' ? 'text-brain-warning' :
                    'text-brain-text-dim'
                  }`}>[{log.level}]</span>
                  <span className="text-brain-text-dim truncate">{log.message}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex items-start gap-3 animate-slide-up ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isUser ? 'bg-brain-accent/20' : 'bg-brain-surface border border-brain-border'
      }`}>
        {isUser
          ? <User size={14} className="text-brain-accent" />
          : <Bot size={14} className="text-brain-text-dim" />
        }
      </div>
      <div className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
        isUser
          ? 'bg-brain-accent/10 border border-brain-accent/20 text-brain-text'
          : 'bg-brain-bg border border-brain-border text-brain-text-dim'
      }`}>
        <div
          className="chat-content leading-relaxed"
          dangerouslySetInnerHTML={{ __html: formatContent(message.content) }}
        />
        <p className="text-xs text-brain-text-dim mt-1 opacity-60">
          {new Date(message.timestamp).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
