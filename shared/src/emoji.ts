// Deterministic emoji identity for an agent.
//
// The emoji is ALWAYS derived in code from the agent's name + description — it
// is never requested from the LLM. `parseAgentFromChat` does a single unrepaired
// JSON.parse of the model's reply and the default model is a small local one, so
// growing the requested JSON shape risks breaking agent creation outright.

export const DEFAULT_AGENT_EMOJI = '🤖';

// Ordered by priority: the first group with a matching keyword wins.
const EMOJI_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['📄', ['document', 'documents', 'pdf', 'pdfs', 'doc', 'docs']],
  ['💬', ['message', 'messages', 'messaging', 'chat', 'telegram', 'slack', 'sms', 'dm']],
  ['🔍', ['search', 'research', 'web', 'lookup', 'scrape', 'crawl', 'browse']],
  ['📁', ['file', 'files', 'folder', 'folders', 'filesystem', 'directory', 'directories']],
  ['📧', ['email', 'emails', 'gmail', 'inbox', 'mail', 'newsletter']],
  ['📅', ['calendar', 'schedule', 'scheduled', 'scheduling', 'reminder', 'reminders']],
  ['💻', ['code', 'coding', 'github', 'gitlab', 'repo', 'repos', 'repository', 'commit', 'commits', 'deploy']],
  ['📊', ['data', 'analytics', 'analysis', 'report', 'reports', 'reporting', 'metrics', 'dashboard', 'stats', 'statistics']],
  ['📝', ['note', 'notes', 'notion', 'write', 'writing', 'draft', 'drafts', 'journal', 'summarize', 'summarise', 'summary']],
  ['🔔', ['monitor', 'monitoring', 'watch', 'watcher', 'watching', 'alert', 'alerts', 'notify', 'notification', 'notifications']],
];

/**
 * Pick an emoji for an agent from its name + description using a fixed keyword
 * map. Whole-word matching (so "profile" does not match "file"). Falls back to
 * {@link DEFAULT_AGENT_EMOJI} when nothing matches.
 */
export function deriveAgentEmoji(name?: string | null, description?: string | null): string {
  const text = `${name ?? ''} ${description ?? ''}`.toLowerCase();
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  for (const [emoji, keywords] of EMOJI_KEYWORDS) {
    if (keywords.some((kw) => words.has(kw))) return emoji;
  }
  return DEFAULT_AGENT_EMOJI;
}
