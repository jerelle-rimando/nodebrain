// Runs the real compiled probe (backend/dist) as a child process against a
// fixture database, the way Electron main does. Needs `npm run build --prefix
// backend` first (test:electron does it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(__dirname, '../../..');
const PROBE = path.join(ROOT, 'backend/dist/backend/src/vault/probeVaultKeys.js');
const backendRequire = createRequire(path.join(ROOT, 'backend/package.json'));
const CryptoJS = backendRequire('crypto-js');
const initSqlJs = backendRequire('sql.js');

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

function enc(plain: string, secret: string): string {
  return CryptoJS.AES.encrypt(plain, CryptoJS.SHA256(secret).toString()).toString();
}

let tmp: string;

before(() => {
  assert.ok(fs.existsSync(PROBE), `${PROBE} missing — run npm run build --prefix backend`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-probe-'));
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeDb(dir: string, secret: string | null): Promise<void> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE credentials (id TEXT, encrypted_value TEXT)');
  db.run('CREATE TABLE workflow_fields (id TEXT, recorded_value_enc TEXT)');
  db.run('CREATE TABLE custom_mcp_servers (id TEXT, env_vars TEXT)');
  if (secret) {
    db.run('INSERT INTO credentials VALUES (?, ?)', ['1', enc('sk-live-123', secret)]);
    db.run('INSERT INTO credentials VALUES (?, ?)', ['2', enc('x', secret)]);
    db.run('INSERT INTO workflow_fields VALUES (?, ?)', ['3', enc('hunter2', secret)]);
    db.run('INSERT INTO custom_mcp_servers VALUES (?, ?)', ['4', JSON.stringify({ TOKEN: enc('tok', secret) })]);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'nodebrain.db'), Buffer.from(db.export()));
  db.close();
}

function runProbe(dataDir: string, candidates: string[]) {
  const before = fs.existsSync(path.join(dataDir, 'nodebrain.db')) ? fs.readFileSync(path.join(dataDir, 'nodebrain.db')) : null;
  const r = spawnSync(process.execPath, [PROBE], {
    cwd: path.join(ROOT, 'backend'),
    env: { ...process.env, NODEBRAIN_DATA_DIR: dataDir, NODEBRAIN_VAULT_PROBE_KEYS: JSON.stringify(candidates) },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  if (before) assert.ok(before.equals(fs.readFileSync(path.join(dataDir, 'nodebrain.db'))), 'probe modified the database');
  return JSON.parse(r.stdout.trim()) as { samples: number; works: boolean[] };
}

test('probe: only the key the data was encrypted with works', async () => {
  const dir = path.join(tmp, 'a');
  await makeDb(dir, A);
  assert.deepEqual(runProbe(dir, [A, B]), { samples: 4, works: [true, false] });
  assert.deepEqual(runProbe(dir, [B, A]), { samples: 4, works: [false, true] });
});

test('probe: no encrypted values reports zero samples', async () => {
  const dir = path.join(tmp, 'empty');
  await makeDb(dir, null);
  assert.deepEqual(runProbe(dir, [A, B]), { samples: 0, works: [false, false] });
});

test('probe: no database file reports zero samples', () => {
  const dir = path.join(tmp, 'none');
  fs.mkdirSync(dir, { recursive: true });
  assert.deepEqual(runProbe(dir, [A]), { samples: 0, works: [false] });
});
