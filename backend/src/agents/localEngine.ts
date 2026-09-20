import fs from 'fs';
import http from 'http';
import path from 'path';

// Mirrors electron/main.ts (LOCAL_MODEL, OLLAMA_PORT, getNodeBrainLocalDir).
// The backend is a separate process and can't import from electron, so the
// on-disk layout is re-derived here: engine + models live under
// %LOCALAPPDATA%\NodeBrain, never userData.
export const LOCAL_PROVIDER = 'ollama';
export const LOCAL_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const OLLAMA_PORT = 11434;

export interface LocalEngineStatus {
  /** Engine installed AND the local model present — safe to default to. */
  available: boolean;
  engineInstalled: boolean;
  modelPresent: boolean;
  provider: typeof LOCAL_PROVIDER;
  model: string;
}

function getLocalDir(): string | null {
  const base = process.env.LOCALAPPDATA;
  return base ? path.join(base, 'NodeBrain') : null;
}

// The zip's internal layout isn't guaranteed, so search for ollama.exe rather
// than hardcoding a subpath (same approach as findEnginePath in electron/main.ts).
function engineInstalled(engineDir: string): boolean {
  if (!fs.existsSync(engineDir)) return false;
  const stack: string[] = [engineDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.toLowerCase() === 'ollama.exe') return true;
    }
  }
  return false;
}

// Checked on disk first so the answer doesn't depend on the engine having
// finished starting (it's spawned, un-awaited, at app launch). Ollama stores
// a model as manifests/registry.ollama.ai/library/<name>/<tag>.
function modelManifestOnDisk(modelsDir: string): boolean {
  const [name, tag] = LOCAL_MODEL.split(':');
  return fs.existsSync(path.join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag));
}

// Fallback for a reused (already-running) Ollama whose model store isn't ours.
function modelListedByRunningEngine(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { models?: { name?: string }[] };
          resolve(Array.isArray(parsed.models) && parsed.models.some((m) => m.name === LOCAL_MODEL));
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function probe(): Promise<LocalEngineStatus> {
  const localDir = getLocalDir();
  const installed = localDir ? engineInstalled(path.join(localDir, 'engine')) : false;
  let present = false;
  if (installed && localDir) {
    present = modelManifestOnDisk(path.join(localDir, 'models')) || (await modelListedByRunningEngine());
  }
  return {
    available: installed && present,
    engineInstalled: installed,
    modelPresent: present,
    provider: LOCAL_PROVIDER,
    model: LOCAL_MODEL,
  };
}

// Consulted on hot paths (every chat message), so the probe is cached briefly.
// Short enough that finishing onboarding is picked up almost immediately.
const CACHE_TTL_MS = 10_000;
let cached: { at: number; result: Promise<LocalEngineStatus> } | null = null;

export function getLocalEngineStatus(): Promise<LocalEngineStatus> {
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_TTL_MS) {
    cached = { at: now, result: probe() };
  }
  return cached.result;
}
