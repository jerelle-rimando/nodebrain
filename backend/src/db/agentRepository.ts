import { dbRun, dbGet, dbAll } from './database';
import type { Agent, AgentConfig, ModelProvider, AgentStatus } from '../../shared-types';

interface AgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  system_prompt: string;
  schedule: string | null;
  tool_permissions: string;
  status: string;
  config: string;
  created_at: string;
  updated_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider as ModelProvider,
    model: row.model,
    systemPrompt: row.system_prompt,
    schedule: row.schedule ?? undefined,
    toolPermissions: JSON.parse(row.tool_permissions),
    status: row.status as AgentStatus,
    config: JSON.parse(row.config) as AgentConfig,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllAgents(): Agent[] {
  const rows = dbAll<AgentRow>('SELECT * FROM agents ORDER BY created_at DESC');
  return rows.map(rowToAgent);
}

export function getAgentById(id: string): Agent | null {
  const row = dbGet<AgentRow>('SELECT * FROM agents WHERE id = ?', [id]);
  return row ? rowToAgent(row) : null;
}

export function createAgent(agent: Agent): Agent {
  dbRun(
    `INSERT INTO agents (id, name, description, provider, model, system_prompt, schedule, tool_permissions, status, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agent.id, agent.name, agent.description, agent.provider, agent.model,
      agent.systemPrompt, agent.schedule ?? null,
      JSON.stringify(agent.toolPermissions), agent.status,
      JSON.stringify(agent.config), agent.createdAt, agent.updatedAt,
    ],
  );
  return agent;
}

export function updateAgent(id: string, updates: Partial<Agent>): Agent | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  const updated: Agent = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  dbRun(
    `UPDATE agents SET name=?, description=?, provider=?, model=?, system_prompt=?,
     schedule=?, tool_permissions=?, status=?, config=?, updated_at=? WHERE id=?`,
    [
      updated.name, updated.description, updated.provider, updated.model,
      updated.systemPrompt, updated.schedule ?? null,
      JSON.stringify(updated.toolPermissions), updated.status,
      JSON.stringify(updated.config), updated.updatedAt, id,
    ],
  );
  return updated;
}

export function deleteAgent(id: string): boolean {
  const existing = getAgentById(id);
  if (!existing) return false;
  dbRun('DELETE FROM agents WHERE id = ?', [id]);
  return true;
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  dbRun('UPDATE agents SET status=?, updated_at=? WHERE id=?', [status, new Date().toISOString(), id]);
}
