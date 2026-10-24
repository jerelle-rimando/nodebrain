import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { telemetry } from '../utils/telemetry';
import { describeMcpError } from '../utils/describeMcpError';

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServer {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface MCPSSEServer {
  name: string;
  url: string;
}

export interface MCPToolWithServer extends MCPTool {
  serverName: string;
}

interface ActiveConnection {
  client: Client;
  tools: MCPTool[];
  fingerprint: string;
}

const activeConnections = new Map<string, ActiveConnection>();
const connectionErrors = new Map<string, string>();

export function getConnectionError(name: string): string | undefined {
  return connectionErrors.get(name);
}

// Names of servers whose most recent connect attempt failed. An entry is cleared
// when a new attempt starts or the server is disconnected, so this never lists a
// server that has since come up.
export function getFailedServers(): string[] {
  return Array.from(connectionErrors.keys());
}

export function clearConnectionError(name: string): void {
  connectionErrors.delete(name);
}

// How much of a server's startup stderr to keep for diagnosing a failed connect.
const STDERR_TAIL_CHARS = 4000;

export async function connectToServer(server: MCPServer, fingerprint = ''): Promise<MCPTool[]> {
  connectionErrors.delete(server.name);
  // On Windows cross-spawn runs an unresolvable command through cmd.exe, so a
  // missing npx surfaces only as "Connection closed" plus cmd's "is not
  // recognized" on stderr. Keep a tail of stderr so the failure can say why.
  // Everything is still forwarded to our own stderr, as 'inherit' did.
  let stderrTail = '';
  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...process.env,
        ...server.env,
      } as Record<string, string>,
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });

    const client = new Client(
      { name: 'nodebrain', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: MCPTool[] = toolsResult.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));

    activeConnections.set(server.name, { client, tools, fingerprint });
    console.log(`[MCP] Connected to "${server.name}" — ${tools.length} tools available`);

    return tools;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    connectionErrors.set(server.name, stderrTail ? `${msg}\n${stderrTail}` : msg);
    console.error(`[MCP] Failed to connect to "${server.name}":`, err);
    telemetry('setup_failed', { stage: 'mcp', reasonCode: 'mcp_spawn_failed' });
    return [];
  }
}

export async function connectToSSEServer(server: MCPSSEServer, fingerprint = ''): Promise<MCPTool[]> {
  connectionErrors.delete(server.name);
  try {
    const transport = new SSEClientTransport(new URL(server.url));

    const client = new Client(
      { name: 'nodebrain', version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: MCPTool[] = toolsResult.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));

    activeConnections.set(server.name, { client, tools, fingerprint });
    console.log(`[MCP] Connected to SSE server "${server.name}" — ${tools.length} tools available`);

    return tools;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    connectionErrors.set(server.name, msg);
    console.error(`[MCP] Failed to connect to SSE server "${server.name}":`, err);
    telemetry('setup_failed', { stage: 'mcp', reasonCode: 'mcp_connect_failed' });
    return [];
  }
}

export async function disconnectServer(name: string): Promise<void> {
  connectionErrors.delete(name);
  const conn = activeConnections.get(name);
  if (!conn) return;
  try { await conn.client.close(); } catch { /* ignore */ }
  activeConnections.delete(name);
  console.log(`[MCP] Disconnected from "${name}"`);
}

export function getCredentialFingerprint(name: string): string | undefined {
  return activeConnections.get(name)?.fingerprint;
}

export async function callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const connection = activeConnections.get(serverName);
  if (!connection) {
    // A missing connection almost never means a missing credential (servers without
    // one are never offered as tools) — it means the server didn't start. Say why.
    const error = connectionErrors.get(serverName);
    throw new Error(error
      ? `The "${serverName}" integration isn't available. ${describeMcpError(error)}`
      : `The "${serverName}" integration isn't running right now. Check it on the Integrations page.`);
  }

  const result = await connection.client.callTool({
    name: toolName,
    arguments: args,
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n');

  if (result.isError) {
    throw new Error(text || `Tool "${toolName}" on server "${serverName}" returned an error`);
  }

  return text;
}

export async function getAllAvailableTools(): Promise<MCPToolWithServer[]> {
  const allTools: MCPToolWithServer[] = [];
  for (const [serverName, connection] of activeConnections.entries()) {
    for (const tool of connection.tools) {
      allTools.push({ ...tool, serverName });
    }
  }
  return allTools;
}

export function getConnectedServers(): string[] {
  return Array.from(activeConnections.keys());
}

export async function disconnectAll(): Promise<void> {
  for (const [name, connection] of activeConnections.entries()) {
    try {
      await connection.client.close();
      console.log(`[MCP] Disconnected from "${name}"`);
    } catch {
      // ignore
    }
  }
  activeConnections.clear();
}