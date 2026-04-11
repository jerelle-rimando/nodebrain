import { dbRun, dbGet, dbAll } from './database';
import { v4 as uuidv4 } from 'uuid';
import type { AgentConnection } from '../../shared-types';

interface ConnectionRow {
  id: string;
  source_agent_id: string;
  target_agent_id: string;
  created_at: string;
}

function rowToConnection(row: ConnectionRow): AgentConnection {
  return {
    id: row.id,
    sourceAgentId: row.source_agent_id,
    targetAgentId: row.target_agent_id,
    createdAt: row.created_at,
  };
}

export function getAllConnections(): AgentConnection[] {
  return dbAll<ConnectionRow>(
    'SELECT * FROM agent_connections ORDER BY created_at ASC'
  ).map(rowToConnection);
}

export function getConnectionsForAgent(sourceAgentId: string): AgentConnection[] {
  return dbAll<ConnectionRow>(
    'SELECT * FROM agent_connections WHERE source_agent_id = ?',
    [sourceAgentId]
  ).map(rowToConnection);
}

export function createConnection(sourceAgentId: string, targetAgentId: string): AgentConnection {
  // Prevent self-connection
  if (sourceAgentId === targetAgentId) {
    throw new Error('An agent cannot connect to itself');
  }

  // Prevent duplicate connections
  const existing = dbGet<ConnectionRow>(
    'SELECT * FROM agent_connections WHERE source_agent_id = ? AND target_agent_id = ?',
    [sourceAgentId, targetAgentId]
  );
  if (existing) return rowToConnection(existing);

  const id = uuidv4();
  const now = new Date().toISOString();
  dbRun(
    'INSERT INTO agent_connections (id, source_agent_id, target_agent_id, created_at) VALUES (?, ?, ?, ?)',
    [id, sourceAgentId, targetAgentId, now]
  );
  return { id, sourceAgentId, targetAgentId, createdAt: now };
}

export function deleteConnection(id: string): boolean {
  const existing = dbGet<ConnectionRow>(
    'SELECT * FROM agent_connections WHERE id = ?',
    [id]
  );
  if (!existing) return false;
  dbRun('DELETE FROM agent_connections WHERE id = ?', [id]);
  return true;
}

export function deleteConnectionByAgents(sourceAgentId: string, targetAgentId: string): boolean {
  const existing = dbGet<ConnectionRow>(
    'SELECT * FROM agent_connections WHERE source_agent_id = ? AND target_agent_id = ?',
    [sourceAgentId, targetAgentId]
  );
  if (!existing) return false;
  dbRun(
    'DELETE FROM agent_connections WHERE source_agent_id = ? AND target_agent_id = ?',
    [sourceAgentId, targetAgentId]
  );
  return true;
}

export function deleteConnectionsForAgent(agentId: string): void {
  dbRun(
    'DELETE FROM agent_connections WHERE source_agent_id = ? OR target_agent_id = ?',
    [agentId, agentId]
  );
}