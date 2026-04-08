import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DB_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'nodebrain.db');

let _db: SqlJsDatabase | null = null;

function persist(): void {
  if (!_db) return;
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

export function dbRun(sql: string, params: (string | number | null)[] = []): void {
  const db = getDb();
  db.run(sql, params);
  persist();
}

export function dbGet<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject() as T;
    stmt.free();
    return row;
  }
  stmt.free();
  return undefined;
}

export function dbAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

export function getDb(): SqlJsDatabase {
  if (_db) return _db;
  throw new Error('Database not initialized. Call initDb() first.');
}

export async function initDb(): Promise<void> {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'openai',
      model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
      system_prompt TEXT NOT NULL DEFAULT '',
      schedule TEXT,
      tool_permissions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'idle',
      config TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      input TEXT,
      output TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      metadata TEXT
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      description TEXT,
      encrypted_value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      agent_id TEXT
    );
    CREATE TABLE IF NOT EXISTS custom_mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT,
      args TEXT NOT NULL DEFAULT '[]',
      url TEXT,
      env_vars TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);
  persist();
}

export function closeDb(): void {
  if (_db) {
    persist();
    _db.close();
    _db = null;
  }
}
