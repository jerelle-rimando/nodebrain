import { dbAll, dbGet } from './database';

export interface UsageRecord {
  id: string;
  taskId: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  timestamp: string;
}

interface UsageRow {
  id: string;
  task_id: string | null;
  agent_id: string | null;
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  timestamp: string;
}

function rowToRecord(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    timestamp: row.timestamp,
  };
}

export function getAllUsage(): UsageRecord[] {
  return dbAll<UsageRow>('SELECT * FROM usage_records ORDER BY timestamp DESC').map(rowToRecord);
}

export function getUsageByAgent(agentId: string): UsageRecord[] {
  return dbAll<UsageRow>(
    'SELECT * FROM usage_records WHERE agent_id = ? ORDER BY timestamp DESC',
    [agentId],
  ).map(rowToRecord);
}

export function getUsageSince(timestamp: string): UsageRecord[] {
  return dbAll<UsageRow>(
    'SELECT * FROM usage_records WHERE timestamp >= ? ORDER BY timestamp DESC',
    [timestamp],
  ).map(rowToRecord);
}

export function getTotalCost(): number {
  const row = dbGet<{ total: number }>(
    'SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM usage_records',
  );
  return row?.total ?? 0;
}

export interface CostByProvider {
  provider: string;
  totalCostUsd: number;
  totalTokens: number;
}

export function getCostByProvider(): CostByProvider[] {
  return dbAll<{ provider: string; total_cost_usd: number; total_tokens: number }>(
    `SELECT provider,
            COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
            COALESCE(SUM(total_tokens), 0)        AS total_tokens
     FROM usage_records
     WHERE provider IS NOT NULL
     GROUP BY provider
     ORDER BY total_cost_usd DESC`,
  ).map(r => ({ provider: r.provider, totalCostUsd: r.total_cost_usd, totalTokens: r.total_tokens }));
}

export interface CostByAgent {
  agentId: string;
  totalCostUsd: number;
  totalTokens: number;
}

export function getCostByAgent(): CostByAgent[] {
  return dbAll<{ agent_id: string; total_cost_usd: number; total_tokens: number }>(
    `SELECT agent_id,
            COALESCE(SUM(estimated_cost_usd), 0) AS total_cost_usd,
            COALESCE(SUM(total_tokens), 0)        AS total_tokens
     FROM usage_records
     WHERE agent_id IS NOT NULL
     GROUP BY agent_id
     ORDER BY total_cost_usd DESC
     LIMIT 10`,
  ).map(r => ({ agentId: r.agent_id, totalCostUsd: r.total_cost_usd, totalTokens: r.total_tokens }));
}

export interface TasksPerDay {
  date: string;
  count: number;
}

export function getTasksPerDay(): TasksPerDay[] {
  return dbAll<{ date: string; count: number }>(
    `SELECT DATE(timestamp) AS date, COUNT(DISTINCT task_id) AS count
     FROM usage_records
     WHERE timestamp >= DATE('now', '-30 days')
       AND task_id IS NOT NULL
     GROUP BY DATE(timestamp)
     ORDER BY date ASC`,
  ).map(r => ({ date: r.date, count: r.count }));
}
