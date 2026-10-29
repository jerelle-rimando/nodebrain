import os from 'os';
import path from 'path';
import { connectToServer, connectToSSEServer, getAllAvailableTools, getConnectedServers, getConnectionError, getFailedServers, clearConnectionError, recordConnectionError, disconnectServer, getCredentialFingerprint, type MCPServer, type MCPSSEServer, type MCPToolWithServer } from './mcpClient';
import { describeMcpError } from '../utils/describeMcpError';
import { withBundledRuntime, describeNodeRuntime } from './nodeRuntime';
import { getSlackTeamId } from './slackAuth';
import { getCredentialForProvider } from '../vault/credentialVault';
import { readPdfAsText } from '../utils/pdfReader';
import { readSpreadsheetAsText, readDocumentAsText } from '../utils/fileReaders';
import { getAllCustomMCPServers } from '../db/mcpServerRepository';
import { getConnectionsForAgent } from '../db/agentConnectionRepository';
import { getAgentById } from '../db/agentRepository';

interface ServerConfig {
  name: string;
  credentialProvider: string;
  requiresCredential?: boolean; // defaults to true when omitted
  buildServer: (credential: string) => MCPServer | Promise<MCPServer>;
}

// Versions are pinned deliberately — do NOT automate updates or remove the @version suffix.
// Pinning prevents silent supply-chain re-resolution: without a version, npx re-checks the
// npm registry on every reconnect and may silently pull a newer (potentially malicious) release.
// To upgrade a server, manually verify the new release and update the version string here.
export const SERVER_CONFIGS: ServerConfig[] = [
  {
    name: 'telegram',
    credentialProvider: 'telegram',
    buildServer: (token) => ({
      name: 'telegram',
      command: 'npx',
      args: ['-y', '@iqai/mcp-telegram@0.1.4'],
      env: { TELEGRAM_BOT_TOKEN: token, SAMPLING_ENABLED: '' },
    }),
  },
  {
    name: 'github',
    credentialProvider: 'github',
    buildServer: (token) => ({
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@2025.4.8'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
    }),
  },
  {
    name: 'slack',
    credentialProvider: 'slack',
    // The server exits at startup without SLACK_TEAM_ID; it's looked up from the token.
    buildServer: async (token) => ({
      name: 'slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      env: { SLACK_BOT_TOKEN: token, SLACK_TEAM_ID: await getSlackTeamId(token) },
    }),
  },
  {
    name: 'notion',
    credentialProvider: 'notion',
    buildServer: (token) => ({
      name: 'notion',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server@2.4.1'],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: 'Bearer ' + token,
          'Notion-Version': '2022-06-28',
        }),
      },
    }),
  },
  {
    name: 'filesystem',
    credentialProvider: 'filesystem',
    buildServer: (allowedPath) => ({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem@2026.1.14', allowedPath],
      env: {},
    }),
  },
  {
    name: 'open-websearch',
    credentialProvider: 'open-websearch',
    requiresCredential: false,
    buildServer: () => ({
      name: 'open-websearch',
      command: 'npx',
      args: ['-y', 'open-websearch@2.1.11'],
      env: {
        MODE: 'stdio',
        DEFAULT_SEARCH_ENGINE: 'duckduckgo',
        ALLOWED_SEARCH_ENGINES: 'duckduckgo,bing',
      },
    }),
  },
  {
    // SPIKE (docs/spikes/browser-automation-biberk.md): not ready to ship. With no
    // credential it starts for everyone and adds ~25 tools to every agent's prompt.
    // Drives the system Edge install; no Chromium download.
    name: 'playwright',
    credentialProvider: 'playwright',
    requiresCredential: false,
    buildServer: () => ({
      name: 'playwright',
      command: 'npx',
      args: [
        '-y', '@playwright/mcp@0.0.83',
        '--browser', 'msedge',
        // Snapshots and screenshots are written to disk; the default is the cwd,
        // which in the packaged app is the install folder.
        '--output-dir', path.join(os.tmpdir(), 'nodebrain-playwright'),
      ],
      env: {},
    }),
  },
];

// Every built-in server is started through here, so all of them run on the
// bundled npm and never need a system Node.js install.
// Building can fail (Slack's needs a network lookup); the error is returned
// rather than thrown so callers can record it as that server's failure.
async function buildBuiltinServer(config: ServerConfig, credential: string): Promise<MCPServer | { error: string }> {
  try {
    return withBundledRuntime(await config.buildServer(credential));
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[ToolRegistry] Couldn't prepare "${config.name}":`, err);
    return { error };
  }
}

export function providerRequiresCredential(provider: string): boolean {
  const config = SERVER_CONFIGS.find(c => c.credentialProvider === provider);
  return config?.requiresCredential ?? true;
}

type DiagEntry = { name: string; status: 'connected' | 'failed' | 'skipped'; detail: string };

let resolveRegistryReady!: () => void;
export const toolRegistryReady: Promise<void> = new Promise(resolve => {
  resolveRegistryReady = resolve;
});

const REGISTRY_READY_TIMEOUT_MS = 30_000;

let registryInitialized = false;
let idleWaiters: Array<() => void> = [];

// True while the boot pass or a reload is still connecting servers — a server
// that isn't up yet may simply not have had its turn.
function isRegistryBusy(): boolean {
  return !registryInitialized || reloadInProgress;
}

function notifyIfIdle(): void {
  if (isRegistryBusy()) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

// Resolves true once no connect pass is running, or false if that takes longer
// than timeoutMs (a first-run npx download can).
export function waitForRegistryIdle(timeoutMs: number): Promise<boolean> {
  if (!isRegistryBusy()) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => {
      idleWaiters = idleWaiters.filter(w => w !== done);
      resolve(false);
    }, timeoutMs);
    idleWaiters.push(done);
  });
}

export type ServerState = 'running' | 'failed' | 'starting' | 'stopped';

export interface ServerStatus {
  state: ServerState;
  message?: string; // plain language, never raw error text
}

// The one place a server's live state is derived from. The integration cards,
// the Test button, the custom server list and agent tool errors all read this,
// so none of them can claim a server is up when it never started.
export function getServerStatus(name: string): ServerStatus {
  if (getConnectedServers().includes(name)) return { state: 'running' };
  const error = getConnectionError(name);
  if (error) return { state: 'failed', message: describeMcpError(error) };
  if (isRegistryBusy()) return { state: 'starting', message: 'This integration is still starting.' };
  return { state: 'stopped' };
}

// Servers NodeBrain tried to start and couldn't, with a plain-language reason each.
export function getUnavailableServers(): Array<{ name: string; message: string }> {
  return getFailedServers().map(name => ({ name, message: getServerStatus(name).message ?? '' }));
}

export async function initializeToolRegistry(): Promise<void> {
  try {
    console.log('[ToolRegistry] Checking available integrations...');
    console.log(`[ToolRegistry] MCP runtime: ${describeNodeRuntime()}`);

    const diag: DiagEntry[] = [];

    for (const config of SERVER_CONFIGS) {
      const requiresCredential = config.requiresCredential ?? true;
      const credential = requiresCredential ? getCredentialForProvider(config.credentialProvider) : '';

      if (requiresCredential && !credential) {
        console.log(`[ToolRegistry] Skipping "${config.name}" — no credential in vault`);
        diag.push({ name: config.name, status: 'skipped', detail: 'no credential in vault' });
        continue;
      }

      const server = await buildBuiltinServer(config, credential ?? '');
      if ('error' in server) {
        recordConnectionError(config.name, server.error);
        diag.push({ name: config.name, status: 'failed', detail: server.error });
        continue;
      }
      const fingerprint = requiresCredential ? (credential ?? '') : `${server.command}|${server.args.join('|')}`;
      await connectToServer(server, fingerprint);

      if (getConnectedServers().includes(config.name)) {
        diag.push({ name: config.name, status: 'connected', detail: '' }); // tool count filled below
      } else {
        const reason = getConnectionError(config.name) ?? 'unknown error';
        diag.push({ name: config.name, status: 'failed', detail: reason });
      }
    }

    // Load custom MCP servers from DB
    const customServers = getAllCustomMCPServers();
    for (const server of customServers) {
      if (server.transport === 'sse' && server.url) {
        await connectToSSEServer({ name: server.name, url: server.url }, server.url);
      } else if (server.transport === 'stdio' && server.command) {
        await connectToServer({
          name: server.name,
          command: server.command,
          args: server.args,
          env: server.envVars,
        }, `${server.command}|${server.args.join('|')}`);
      }
    }

    const tools = await getAllAvailableTools();

    // Fill in tool counts for connected entries
    const countByServer = new Map<string, number>();
    for (const t of tools) {
      countByServer.set(t.serverName, (countByServer.get(t.serverName) ?? 0) + 1);
    }
    for (const entry of diag) {
      if (entry.status === 'connected') {
        const n = countByServer.get(entry.name) ?? 0;
        entry.detail = `${n} tool${n !== 1 ? 's' : ''}`;
      }
    }

    // Boot diagnostic table
    const nameW = Math.max(...diag.map(d => d.name.length), 4);
    const divider = '─'.repeat(nameW + 36);
    console.log(`\n[MCP] ${divider}`);
    for (const { name, status, detail } of diag) {
      const tag = status === 'connected' ? 'CONNECTED' : status === 'failed' ? 'FAILED   ' : 'SKIPPED  ';
      console.log(`[MCP]   ${name.padEnd(nameW)}  ${tag}  ${detail}`);
    }
    console.log(`[MCP] ${divider}\n`);

    console.log(`[ToolRegistry] Ready — ${tools.length} tools available`);
  } finally {
    registryInitialized = true;
    resolveRegistryReady();
    notifyIfIdle();
  }
}

const PDF_TOOL: MCPToolWithServer = {
  serverName: 'pdf-reader',
  name: 'read_pdf',
  description: 'Read and extract text content from a PDF file on the local filesystem',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the PDF file to read',
      },
    },
    required: ['file_path'],
  },
};

const SPREADSHEET_TOOL: MCPToolWithServer = {
  serverName: 'file-reader',
  name: 'read_spreadsheet',
  description: 'Read and extract data from a spreadsheet file (.xlsx or .csv) on the local filesystem, returned as CSV-style text',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the spreadsheet file to read',
      },
    },
    required: ['file_path'],
  },
};

const DOCUMENT_TOOL: MCPToolWithServer = {
  serverName: 'file-reader',
  name: 'read_document',
  description: 'Read and extract plain text content from a Word document (.docx) on the local filesystem',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Absolute path to the .docx file to read',
      },
    },
    required: ['file_path'],
  },
};

const DELEGATE_TOOL: MCPToolWithServer = {
  serverName: 'agent-coordinator',
  name: 'delegate_to_agent',
  description: 'Delegate a task to a connected sub-agent by name and get its response back. Only use this if you need another agent to handle part of the work.',
  inputSchema: {
    type: 'object',
    properties: {
      target_agent_name: {
        type: 'string',
        description: 'The exact name of the agent to delegate to',
      },
      task: {
        type: 'string',
        description: 'The task or question to send to that agent',
      },
    },
    required: ['target_agent_name', 'task'],
  },
};

// Take Control: handled by agentEngine, not an MCP server. `reason` is shown to the
// person as-is, so the description asks for plain words.
export const TAKE_CONTROL_TOOL: MCPToolWithServer = {
  serverName: 'browser-handoff',
  name: 'ask_person_to_take_over',
  description: 'Hand the browser to the person and wait until they hand it back. Use this when you hit something you must not or cannot do yourself: a one-time code sent to their phone or email, a CAPTCHA, a password you were not given, or anything else that blocks you. Do not guess codes or passwords, and do not use one shown on the page. When this returns, the page has probably changed: take a new snapshot before doing anything else.',
  inputSchema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'One or two short sentences, in plain everyday words, telling the person what to do in the browser. Example: "The site sent a code to your email. Please type it in and press Verify." Never mention tools, code, errors, or technical terms.',
      },
    },
    required: ['reason'],
  },
};

export async function getToolsForAgent(agentId?: string): Promise<MCPToolWithServer[]> {
  await Promise.race([
    toolRegistryReady,
    new Promise<void>(resolve => setTimeout(resolve, REGISTRY_READY_TIMEOUT_MS)),
  ]);
  const mcpTools = await getAllAvailableTools();
  const tools: MCPToolWithServer[] = [...mcpTools, PDF_TOOL, SPREADSHEET_TOOL, DOCUMENT_TOOL];

  const toolPermissions = agentId ? getAgentById(agentId)?.toolPermissions : undefined;
  let result = tools;

  if (toolPermissions && toolPermissions.length > 0) {
    const allowlist = new Set(toolPermissions);
    result = tools.filter(t => allowlist.has(`${t.serverName}__${t.name}`));

    console.debug(
      `[ToolRegistry] agent ${agentId}: ${result.length}/${tools.length} tools returned ` +
      `(${tools.length - result.length} filtered out by toolPermissions)`
    );
  }

  // Delegation is granted by the connections graph, not the tool allowlist: an agent's
  // toolPermissions scope which MCP/PDF tools it gets, but must never silently sever
  // delegation the user already wired up via a connection.
  if (agentId && getConnectionsForAgent(agentId).length > 0) {
    result = [...result, DELEGATE_TOOL];
  }

  // Take Control comes with the browser: any agent that can drive it can hand it over.
  if (result.some(t => t.serverName === 'playwright')) {
    result = [...result, TAKE_CONTROL_TOOL];
  }

  return result;
}

export function formatToolsForOpenAI(tools: MCPToolWithServer[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return tools.map(tool => ({
    type: 'function' as const,
    function: {
      name: `${tool.serverName}__${tool.name}`,
      description: `[${tool.serverName}] ${tool.description}`,
      parameters: tool.inputSchema,
    },
  }));
}

export function formatToolsForAnthropic(tools: MCPToolWithServer[]): Array<{
    name: string;
    description: string;
    input_schema: {
      type: 'object';
      properties?: Record<string, unknown>;
      required?: string[];
    };
  }> {
    return tools.map(tool => ({
      name: `${tool.serverName}__${tool.name}`,
      description: `[${tool.serverName}] ${tool.description}`,
      input_schema: {
        type: 'object' as const,
        properties: (tool.inputSchema.properties ?? {}) as Record<string, unknown>,
        required: (tool.inputSchema.required ?? []) as string[],
      },
    }));
  }

type DesiredEntry =
  | { type: 'stdio'; server: MCPServer; fingerprint: string }
  | { type: 'sse'; server: MCPSSEServer; fingerprint: string }
  | { type: 'unbuildable'; error: string; fingerprint: string };

async function syncConnections(): Promise<void> {
  const desired = new Map<string, DesiredEntry>();

  for (const config of SERVER_CONFIGS) {
    const requiresCredential = config.requiresCredential ?? true;
    const credential = requiresCredential ? getCredentialForProvider(config.credentialProvider) : '';
    if (requiresCredential && !credential) continue;
    const server = await buildBuiltinServer(config, credential ?? '');
    if ('error' in server) {
      desired.set(config.name, { type: 'unbuildable', error: server.error, fingerprint: credential ?? '' });
      continue;
    }
    const fingerprint = requiresCredential ? (credential ?? '') : `${server.command}|${server.args.join('|')}`;
    desired.set(config.name, { type: 'stdio', server, fingerprint });
  }

  for (const cs of getAllCustomMCPServers()) {
    if (cs.transport === 'sse' && cs.url) {
      desired.set(cs.name, {
        type: 'sse',
        server: { name: cs.name, url: cs.url },
        fingerprint: cs.url,
      });
    } else if (cs.transport === 'stdio' && cs.command) {
      desired.set(cs.name, {
        type: 'stdio',
        server: { name: cs.name, command: cs.command, args: cs.args, env: cs.envVars },
        fingerprint: `${cs.command}|${cs.args.join('|')}`,
      });
    }
  }

  const currentNames = new Set(getConnectedServers());

  // Disconnect servers that are no longer desired. Failed ones are included so a
  // removed server doesn't keep reporting its old failure.
  for (const name of new Set([...currentNames, ...getFailedServers()])) {
    if (!desired.has(name)) {
      await disconnectServer(name);
    }
  }

  // Every desired server that isn't up is retried below. Drop its old failure now
  // so it reads as starting, not failed, until this pass reaches it.
  for (const name of getFailedServers()) {
    if (desired.has(name)) clearConnectionError(name);
  }

  // Connect new servers and reconnect any whose credential changed
  for (const [name, entry] of desired.entries()) {
    const existing = getCredentialFingerprint(name);
    if (existing !== undefined && existing === entry.fingerprint) {
      continue; // already connected with the same credential — leave it alone
    }
    if (currentNames.has(name)) {
      await disconnectServer(name); // credential changed — tear down old connection only
    }
    if (entry.type === 'unbuildable') {
      recordConnectionError(name, entry.error);
    } else if (entry.type === 'sse') {
      await connectToSSEServer(entry.server, entry.fingerprint);
    } else {
      await connectToServer(entry.server, entry.fingerprint);
    }
  }
}

let reloadInProgress = false;
let reloadQueued = false;

export async function reloadToolRegistry(): Promise<void> {
  if (reloadInProgress) {
    reloadQueued = true; // collapse concurrent calls into one follow-up
    return;
  }
  reloadInProgress = true;
  try {
    console.log('[ToolRegistry] Reloading integrations...');
    await syncConnections();
    if (reloadQueued) {
      reloadQueued = false;
      console.log('[ToolRegistry] Processing queued reload...');
      await syncConnections();
    }
  } finally {
    reloadInProgress = false;
    notifyIfIdle();
  }
}