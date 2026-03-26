import { connectToServer, getAllAvailableTools, disconnectAll, type MCPServer, type MCPToolWithServer } from './mcpClient';
import { getCredentialForProvider } from '../vault/credentialVault';

interface ServerConfig {
  name: string;
  credentialProvider: string;
  buildServer: (credential: string) => MCPServer;
}

const SERVER_CONFIGS: ServerConfig[] = [
  {
    name: 'telegram',
    credentialProvider: 'telegram',
    buildServer: (token) => ({
      name: 'telegram',
      command: 'npx',
      args: ['-y', '@iqai/mcp-telegram'],
      env: { TELEGRAM_BOT_TOKEN: token },
    }),
  },
  {
    name: 'google',
    credentialProvider: 'google',
    buildServer: (tokenJson) => {
      let accessToken = tokenJson;
      try {
        const parsed = JSON.parse(tokenJson) as { access_token?: string };
        accessToken = parsed.access_token ?? tokenJson;
      } catch {
        // use raw value if not JSON
      }
      return {
        name: 'google',
        command: 'gws',
        args: ['mcp'],
        env: { GOOGLE_OAUTH_TOKEN: accessToken },
      };
    },
  },
  {
    name: 'github',
    credentialProvider: 'github',
    buildServer: (token) => ({
      name: 'github',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
    }),
  },
  {
    name: 'slack',
    credentialProvider: 'slack',
    buildServer: (token) => ({
      name: 'slack',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-slack'],
      env: { SLACK_BOT_TOKEN: token },
    }),
  },
  {
    name: 'notion',
    credentialProvider: 'notion',
    buildServer: (token) => ({
      name: 'notion',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
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
      args: ['-y', '@modelcontextprotocol/server-filesystem', allowedPath],
      env: {},
    }),
  },
  {
    name: 'brave-search',
    credentialProvider: 'brave',
    buildServer: (token) => ({
      name: 'brave-search',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: token },
    }),
  },
];

export async function initializeToolRegistry(): Promise<void> {
  console.log('[ToolRegistry] Checking available integrations...');

  for (const config of SERVER_CONFIGS) {
    const credential = getCredentialForProvider(config.credentialProvider);

    if (!credential && config.credentialProvider !== 'google') {
      console.log(`[ToolRegistry] Skipping "${config.name}" — no credential in vault`);
      continue;
    }

    const server = config.buildServer(credential ?? '');
    await connectToServer(server);
  }

  const tools = await getAllAvailableTools();
  console.log(`[ToolRegistry] Ready — ${tools.length} tools available`);
}

export async function getToolsForAgent(): Promise<MCPToolWithServer[]> {
  return getAllAvailableTools();
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

  export async function reloadToolRegistry(): Promise<void> {
    console.log('[ToolRegistry] Reloading integrations...');
    await disconnectAll();
    await initializeToolRegistry();
  }