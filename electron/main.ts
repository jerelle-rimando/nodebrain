import { app, BrowserWindow, ipcMain, Tray, Menu, dialog, nativeImage, MessageBoxReturnValue } from 'electron';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import Store from 'electron-store';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';
import extractZip from 'extract-zip';

interface StoreSchema {
  setupComplete: boolean;
  vaultSecret: string;
  onboardingComplete: boolean;
  backendUrl?: string;
}

const store = new Store<StoreSchema>({ name: 'nodebrain-store' });

// ── Single instance lock ──────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// ── Logging (must be after app is referenced but path is safe here) ───────────
let logPath: string;
function log(msg: string): void {
  if (!logPath) {
    logPath = path.join(app.getPath('userData'), 'nodebrain-log.txt');
  }
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(logPath, line); } catch { /* ignore */ }
  console.log(msg);
}

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let backendProcess: ChildProcess | null = null;
let isQuitting = false;
let suppressAutoRestart = false;

const BACKEND_PORT = 3001;
const FRONTEND_PORT = 5173;
const isDev = process.env.NODE_ENV === 'development';
let ACTIVE_FRONTEND_PORT = FRONTEND_PORT;

// ── Local AI engine (Ollama) ──────────────────────────────────────────────────
// Pinned deliberately — same reasoning as the MCP server version pinning in
// backend/src/mcp/toolRegistry.ts: an unpinned URL/version could silently start
// serving a different (potentially malicious) binary on a future release.
// This is a CPU-only repack of Ollama hosted on NodeBrain's own GitHub releases —
// NOT the ~1.46 GB upstream asset, which bundles CUDA/ROCm libraries we don't need.
// To upgrade: manually verify the new release, then update version/url/sha256/sizeBytes together.
const OLLAMA_ENGINE = {
  version: 'v0.33.2',
  url: 'https://github.com/jerelle-rimando/nodebrain/releases/download/ollama-engine-v0.33.2/ollama-windows-amd64-cpu-v0.33.2.zip',
  sha256: '00B12FBA422084996920C5DBF7A85B57520428573950DFBF259BBB8DD8A924F4',
  sizeBytes: 27199488, // ~26 MB
};
const LOCAL_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const OLLAMA_PORT = 11434;

let ollamaProcess: ChildProcess | null = null;
let ollamaSpawnedByUs = false;

// Multi-GB engine + model data does not belong in userData (Roaming) — that's
// what dev-uninstall.ps1 wipes, and it's meant for small config, not this.
function getNodeBrainLocalDir(): string {
  return path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'NodeBrain');
}
function getEngineDir(): string {
  return path.join(getNodeBrainLocalDir(), 'engine');
}
function getModelsDir(): string {
  return path.join(getNodeBrainLocalDir(), 'models');
}

// ── Vault secret ──────────────────────────────────────────────────────────────
async function getOrCreateVaultSecret(): Promise<string> {
  const SERVICE = 'NodeBrain';
  const ACCOUNT = 'vault-secret';

  let keytarLib: any = null;
  try {
    const keytar = await import('keytar');
    keytarLib = ('default' in keytar) ? (keytar as any).default : keytar;
  } catch { /* keytar unavailable */ }

  let keytarSecret: string | null = null;
  if (keytarLib) {
    try { keytarSecret = await keytarLib.getPassword(SERVICE, ACCOUNT) as string | null; } catch { /* ignore */ }
  }

  let storeSecret: string | undefined;
  try { storeSecret = store.get('vaultSecret') as string | undefined; } catch { /* ignore */ }

  if (keytarSecret) {
    // keytar is authoritative; keep store in sync
    try { store.set('vaultSecret', keytarSecret); } catch { /* ignore */ }
    return keytarSecret;
  }

  if (storeSecret) {
    // store has it; backfill keytar
    if (keytarLib) {
      try { await keytarLib.setPassword(SERVICE, ACCOUNT, storeSecret); } catch { /* ignore */ }
    }
    return storeSecret;
  }

  // Neither has a secret — generate and persist to both
  const secret = crypto.randomBytes(32).toString('hex');
  if (keytarLib) {
    try { await keytarLib.setPassword(SERVICE, ACCOUNT, secret); } catch { /* ignore */ }
  }
  try { store.set('vaultSecret', secret); } catch { /* ignore */ }
  return secret;
}

// ── Start backend ─────────────────────────────────────────────────────────────
async function startBackend(): Promise<void> {
  const vaultSecret = await getOrCreateVaultSecret();

  const backendEntry = isDev
    ? path.join(__dirname, '../backend/src/index.ts')
    : path.join(process.resourcesPath, 'backend/dist/backend/src/index.js');

  const command = isDev
    ? (process.platform === 'win32' ? 'npx.cmd' : 'npx')
    : process.execPath;
  const args = isDev ? ['tsx', backendEntry] : [backendEntry];

  const cwd = isDev
    ? path.join(__dirname, '../backend')
    : path.join(process.resourcesPath, 'backend');

  log(`Backend command: ${command}`);
  log(`Backend entry: ${backendEntry}`);
  log(`Backend entry exists: ${fs.existsSync(backendEntry)}`);
  log(`Backend cwd: ${cwd}`);
  log(`process.execPath: ${process.execPath}`);

  backendProcess = spawn(command, args, {
    env: {
      ...process.env,
      VAULT_SECRET: vaultSecret,
      PORT: String(BACKEND_PORT),
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RUN: 'true',
      ...(!isDev && { NODEBRAIN_DATA_DIR: path.join(app.getPath('userData'), 'data') }),
    },
    shell: false,
    cwd,
  });

  backendProcess.stdout?.on('data', (data: Buffer) => log(`[Backend] ${data.toString().trim()}`));
  backendProcess.stderr?.on('data', (data: Buffer) => log(`[Backend Error] ${data.toString().trim()}`));
  backendProcess.on('exit', (code: number | null) => {
    log(`[Backend] exited with code ${code}`);
    if (code !== 0 && !isQuitting && !suppressAutoRestart) {
      log('[Backend] crashed, restarting in 3s...');
      setTimeout(() => startBackend().catch(err => log(`[Backend] restart failed: ${err}`)), 3000);
    }
  });
}

// ── Wait for backend to be ready ──────────────────────────────────────────────
function waitForBackend(timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let attempts = 0;
    function check() {
      attempts++;
      if (attempts % 10 === 0) {
        log(`Still waiting for backend... attempt ${attempts}`);
      }
      http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
        if (res.statusCode === 200) {
          log(`Backend ready after ${attempts} attempts`);
          resolve();
        } else {
          retry();
        }
      }).on('error', () => {
        retry();
      });
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Backend did not start after ${attempts} attempts in ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 500);
    }
    check();
  });
}

// ── Local AI setup: download / verify / unpack / run / pull ──────────────────
function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function downloadWithProgress(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number, bytesPerSec: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (currentUrl: string, redirectsLeft: number) => {
      const req = https.get(currentUrl, (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('The download link redirected too many times.'));
            return;
          }
          attempt(res.headers.location, redirectsLeft - 1);
          return;
        }

        if (status !== 200) {
          res.resume();
          reject(new Error(`The download server responded with an error (status ${status}).`));
          return;
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let windowStart = Date.now();
        let windowStartBytes = 0;
        const file = fs.createWriteStream(destPath);

        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          const elapsed = Date.now() - windowStart;
          if (elapsed >= 250) {
            onProgress(received, total, ((received - windowStartBytes) / elapsed) * 1000);
            windowStart = Date.now();
            windowStartBytes = received;
          }
        });
        res.on('error', (err) => {
          file.close();
          fs.unlink(destPath, () => { /* ignore */ });
          reject(err);
        });

        res.pipe(file);
        file.on('finish', () => {
          onProgress(received, total || received, 0);
          file.close(() => resolve());
        });
        file.on('error', (err) => {
          fs.unlink(destPath, () => { /* ignore */ });
          reject(err);
        });
      });
      req.on('error', () => {
        reject(new Error("Couldn't connect to download the engine. Check your internet connection and try again."));
      });
    };
    attempt(url, 5);
  });
}

// Recursively looks for ollama.exe under the unpacked engine directory — the
// zip's internal layout isn't guaranteed, so we don't hardcode a subpath.
function findEnginePath(engineDir: string): string | null {
  if (!fs.existsSync(engineDir)) return null;
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
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === 'ollama.exe') {
        return full;
      }
    }
  }
  return null;
}

function httpGetText(url: string, timeoutMs = 3000): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function isOllamaRunning(): Promise<boolean> {
  const res = await httpGetText(`http://127.0.0.1:${OLLAMA_PORT}/api/version`, 1500);
  return !!res && res.status === 200;
}

function waitForOllamaReady(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      http.get(`http://localhost:${OLLAMA_PORT}/`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (body.includes('Ollama is running')) resolve();
          else retry();
        });
      }).on('error', retry);
    }
    function retry() {
      if (Date.now() - start > timeoutMs) {
        reject(new Error('The local AI engine did not start in time. Please try again.'));
        return;
      }
      setTimeout(check, 500);
    }
    check();
  });
}

async function ensureEngineRunning(enginePath: string, modelsDir: string): Promise<void> {
  if (await isOllamaRunning()) {
    log('Local AI engine already running on 11434 — reusing it instead of spawning a second copy.');
    return;
  }
  log(`Starting local AI engine: ${enginePath}`);
  ollamaProcess = spawn(enginePath, ['serve'], {
    windowsHide: true,
    shell: false,
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${OLLAMA_PORT}`, OLLAMA_MODELS: modelsDir },
  });
  ollamaSpawnedByUs = true;
  ollamaProcess.stdout?.on('data', (data: Buffer) => log(`[Ollama] ${data.toString().trim()}`));
  ollamaProcess.stderr?.on('data', (data: Buffer) => log(`[Ollama Error] ${data.toString().trim()}`));
  ollamaProcess.on('exit', (code: number | null) => {
    log(`[Ollama] exited with code ${code}`);
    ollamaProcess = null;
  });
  await waitForOllamaReady(30000);
}

// Streams POST /api/pull's newline-delimited JSON progress. Layer `completed`
// may be absent early (treated as 0); aggregate across all layers seen so far
// since Ollama pulls model layers one at a time within a single stream.
function pullModel(onProgress: (received: number, total: number, bytesPerSec: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve();
    };

    const body = JSON.stringify({ model: LOCAL_MODEL, stream: true });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: OLLAMA_PORT,
        path: '/api/pull',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let buffer = '';
        const layerTotals = new Map<string, number>();
        const layerCompleted = new Map<string, number>();
        let windowStart = Date.now();
        let windowStartBytes = 0;

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;

            let obj: { status?: string; digest?: string; total?: number; completed?: number; error?: string };
            try {
              obj = JSON.parse(line);
            } catch {
              continue;
            }

            if (obj.error) {
              finish(new Error(obj.error));
              return;
            }

            if (obj.digest) {
              if (typeof obj.total === 'number') layerTotals.set(obj.digest, obj.total);
              layerCompleted.set(obj.digest, obj.completed || 0);
            }

            const totalSum = Array.from(layerTotals.values()).reduce((a, b) => a + b, 0);
            const completedSum = Array.from(layerCompleted.values()).reduce((a, b) => a + b, 0);
            const elapsed = Date.now() - windowStart;
            if (elapsed >= 250) {
              onProgress(completedSum, totalSum, ((completedSum - windowStartBytes) / elapsed) * 1000);
              windowStart = Date.now();
              windowStartBytes = completedSum;
            }

            if (obj.status === 'success') {
              onProgress(totalSum || completedSum, totalSum || completedSum, 0);
              finish();
              return;
            }
          }
        });
        res.on('end', () => finish());
        res.on('error', (err) => finish(err));
      },
    );
    req.on('error', () => finish(new Error("Couldn't reach the local AI engine to download the model.")));
    req.write(body);
    req.end();
  });
}

// ── Serve static frontend ─────────────────────────────────────────────────────
function serveStaticFrontend(): Promise<void> {
  return new Promise((resolve) => {
    if (isDev) { resolve(); return; }

    const frontendPath = path.join(process.resourcesPath, 'frontend/dist');
    log(`Serving frontend from: ${frontendPath}`);
    log(`Frontend dist exists: ${fs.existsSync(frontendPath)}`);

    const rawBackendUrl = (store.get('backendUrl') as string | undefined) || 'http://localhost:3001';
    let backendHost: string;
    let backendProxyPort: number;
    try {
      const parsed = new URL(rawBackendUrl);
      backendHost = parsed.hostname || '127.0.0.1';
      backendProxyPort = parseInt(parsed.port, 10) || BACKEND_PORT;
    } catch {
      backendHost = '127.0.0.1';
      backendProxyPort = BACKEND_PORT;
    }
    log(`Proxy target: ${backendHost}:${backendProxyPort}`);

    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api')) {
        const proxyReq = http.request(
          {
            hostname: backendHost,
            port: backendProxyPort,
            path: req.url,
            method: req.method,
            headers: req.headers,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            res.flushHeaders();
            proxyRes.pipe(res);
          },
        );
        proxyReq.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'backend not ready' }));
          }
        });
        req.pipe(proxyReq);
        return;
      }

      const rawUrl = req.url === '/' ? '/index.html' : (req.url ?? '/index.html');
      const decodedUrl = decodeURIComponent(rawUrl.split('?')[0].split('#')[0]);
      
      let filePath: string;
      
      // Reject path traversal attempts and null bytes
      if (decodedUrl.includes('..') || decodedUrl.includes('\0')) {
        filePath = path.join(frontendPath, 'index.html');
      } else {
        const resolvedFrontend = path.resolve(frontendPath);
        const candidate = path.resolve(resolvedFrontend, '.' + decodedUrl);
        
        // Strict containment check
        if (candidate === resolvedFrontend || candidate.startsWith(resolvedFrontend + path.sep)) {
          filePath = candidate;
        } else {
          filePath = path.join(frontendPath, 'index.html');
        }
      }
      
      if (!fs.existsSync(filePath)) {
        const requestedExt = path.extname(decodedUrl);
        if (requestedExt) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        filePath = path.join(frontendPath, 'index.html');
      }
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.wasm': 'application/wasm',
      };
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
      });
    });

    let port = FRONTEND_PORT;

    function tryListen() {
      server.removeAllListeners('error');
      server.listen(port, '127.0.0.1', () => {
        ACTIVE_FRONTEND_PORT = port;
        log(`Frontend server running at http://localhost:${ACTIVE_FRONTEND_PORT}`);
        resolve();
      });
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log(`Port ${port} in use, trying ${port + 1}`);
          port += 1;
          tryListen();
        } else {
          log(`Frontend server error: ${err.message}`);
          resolve();
        }
      });
    }

    tryListen();
  });
}

// ── Auto updater ──────────────────────────────────────────────────────────────
function setupAutoUpdater(): void {
  if (isDev) return;
  // Only check for updates if current version has a published release with latest.yml
try {
  autoUpdater.checkForUpdatesAndNotify().catch(err => {
    log(`Auto-update check skipped: ${err.message?.split('\n')[0]}`);
  });
} catch (err) {
  log(`Auto-updater init failed: ${err}`);
}
  autoUpdater.on('update-available', () => {
    log('Update available — downloading...');
  });
  autoUpdater.on('update-downloaded', () => {
    log('Update downloaded');
    dialog.showMessageBox({
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of NodeBrain has been downloaded. Restart to apply the update.',
      buttons: ['Restart Now', 'Later'],
    }).then((result: MessageBoxReturnValue) => {
      if (result.response === 0) autoUpdater.quitAndInstall();
    });
  });
}

// ── Create window ─────────────────────────────────────────────────────────────
async function createWindow(): Promise<void> {
  log('createWindow called');

  const iconPath = isDev
    ? path.join(__dirname, '../electron/assets/icon.ico')
    : path.join(process.resourcesPath, 'electron/assets/icon.ico');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: iconPath,
    title: 'NodeBrain',
    backgroundColor: '#0a0a0f',
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  log('BrowserWindow created');

  const isFirstRun = !store.get('setupComplete');
  log(`isFirstRun: ${isFirstRun}`);

  if (isFirstRun) {
    const wizardPath = isDev
      ? path.join(__dirname, '../electron/wizard/index.html')
      : path.join(process.resourcesPath, 'electron/wizard/index.html');
    log(`Loading wizard from: ${wizardPath}`);
    log(`Wizard exists: ${fs.existsSync(wizardPath)}`);
    await mainWindow.loadFile(wizardPath);
    log('Wizard loaded');
  } else {
    log('Waiting for backend...');
    try {
      await waitForBackend(120000);
      log(`Loading frontend at http://localhost:${ACTIVE_FRONTEND_PORT}`);
      await mainWindow.loadURL(`http://localhost:${ACTIVE_FRONTEND_PORT}`);
      log('Frontend loaded');
    } catch (err) {
      log(`Backend wait failed: ${err}`);
      // Backend is still coming up — show a waiting page and recover automatically once it's ready
      await mainWindow.loadURL(
        `data:text/html,<body style="background:#0a0a0f;color:#e2e8f0;font-family:sans-serif;padding:40px">` +
        `<h2>NodeBrain is still starting…</h2>` +
        `<p>The backend is taking longer than usual. The app will load automatically once it's ready.</p>` +
        `<p style="color:#94a3b8;font-size:0.875rem">If this persists, check the log at AppData/Roaming/NodeBrain/nodebrain-log.txt</p></body>`
      );
      log('Backend wait timed out — starting recovery poller');
      const recoveryInterval = setInterval(() => {
        http.get(`http://localhost:${BACKEND_PORT}/api/health`, (res) => {
          if (res.statusCode === 200) {
            clearInterval(recoveryInterval);
            log('Backend became ready after wait timeout — loading app');
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.loadURL(`http://localhost:${ACTIVE_FRONTEND_PORT}`)
                .catch(e => log(`Recovery loadURL failed: ${e}`));
            }
          }
        }).on('error', () => { /* backend not yet ready */ });
      }, 2000);
    }
  }

  mainWindow.once('ready-to-show', () => {
    log('ready-to-show fired');
    mainWindow?.show();
  });

  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      log('Force showing window after timeout');
      mainWindow.show();
    }
  }, 4000);

  mainWindow.on('close', (e: Electron.Event) => {
    e.preventDefault();
    mainWindow?.hide();
  });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray(): void {
  const trayIconPath = isDev
    ? path.join(__dirname, '../electron/assets/tray-icon.png')
    : path.join(process.resourcesPath, 'electron/assets/tray-icon.png');

  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open NodeBrain', click: () => { mainWindow?.show(); } },
    {
      label: 'Restart Backend',
      click: () => {
        suppressAutoRestart = true;
        backendProcess?.kill();
        setTimeout(() => {
          startBackend().catch(console.error).finally(() => { suppressAutoRestart = false; });
        }, 500);
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => { backendProcess?.kill(); if (ollamaSpawnedByUs) ollamaProcess?.kill(); app.exit(0); } },
  ]);

  tray.setToolTip('NodeBrain');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow?.show(); });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
function registerIpcHandlers(): void {
  ipcMain.handle('is-first-run', () => !store.get('setupComplete'));

  ipcMain.handle('complete-setup', () => {
    store.set('setupComplete', true);
    log('Setup marked complete');
  });

  ipcMain.handle('get-vault-secret', () => getOrCreateVaultSecret());

  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select folder for filesystem access',
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('test-api-key', async (_event: Electron.IpcMainInvokeEvent, provider: string, key: string) => {
    const baseURLs: Record<string, string> = {
      openai: 'https://api.openai.com/v1/models',
      anthropic: 'https://api.anthropic.com/v1/models',
      groq: 'https://api.groq.com/openai/v1/models',
    };
    const url = baseURLs[provider];
    if (!url) return { success: true };
    try {
      const headers: Record<string, string> = provider === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { Authorization: `Bearer ${key}` };
      const res = await fetch(url, { headers });
      return { success: res.ok };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('save-credential', async (_event: Electron.IpcMainInvokeEvent, payload: unknown) => {
    try {
      await waitForBackend(30000);
    } catch {
      log('save-credential: backend did not become ready in time');
      return { success: false, error: "Couldn't reach NodeBrain's backend." };
    }

    try {
      const res = await fetch(`http://localhost:${BACKEND_PORT}/api/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        log(`save-credential: backend responded ${res.status}: ${text}`);
        return { success: false, error: `Backend responded with ${res.status}` };
      }
      log('save-credential: credential saved');
      return { success: true };
    } catch (err) {
      log(`save-credential: request failed: ${err}`);
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('reset-all-data', async () => {
    log('reset-all-data: starting');
    backendProcess?.kill();
    await new Promise(r => setTimeout(r, 500));

    const dataDir = path.join(app.getPath('userData'), 'data');
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (err) { log(`reset-all-data: rmSync failed: ${err}`); }

    try {
      const keytar = await import('keytar');
      const keytarLib = ('default' in keytar) ? (keytar as any).default : keytar;
      await keytarLib.deletePassword('NodeBrain', 'vault-secret');
    } catch { /* ignore */ }

    try { store.clear(); } catch { /* ignore */ }

    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('get-launch-on-startup', () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle('set-launch-on-startup', (_event: Electron.IpcMainInvokeEvent, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle('window-minimize', () => { mainWindow?.minimize(); });
  ipcMain.handle('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window-close', () => { mainWindow?.hide(); });

  ipcMain.handle('is_onboarding_complete', () => store.get('onboardingComplete') ?? false);

  ipcMain.handle('complete_onboarding', () => {
    store.set('onboardingComplete', true);
  });

  ipcMain.handle('get-backend-url', () => {
    return (store.get('backendUrl') as string | undefined) || 'http://localhost:3001';
  });

  ipcMain.handle('set-backend-url', (_event: Electron.IpcMainInvokeEvent, url: string) => {
    store.set('backendUrl', url || 'http://localhost:3001');
  });

  ipcMain.handle('start-local-setup', async (event: Electron.IpcMainInvokeEvent) => {
    const sender = event.sender;
    const emit = (fn: string, ...args: unknown[]) => {
      if (!sender.isDestroyed()) sender.send('local-setup-event', { fn, args });
    };

    const engineDir = getEngineDir();
    const modelsDir = getModelsDir();
    try {
      fs.mkdirSync(engineDir, { recursive: true });
      fs.mkdirSync(modelsDir, { recursive: true });
    } catch (err) {
      log(`start-local-setup: could not create data folders: ${err}`);
      emit('setSetupFailed', 'engine', "Couldn't create the folders needed for setup. Please try again.");
      return { success: false };
    }

    let enginePath = findEnginePath(engineDir);

    if (!enginePath) {
      const zipPath = path.join(app.getPath('temp'), `nodebrain-ollama-engine-${OLLAMA_ENGINE.version}.zip`);

      log(`start-local-setup: downloading engine from ${OLLAMA_ENGINE.url}`);
      try {
        await downloadWithProgress(OLLAMA_ENGINE.url, zipPath, (received, total, bytesPerSec) => {
          emit('setStepProgress', 'engine', received, total || OLLAMA_ENGINE.sizeBytes, bytesPerSec);
        });
      } catch (err) {
        log(`start-local-setup: engine download failed: ${err}`);
        emit('setSetupFailed', 'engine', "Couldn't download the engine. Check your internet connection and try again.");
        return { success: false };
      }

      let actualHash: string;
      try {
        actualHash = await sha256File(zipPath);
      } catch (err) {
        log(`start-local-setup: hashing the download failed: ${err}`);
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        emit('setSetupFailed', 'engine', "Couldn't verify the downloaded file. Please try again.");
        return { success: false };
      }

      // Case-insensitive on purpose: hex hashes are case-insensitive, and a
      // case mismatch must never cause a false rejection of a good download.
      if (actualHash.toLowerCase() !== OLLAMA_ENGINE.sha256.toLowerCase()) {
        log(`start-local-setup: SHA256 mismatch — expected ${OLLAMA_ENGINE.sha256}, got ${actualHash}`);
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        emit('setSetupFailed', 'engine', "The downloaded file didn't match what we expected, so it was deleted for safety. Please try again.");
        return { success: false };
      }

      log('start-local-setup: engine verified, unpacking...');
      try {
        await extractZip(zipPath, { dir: engineDir });
        fs.unlinkSync(zipPath);
      } catch (err) {
        log(`start-local-setup: unzip failed: ${err}`);
        emit('setSetupFailed', 'engine', "Couldn't unpack the engine. Please try again.");
        return { success: false };
      }

      enginePath = findEnginePath(engineDir);
      if (!enginePath) {
        log('start-local-setup: ollama.exe not found after unpacking');
        emit('setSetupFailed', 'engine', "The engine didn't unpack as expected. Please try again.");
        return { success: false };
      }
    } else {
      log(`start-local-setup: engine already present at ${enginePath}, skipping download`);
    }

    emit('setStepComplete', 'engine');

    try {
      await ensureEngineRunning(enginePath, modelsDir);
    } catch (err) {
      log(`start-local-setup: engine failed to start: ${err}`);
      emit('setSetupFailed', 'engine', 'The local AI engine failed to start. Please try again.');
      return { success: false };
    }

    log(`start-local-setup: pulling model ${LOCAL_MODEL}`);
    try {
      await pullModel((received, total, bytesPerSec) => {
        emit('setStepProgress', 'model', received, total, bytesPerSec);
      });
    } catch (err) {
      log(`start-local-setup: model pull failed: ${err}`);
      emit('setSetupFailed', 'model', "Couldn't download the AI model. Check your internet connection and try again.");
      return { success: false };
    }

    emit('setStepComplete', 'model');
    emit('setSetupComplete');
    return { success: true };
  });

  ipcMain.handle('check-existing-ollama', async () => {
    const version = await httpGetText(`http://127.0.0.1:${OLLAMA_PORT}/api/version`, 1500);
    if (!version || version.status !== 200) {
      return { running: false, hasModel: false };
    }
    const tags = await httpGetText(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, 1500);
    let hasModel = false;
    if (tags && tags.status === 200) {
      try {
        const parsed = JSON.parse(tags.body);
        hasModel = Array.isArray(parsed.models) && parsed.models.length > 0;
      } catch { /* ignore */ }
    }
    return { running: true, hasModel };
  });

  ipcMain.handle('load-main-app', async () => {
    log('load-main-app called');
    try {
      await waitForBackend(120000);
      log(`Loading main app at http://localhost:${ACTIVE_FRONTEND_PORT}`);
      await mainWindow?.loadURL(`http://localhost:${ACTIVE_FRONTEND_PORT}`);
      log('Main app loaded');
    } catch (err) {
      log(`load-main-app failed: ${err}`);
    }
  });
}

ipcMain.handle('open-external', (_event, url: string) => {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    log(`open-external rejected (malformed URL): ${url}`);
    return;
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    log(`open-external rejected (disallowed scheme "${protocol}"): ${url}`);
    return;
  }
  const { shell } = require('electron');
  shell.openExternal(url);
});

// ── Second instance handler ───────────────────────────────────────────────────
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  log('App ready');
  registerIpcHandlers();
  log('IPC handlers registered');
  await serveStaticFrontend();
  log('Frontend server ready');
  await startBackend();
  log('Backend started');
  createTray();
  log('Tray created');
  Menu.setApplicationMenu(null);
  await createWindow();
  log('Window created');
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  // Stay in tray
});

app.on('before-quit', () => {
  isQuitting = true;
  backendProcess?.kill();
  if (ollamaSpawnedByUs) ollamaProcess?.kill();
});

app.on('activate', () => {
  mainWindow?.show();
});