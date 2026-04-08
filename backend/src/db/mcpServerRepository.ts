import { dbRun, dbGet, dbAll } from './database';
import { v4 as uuidv4 } from 'uuid';
import { encryptValue, decryptValue } from '../vault/credentialVault';

export interface CustomMCPServer {
  id: string;
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args: string[];
  url?: string;
  envVars: Record<string, string>;
  createdAt: string;
}

interface MCPServerRow {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string;
  url: string | null;
  env_vars: string;
  created_at: string;
}

function rowToServer(row: MCPServerRow): CustomMCPServer {
  const encryptedEnvVars = JSON.parse(row.env_vars) as Record<string, string>;
  const decryptedEnvVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(encryptedEnvVars)) {
    decryptedEnvVars[k] = decryptValue(v);
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport as 'stdio' | 'sse',
    command: row.command ?? undefined,
    args: JSON.parse(row.args) as string[],
    url: row.url ?? undefined,
    envVars: decryptedEnvVars,
    createdAt: row.created_at,
  };
}

export function getAllCustomMCPServers(): CustomMCPServer[] {
  return dbAll<MCPServerRow>('SELECT * FROM custom_mcp_servers ORDER BY created_at DESC').map(rowToServer);
}

export function getCustomMCPServerById(id: string): CustomMCPServer | null {
  const row = dbGet<MCPServerRow>('SELECT * FROM custom_mcp_servers WHERE id = ?', [id]);
  return row ? rowToServer(row) : null;
}

export function createCustomMCPServer(data: Omit<CustomMCPServer, 'id' | 'createdAt'>): CustomMCPServer {
  const id = uuidv4();
  const now = new Date().toISOString();
  const encryptedEnvVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(data.envVars)) {
    encryptedEnvVars[k] = encryptValue(v);
  }
  dbRun(
    `INSERT INTO custom_mcp_servers (id, name, transport, command, args, url, env_vars, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.name,
      data.transport,
      data.command ?? null,
      JSON.stringify(data.args),
      data.url ?? null,
      JSON.stringify(encryptedEnvVars),
      now,
    ],
  );
  return { ...data, id, createdAt: now };
}

export function deleteCustomMCPServer(id: string): boolean {
  const existing = getCustomMCPServerById(id);
  if (!existing) return false;
  dbRun('DELETE FROM custom_mcp_servers WHERE id = ?', [id]);
  return true;
}