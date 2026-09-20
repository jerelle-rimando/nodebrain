import { dbRun, dbGet, dbAll } from './database';
import type { Agent, AgentConfig, ModelProvider, AgentStatus } from '../../shared-types';
import { agentEvents, resolveAgentModel } from '../agents/agentEngine';

interface AgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  system_prompt: string;
  schedule: string | null;
  emoji: string | null;
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
    emoji: row.emoji ?? undefined,
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
  // Single chokepoint for every creation path (chat, POST /agents, templates).
  // Mutates in place so callers that return/emit `agent` see the stored value.
  agent.model = resolveAgentModel(agent.provider, agent.model, `createAgent("${agent.name}")`);
  dbRun(
    `INSERT INTO agents (id, name, description, provider, model, system_prompt, schedule, emoji, tool_permissions, status, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      agent.id, agent.name, agent.description, agent.provider, agent.model,
      agent.systemPrompt, agent.schedule ?? null, agent.emoji ?? null,
      JSON.stringify(agent.toolPermissions), agent.status,
      JSON.stringify(agent.config), agent.createdAt, agent.updatedAt,
    ],
  );
  agentEvents.emit('agent:created', agent);
  return agent;
}

export function updateAgent(id: string, updates: Partial<Agent>): Agent | null {
  const existing = getAgentById(id);
  if (!existing) return null;
  const updated: Agent = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
  // Validate the merged provider/model pair so PATCHing either field alone
  // can't leave a model that doesn't belong to the provider.
  updated.model = resolveAgentModel(updated.provider, updated.model, `updateAgent(${id})`);
  dbRun(
    `UPDATE agents SET name=?, description=?, provider=?, model=?, system_prompt=?,
     schedule=?, emoji=?, tool_permissions=?, status=?, config=?, updated_at=? WHERE id=?`,
    [
      updated.name, updated.description, updated.provider, updated.model,
      updated.systemPrompt, updated.schedule ?? null, updated.emoji ?? null,
      JSON.stringify(updated.toolPermissions), updated.status,
      JSON.stringify(updated.config), updated.updatedAt, id,
    ],
  );
  agentEvents.emit('agent:updated', updated);
  return updated;
}

export function deleteAgent(id: string): boolean {
  const existing = getAgentById(id);
  if (!existing) return false;
  dbRun('DELETE FROM agents WHERE id = ?', [id]);
  agentEvents.emit('agent:deleted', { id });
  return true;
}

export function updateAgentStatus(id: string, status: AgentStatus): void {
  dbRun('UPDATE agents SET status=?, updated_at=? WHERE id=?', [status, new Date().toISOString(), id]);
}

// Startup repair: rewrites any stored agent whose model isn't valid for its
// provider (e.g. hallucinated at creation time, before validation existed) to
// the provider default. Idempotent; a no-op once every row is clean.
export function repairInvalidAgentModels(): number {
  const rows = dbAll<{ id: string; name: string; provider: string; model: string }>(
    'SELECT id, name, provider, model FROM agents',
  );
  let repaired = 0;
  for (const row of rows) {
    const fixed = resolveAgentModel(row.provider, row.model, `repair "${row.name}"`);
    if (fixed === row.model) continue;
    dbRun('UPDATE agents SET model=?, updated_at=? WHERE id=?', [fixed, new Date().toISOString(), row.id]);
    repaired++;
  }
  return repaired;
}

// Startup reconciliation: an agent left 'running' when the process starts up
// is necessarily stale — nothing has executed yet at this point, so there is
// no "genuinely running" case to distinguish. Safe on an empty database and
// idempotent across restarts.
export function reconcileOrphanedAgents(): number {
  const stale = dbAll<{ id: string }>('SELECT id FROM agents WHERE status = ?', ['running']);
  if (stale.length === 0) return 0;
  dbRun(
    'UPDATE agents SET status=?, updated_at=? WHERE status=?',
    ['idle', new Date().toISOString(), 'running'],
  );
  return stale.length;
}
