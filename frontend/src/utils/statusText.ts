// Turns a raw backend log line into the plain-language status shown while a
// chat request is in flight. Raw log text must never reach the user: it can
// contain model names ("Calling qwen3:… via ollama..."), provider names, and
// namespaced tool names ("filesystem__read_file").

export const FALLBACK_STATUS = 'Working…';
const THINKING_STATUS = 'Thinking…';

// Add new tools here. Keys are prefixes of the namespaced tool name
// (`serverName__toolName`); the first matching rule wins, so list specific
// tools before their server-wide catch-all. A server with no rule here (e.g. a
// user's custom MCP server) falls through to FALLBACK_STATUS.
const TOOL_STATUS_RULES: ReadonlyArray<readonly [prefix: string, text: string]> = [
  // Local files
  ['filesystem__write_file', 'Saving to your files…'],
  ['filesystem__edit_file', 'Saving to your files…'],
  ['filesystem__create_directory', 'Saving to your files…'],
  ['filesystem__move_file', 'Saving to your files…'],
  ['filesystem__', 'Reading your files…'],
  ['pdf-reader__', 'Reading a document…'],
  ['file-reader__read_spreadsheet', 'Reading a spreadsheet…'],
  ['file-reader__', 'Reading a document…'],

  // Web
  ['open-websearch__', 'Searching the web…'],

  // Messaging
  ['telegram__', 'Sending your message…'],
  ['slack__slack_get', 'Reading your messages…'],
  ['slack__slack_list', 'Reading your messages…'],
  ['slack__', 'Sending your message…'],

  // Notion
  ['notion__API-post-search', 'Searching your workspace…'],
  ['notion__API-retrieve', 'Reading a document…'],
  ['notion__API-get', 'Reading a document…'],
  ['notion__API-post-page', 'Saving to your workspace…'],
  ['notion__API-patch', 'Saving to your workspace…'],
  ['notion__', 'Working in your workspace…'],

  // GitHub
  ['github__search', 'Searching GitHub…'],
  ['github__get', 'Reading from GitHub…'],
  ['github__list', 'Reading from GitHub…'],
  ['github__', 'Working with GitHub…'],

  // Other agents
  ['agent-coordinator__', 'Asking another agent…'],
];

function toolStatus(toolName: string): string {
  for (const [prefix, text] of TOOL_STATUS_RULES) {
    if (toolName.startsWith(prefix)) return text;
  }
  return FALLBACK_STATUS;
}

export function toStatusText(rawLogMessage: string): string {
  const msg = rawLogMessage.trim();

  // Tool activity — the only case where the tool name drives the phrasing.
  const tool = msg.match(/^(?:Calling tool|Awaiting approval for tool): (\S+)$/);
  if (tool) {
    return msg.startsWith('Awaiting') ? 'Waiting for your approval…' : toolStatus(tool[1]);
  }

  // Model call ("Calling <model> via <provider>...") — checked after the tool
  // form above, which shares the "Calling " prefix.
  if (/^Calling .+ via .+\.\.\.$/.test(msg)) return THINKING_STATUS;

  if (/^Starting task for agent /.test(msg)) return THINKING_STATUS;
  if (/^Delegating to agent /.test(msg)) return 'Asking another agent…';

  // Tool completed/failed/denied, dry-run skips, task end, and any log line we
  // don't recognise: never echo it.
  return FALLBACK_STATUS;
}
