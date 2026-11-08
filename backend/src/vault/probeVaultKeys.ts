// One-shot child process: which candidate vault keys decrypt this install's
// data? Electron main runs it before the backend starts, when Credential
// Manager and the legacy settings-file copy hold different keys (see
// electron/vaultKey.ts).
//
// Input:  NODEBRAIN_VAULT_PROBE_KEYS = JSON array of candidate secrets (env, not
//         argv, so it isn't visible in process listings); NODEBRAIN_DATA_DIR.
// Output: one JSON line on stdout: { samples: number, works: boolean[] }.
//
// Read-only: the database file is loaded into memory and never written back.
// A candidate "works" only if it decrypts EVERY sampled value — CryptoJS has
// no MAC, so a wrong key can occasionally yield valid-looking UTF-8 for one
// short value, but not for all of them.

import fs from 'fs';
import path from 'path';
import initSqlJs, { Database } from 'sql.js';
import { decryptWithSecret } from './credentialVault';

const PER_SOURCE = 20;

function column(db: Database, sql: string): string[] {
  try {
    const out: string[] = [];
    const stmt = db.prepare(sql);
    while (stmt.step()) {
      const v = stmt.get()[0];
      if (typeof v === 'string' && v) out.push(v);
    }
    stmt.free();
    return out;
  } catch {
    return []; // table/column absent on this install's schema
  }
}

export function collectSamples(db: Database): string[] {
  const samples = [
    ...column(db, `SELECT encrypted_value FROM credentials WHERE encrypted_value != '' LIMIT ${PER_SOURCE}`),
    ...column(db, `SELECT literal_value_enc FROM workflow_steps WHERE literal_value_enc IS NOT NULL LIMIT ${PER_SOURCE}`),
    ...column(db, `SELECT recorded_value_enc FROM workflow_fields WHERE recorded_value_enc IS NOT NULL LIMIT ${PER_SOURCE}`),
  ];
  for (const envJson of column(db, `SELECT env_vars FROM custom_mcp_servers LIMIT ${PER_SOURCE}`)) {
    try {
      for (const v of Object.values(JSON.parse(envJson) as Record<string, unknown>)) {
        if (typeof v === 'string' && v) samples.push(v);
      }
    } catch { /* malformed row */ }
  }
  return samples;
}

export function probe(samples: string[], candidates: string[]): boolean[] {
  return candidates.map((key) => samples.length > 0 && samples.every((c) => decryptWithSecret(c, key) !== ''));
}

async function main(): Promise<void> {
  const raw = process.env.NODEBRAIN_VAULT_PROBE_KEYS;
  delete process.env.NODEBRAIN_VAULT_PROBE_KEYS;
  const candidates = JSON.parse(raw ?? '[]') as string[];

  const dbPath = path.join(process.env.NODEBRAIN_DATA_DIR ?? path.join(process.cwd(), 'data'), 'nodebrain.db');
  let samples: string[] = [];
  if (fs.existsSync(dbPath)) {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));
    samples = collectSamples(db);
    db.close();
  }
  process.stdout.write(JSON.stringify({ samples: samples.length, works: probe(samples, candidates) }) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`probeVaultKeys failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
