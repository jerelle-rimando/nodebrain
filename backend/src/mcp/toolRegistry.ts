import { connectToServer, connectToSSEServer, getAllAvailableTools, getConnectedServers, getConnectionError, disconnectServer, getCredentialFingerprint, type MCPServer, type MCPSSEServer, type MCPToolWithServer } from './mcpClient';
import { getCredentialForProvider } from '../vault/credentialVault';
import { readPdfAsText } from '../utils/pdfReader';
import { getAllCustomMCPServers } from '../db/mcpServerRepository';
import { getConnectionsForAgent } from '../db/agentConnectionRepository';

interface ServerConfig {
  name: string;
  credentialProvider: string;
  buildServer: (credential: string) => MCPServer;
}

// Versions are pinned deliberately — do NOT automate updates or remove the @version suffix.
// Pinning prevents silent supply-chain re-resolution: without a version, npx re-checks the
// npm registry on every reconnect and may silently pull a newer (potentially malicious) release.
// To upgrade a server, manually verify the new release and update the version string here.
const SERVER_CONFIGS: ServerConfig[] = [
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
    buildServer: (token) => ({
      name: 'slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack@2025.4.25'],
      env: { SLACK_BOT_TOKEN: token },
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
    name: 'brave-search',
    credentialProvider: 'brave',
    buildServer: (token) => ({
      name: 'brave-search',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server@2.0.85'],
      env: { BRAVE_API_KEY: token },
    }),
  },
];

type DiagEntry = { name: string; status: 'connected' | 'failed' | 'skipped'; detail: string };

let resolveRegistryReady!: () => void;
export const toolRegistryReady: Promise<void> = new Promise(resolve => {
  resolveRegistryReady = resolve;
});

const REGISTRY_READY_TIMEOUT_MS = 30_000;

export async function initializeToolRegistry(): Promise<void> {
  try {
    console.log('[ToolRegistry] Checking available integrations...');

    const diag: DiagEntry[] = [];

    for (const config of SERVER_CONFIGS) {
      const credential = getCredentialForProvider(config.credentialProvider);

      if (!credential) {
        console.log(`[ToolRegistry] Skipping "${config.name}" — no credential in vault`);
        diag.push({ name: config.name, status: 'skipped', detail: 'no credential in vault' });
        continue;
      }

      const server = config.buildServer(credential ?? '');
      await connectToServer(server, credential ?? '');

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
    resolveRegistryReady();
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

export async function getToolsForAgent(agentId?: string): Promise<MCPToolWithServer[]> {
  await Promise.race([
    toolRegistryReady,
    new Promise<void>(resolve => setTimeout(resolve, REGISTRY_READY_TIMEOUT_MS)),
  ]);
  const mcpTools = await getAllAvailableTools();
  const tools: MCPToolWithServer[] = [...mcpTools, PDF_TOOL];
  if (agentId) {
    const connections = getConnectionsForAgent(agentId);
    if (connections.length > 0) tools.push(DELEGATE_TOOL);
  }
  return tools;
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
  | { type: 'sse'; server: MCPSSEServer; fingerprint: string };

async function syncConnections(): Promise<void> {
  const desired = new Map<string, DesiredEntry>();

  for (const config of SERVER_CONFIGS) {
    const credential = getCredentialForProvider(config.credentialProvider);
    if (!credential) continue;
    desired.set(config.name, {
      type: 'stdio',
      server: config.buildServer(credential),
      fingerprint: credential,
    });
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

  // Disconnect servers that are no longer desired
  for (const name of currentNames) {
    if (!desired.has(name)) {
      await disconnectServer(name);
    }
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
    if (entry.type === 'sse') {
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
  }
}