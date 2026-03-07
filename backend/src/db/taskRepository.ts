import { dbRun, dbGet, dbAll } from './database';
import type { Task, TaskLog, TaskStatus, LogLevel } from '../../shared-types';

interface TaskRow {
  id: string; agent_id: string; name: string; description: string;
  input: string | null; output: string | null; status: string;
  created_at: string; completed_at: string | null; error: string | null;
}

interface LogRow {
  id: string; task_id: string; agent_id: string; level: string;
  message: string; timestamp: string; metadata: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id, agentId: row.agent_id, name: row.name, description: row.description,
    input: row.input ?? undefined, output: row.output ?? undefined,
    status: row.status as TaskStatus, createdAt: row.created_at,
    completedAt: row.completed_at ?? undefined, error: row.error ?? undefined,
  };
}

function rowToLog(row: LogRow): TaskLog {
  return {
    id: row.id, taskId: row.task_id, agentId: row.agent_id,
    level: row.level as LogLevel, message: row.message, timestamp: row.timestamp,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export function getAllTasks(): Task[] {
  return dbAll<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100').map(rowToTask);
}

export function getTasksByAgent(agentId: string): Task[] {
  return dbAll<TaskRow>('SELECT * FROM tasks WHERE agent_id = ? ORDER BY created_at DESC', [agentId]).map(rowToTask);
}

export function getTaskById(id: string): Task | null {
  const row = dbGet<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id]);
  return row ? rowToTask(row) : null;
}

export function createTask(task: Task): Task {
  dbRun(
    `INSERT INTO tasks (id, agent_id, name, description, input, output, status, created_at, completed_at, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.id, task.agentId, task.name, task.description, task.input ?? null,
     task.output ?? null, task.status, task.createdAt, task.completedAt ?? null, task.error ?? null],
  );
  return task;
}

export function updateTaskStatus(id: string, status: TaskStatus, output?: string, error?: string): void {
  const completedAt = (status === 'completed' || status === 'failed') ? new Date().toISOString() : null;
  dbRun('UPDATE tasks SET status=?, output=?, error=?, completed_at=? WHERE id=?',
    [status, output ?? null, error ?? null, completedAt, id]);
}

export function createLog(log: TaskLog): void {
  dbRun(
    `INSERT INTO task_logs (id, task_id, agent_id, level, message, timestamp, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [log.id, log.taskId, log.agentId, log.level, log.message, log.timestamp,
     log.metadata ? JSON.stringify(log.metadata) : null],
  );
}

export function getLogsByTask(taskId: string): TaskLog[] {
  return dbAll<LogRow>('SELECT * FROM task_logs WHERE task_id = ? ORDER BY timestamp ASC', [taskId]).map(rowToLog);
}

export function getLogsByAgent(agentId: string, limit = 100): TaskLog[] {
  return dbAll<LogRow>('SELECT * FROM task_logs WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?', [agentId, limit]).map(rowToLog).reverse();
}

export function getAllRecentLogs(limit = 200): TaskLog[] {
  return dbAll<LogRow>('SELECT * FROM task_logs ORDER BY timestamp DESC LIMIT ?', [limit]).map(rowToLog).reverse();
}
