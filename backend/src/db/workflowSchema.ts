import type { Database as SqlJsDatabase } from 'sql.js';

// Recorded browser workflows: a site agent owns workflows; a workflow is a
// chain of immutable versions, each holding its own copy of the steps; runs
// record which version they executed.
//
// Everything here is additive: new tables and new indexes only, all
// IF NOT EXISTS, so it is idempotent across startups and an existing install
// upgrades by simply gaining empty tables. No existing table is altered.
//
// Integrity rules live in workflowRepository.ts, not in the schema:
// - No FOREIGN KEY clauses. Nothing sets PRAGMA foreign_keys, and sql.js's
//   export() (run on every persist) reopens the database, which would reset
//   that pragma anyway. Cascades are done by the repository.
// - No CHECK constraints on enum-like columns (action, status, ...). SQLite
//   can't ALTER a CHECK, so adding a value later would mean rebuilding the
//   table on every install. The repository validates these instead.
//
// Secret values never sit in a plaintext column. Where a value can be secret
// there are two columns: `<name>` (plaintext, NULL when secret) and
// `<name>_enc` (vault ciphertext from encryptValue, NULL when not secret).
// A reader that forgets to decrypt sees NULL or ciphertext, never the secret.
export function migrateWorkflowTables(db: SqlJsDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS site_agents (
      id TEXT PRIMARY KEY,
      site_key TEXT NOT NULL,
      name TEXT NOT NULL,
      emoji TEXT,
      start_url TEXT NOT NULL,
      credential_id TEXT,
      profile_dir TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      site_agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_versions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      parent_version_id TEXT,
      reason TEXT NOT NULL,
      repaired_step_key TEXT,
      from_run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      action TEXT NOT NULL,
      locator TEXT,
      fingerprint TEXT NOT NULL DEFAULT '{}',
      page_alias TEXT NOT NULL DEFAULT 'page',
      origin TEXT,
      args TEXT NOT NULL DEFAULT '{}',
      value_source TEXT NOT NULL DEFAULT 'none',
      value_target TEXT,
      literal_value TEXT,
      literal_value_enc TEXT,
      literal_secret INTEGER NOT NULL DEFAULT 0,
      field_id TEXT,
      credential_part TEXT,
      signals TEXT NOT NULL DEFAULT '[]',
      requires_confirmation INTEGER NOT NULL DEFAULT 0,
      snapshot_path TEXT
    );
    CREATE TABLE IF NOT EXISTS workflow_fields (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'text',
      secret INTEGER NOT NULL DEFAULT 0,
      recorded_value TEXT,
      recorded_value_enc TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      version_id TEXT NOT NULL,
      site_agent_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      inputs TEXT NOT NULL DEFAULT '{}',
      failed_step_key TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    -- A workflow's icon when the person picked one; otherwise it's derived
    -- from the name (deriveAgentEmoji), like an agent's.
    CREATE TABLE IF NOT EXISTS workflow_icons (
      workflow_id TEXT PRIMARY KEY,
      emoji TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      position INTEGER NOT NULL,
      status TEXT NOT NULL,
      resolved_by TEXT,
      duration_ms INTEGER,
      url TEXT,
      error TEXT,
      screenshot_path TEXT,
      created_at TEXT NOT NULL
    );

    -- Named in the data-model report.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_site_agents_site_key ON site_agents(site_key);
    CREATE INDEX IF NOT EXISTS idx_workflow_steps_version_position ON workflow_steps(version_id, position);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_started ON workflow_runs(workflow_id, started_at);

    -- Added: lookups and cascades the repository does on every call.
    CREATE INDEX IF NOT EXISTS idx_workflows_site_agent ON workflows(site_agent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_versions_number ON workflow_versions(workflow_id, number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_steps_version_key ON workflow_steps(version_id, step_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_fields_key ON workflow_fields(workflow_id, key);
    CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, position);
  `);
}
