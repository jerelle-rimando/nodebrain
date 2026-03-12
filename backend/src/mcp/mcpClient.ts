import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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

export interface MCPToolWithServer extends MCPTool {
  serverName: string;
}

interface ActiveConnection {
  client: Client;
  tools: MCPTool[];
}

const activeConnections = new Map<string, ActiveConnection>();

export async function connectToServer(server: MCPServer): Promise<MCPTool[]> {
  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...process.env,
        ...server.env,
      } as Record<string, string>,
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

    activeConnections.set(server.name, { client, tools });
    console.log(`[MCP] Connected to "${server.name}" — ${tools.length} tools available`);

    return tools;
  } catch (err) {
    console.error(`[MCP] Failed to connect to "${server.name}":`, err);
    return [];
  }
}

export async function callTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const connection = activeConnections.get(serverName);
  if (!connection) {
    throw new Error(`MCP server "${serverName}" is not connected. Add the credential in the Vault.`);
  }

  const result = await connection.client.callTool({
    name: toolName,
    arguments: args,
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  return content
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n');
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