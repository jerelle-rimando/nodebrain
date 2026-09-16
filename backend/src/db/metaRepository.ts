import { dbRun, dbGet } from './database';

// Generic key/value store for small persisted flags (e.g. telemetry one-shot
// gates) that need to survive restarts but don't warrant a dedicated table.
export function getFlag(key: string): string | undefined {
  const row = dbGet<{ value: string }>('SELECT value FROM kv_store WHERE key = ?', [key]);
  return row?.value;
}

export function setFlag(key: string, value: string): void {
  dbRun(
    'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    [key, value],
  );
}
