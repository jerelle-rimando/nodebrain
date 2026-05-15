import { app, BrowserWindow, ipcMain, Tray, Menu, dialog, nativeImage, MessageBoxReturnValue } from 'electron';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn, ChildProcess } from 'child_process';
import Store from 'electron-store';
import * as http from 'http';
import * as fs from 'fs';
import { autoUpdater } from 'electron-updater';

interface StoreSchema {
  setupComplete: boolean;
  vaultSecret: string;
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

// ── Serve static frontend ─────────────────────────────────────────────────────
function serveStaticFrontend(): Promise<void> {
  return new Promise((resolve) => {
    if (isDev) { resolve(); return; }

    const frontendPath = path.join(process.resourcesPath, 'frontend/dist');
    log(`Serving frontend from: ${frontendPath}`);
    log(`Frontend dist exists: ${fs.existsSync(frontendPath)}`);

    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api')) {
        const proxyReq = http.request(
          {
            hostname: '127.0.0.1',
            port: BACKEND_PORT,
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
      
      // Reject path traversal attempts, null bytes, absolute paths
      if (decodedUrl.includes('..') || decodedUrl.includes('\0') || path.isAbsolute(decodedUrl)) {
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
        if (err) { res.writeHead(404); res.end('Not found'); return; }
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
      await waitForBackend(30000);
      log(`Loading frontend at http://localhost:${ACTIVE_FRONTEND_PORT}`);
      await mainWindow.loadURL(`http://localhost:${ACTIVE_FRONTEND_PORT}`);
      log('Frontend loaded');
    } catch (err) {
      log(`Backend wait failed: ${err}`);
      // Show error page
      await mainWindow.loadURL(`data:text/html,<body style="background:#0a0a0f;color:#e2e8f0;font-family:sans-serif;padding:40px"><h2>NodeBrain failed to start</h2><p>Check the log at AppData/Roaming/NodeBrain/nodebrain-log.txt</p></body>`);
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
    { label: 'Quit', click: () => { backendProcess?.kill(); app.exit(0); } },
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

  ipcMain.handle('set-vault-secret', (_event: Electron.IpcMainInvokeEvent, secret: string) => {
    store.set('vaultSecret', secret);
  });

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

  ipcMain.handle('load-main-app', async () => {
    log('load-main-app called');
    try {
      await waitForBackend(30000);
      log(`Loading main app at http://localhost:${ACTIVE_FRONTEND_PORT}`);
      await mainWindow?.loadURL(`http://localhost:${ACTIVE_FRONTEND_PORT}`);
      log('Main app loaded');
    } catch (err) {
      log(`load-main-app failed: ${err}`);
    }
  });
}

ipcMain.handle('open-external', (_event, url: string) => {
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
});

app.on('activate', () => {
  mainWindow?.show();
});