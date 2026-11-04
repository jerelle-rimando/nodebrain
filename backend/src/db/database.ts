import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import path from 'path';
import fs from 'fs';
import { migrateWorkflowTables } from './workflowSchema';

const DB_DIR = process.env.NODEBRAIN_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = path.join(DB_DIR, 'nodebrain.db');

// The folder holding nodebrain.db. Other per-install data (browser profiles,
// recorded page snapshots) lives beside it.
export function getDataDir(): string {
  return DB_DIR;
}

let _db: SqlJsDatabase | null = null;
// >0 while dbTransaction is running: writes are held in memory and persisted
// once at COMMIT, so a multi-row write lands on disk whole or not at all.
let _txDepth = 0;

function persist(): void {
  if (!_db || _txDepth > 0) return;
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

// Runs fn inside BEGIN/COMMIT and writes the file once at the end. On a throw
// the transaction is rolled back and nothing is persisted. Nested calls join
// the outer transaction. fn must be synchronous (sql.js is).
export function dbTransaction<T>(fn: () => T): T {
  const db = getDb();
  if (_txDepth > 0) return fn();
  db.run('BEGIN');
  _txDepth++;
  let result: T;
  try {
    result = fn();
    db.run('COMMIT');
  } catch (err) {
    // A failed COMMIT can leave SQLite already rolled back; ROLLBACK then
    // throws "no transaction is active", which would hide the real error.
    try { db.run('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    _txDepth--;
  }
  persist();
  return result;
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
      emoji TEXT,
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
      created_at TEXT NOT NULL,
      base_url TEXT
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
      created_at TEXT NOT NULL,
      access_warning TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_connections (
      id TEXT PRIMARY KEY,
      source_agent_id TEXT NOT NULL,
      target_agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      agent_id TEXT,
      provider TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      estimated_cost_usd REAL,
      timestamp TEXT
    );
  `);

  // Migration: add base_url to existing credentials tables that predate the column.
  // Fresh DBs already have the column from the CREATE TABLE above, so ALTER is skipped.
  {
    const stmt = _db.prepare('PRAGMA table_info(credentials)');
    const cols: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name: string };
      cols.push(row.name);
    }
    stmt.free();
    if (cols.length > 0 && !cols.includes('base_url')) {
      _db.run('ALTER TABLE credentials ADD COLUMN base_url TEXT');
    }
  }

  // Migration: add emoji to existing agents tables that predate the column.
  // Mirrors the base_url migration above: PRAGMA-guarded so the ALTER runs at
  // most once. A bare unconditional `ALTER TABLE agents ADD COLUMN emoji` would
  // throw "duplicate column name: emoji" on the second startup — and migrations
  // run on every startup — leaving the app unable to launch. Fresh DBs already
  // have the column from the CREATE TABLE above, so the ALTER is skipped there.
  {
    const stmt = _db.prepare('PRAGMA table_info(agents)');
    const cols: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name: string };
      cols.push(row.name);
    }
    stmt.free();
    if (cols.length > 0 && !cols.includes('emoji')) {
      _db.run('ALTER TABLE agents ADD COLUMN emoji TEXT');
    }
  }

  // Migration: add access_warning to existing custom_mcp_servers tables. Same
  // PRAGMA guard as above. Existing rows start NULL and are assessed on the
  // next GET /mcp-servers, so servers added before this column get flagged too.
  {
    const stmt = _db.prepare('PRAGMA table_info(custom_mcp_servers)');
    const cols: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name: string };
      cols.push(row.name);
    }
    stmt.free();
    if (cols.length > 0 && !cols.includes('access_warning')) {
      _db.run('ALTER TABLE custom_mcp_servers ADD COLUMN access_warning TEXT');
    }
  }

  // Migration: llama-3.3-70b-versatile was decommissioned on Groq. Rescue any
  // already-stored agents pointing at it so they don't 400 on their next run.
  // Idempotent — safe to run on every startup, no-ops once no rows match.
  _db.run(
    "UPDATE agents SET model = 'openai/gpt-oss-120b' WHERE model = 'llama-3.3-70b-versatile' AND provider = 'groq'",
  );

  // Recorded browser workflows: new tables and indexes only (IF NOT EXISTS);
  // nothing existing is altered. See workflowSchema.ts.
  migrateWorkflowTables(_db);

  persist();
}

export function closeDb(): void {
  if (_db) {
    persist();
    _db.close();
    _db = null;
  }
}
