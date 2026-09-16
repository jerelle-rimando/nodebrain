import 'dotenv/config';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { initDb } from './db/database';
import { reconcileOrphanedTasks } from './db/taskRepository';
import { reconcileOrphanedAgents } from './db/agentRepository';
import { startScheduler } from './scheduler/scheduler';
import { initRag } from './rag/ragEngine';
import { initializeToolRegistry } from './mcp/toolRegistry';
import { disconnectAll } from './mcp/mcpClient';
import { initVaultKey } from './vault/credentialVault';
import agentRouter from './routes/agents';
import { taskRouter, logsRouter } from './routes/tasks';
import credentialRouter from './routes/credentials';
import chatRouter from './routes/chat';
import eventsRouter from './routes/events';
import integrationsRouter from './routes/integrations';
import { parseNaturalSchedule } from './utils/parseSchedule';
import { AVAILABLE_MODELS } from './agents/agentEngine';
import mcpServersRouter from './routes/mcpServers';
import agentConnectionsRouter from './routes/agentConnections';
import analyticsRouter from './routes/analytics';
import telemetryRouter from './routes/telemetry';
import { registerTelemetrySubscribers } from './telemetry/subscribers';
import { emitUsageSnapshot } from './telemetry/usageSnapshot';

// Windows: the MCP SDK only sets windowsHide when it detects Electron
// (via 'type' in process). This backend runs as a standalone Node process,
// so that check fails and a cmd.exe window flashes on every MCP server spawn.
// Mimicking Electron's process.type here flips windowsHide on. Verified
// side-effect-free in this process (no live consumer reads process.type
// except the `debug` package, which checks === 'renderer').
if (process.platform === 'win32') {
  (process as any).type = 'browser';
}

// ── Fatal error capture (backend process) ───────────────────────────────────
// The Electron main process already captures our stderr line-by-line into
// nodebrain-log.txt, but process.exit() can truncate a final async console
// write, so the reason gets lost. fs.writeSync(2, …) is synchronous — the
// parent always receives the detail before the pipe closes. Local logging
// only; nothing here is transmitted.
function writeFatalToStderr(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    fs.writeSync(2, `[Backend Fatal] ${context}: ${detail}\n`);
  } catch {
    console.error(`[Backend Fatal] ${context}:`, err); // last resort (async)
  }
}

process.on('uncaughtException', (err) => {
  writeFatalToStderr('uncaughtException', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Log but keep serving — a stray rejection shouldn't kill the backend and
  // trigger a user-visible restart. Change to process.exit(1) to make it fatal.
  writeFatalToStderr('unhandledRejection', reason);
});

const PORT = Number(process.env.PORT) || 3001;
const BIND_HOST = process.env.NODEBRAIN_BIND_HOST ?? '127.0.0.1';
const app = express();

app.use(cors({
  origin(origin, callback) {
    if (!origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'));
    }
  },
  credentials: true,
}));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.get('/api/models', (_req, res) => {
  res.json({ success: true, data: AVAILABLE_MODELS });
});

app.get('/api/schedule/parse', (req, res) => {
  const { input } = req.query as { input?: string };
  if (!input) return res.status(400).json({ success: false, error: 'input required' });
  const result = parseNaturalSchedule(input);
  res.json({ success: true, data: result });
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

app.use('/api/agents', agentRouter);
app.use('/api/tasks', taskRouter);
app.use('/api/logs', logsRouter);
app.use('/api/credentials', credentialRouter);
app.use('/api/chat', chatRouter);
app.use('/api/events', eventsRouter);
app.use('/api/integrations', limiter, integrationsRouter);
app.use('/api/mcp-servers', mcpServersRouter);
app.use('/api/agent-connections', agentConnectionsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/telemetry', telemetryRouter);

async function main() {
  try {
    if (!process.env.VAULT_SECRET) {
      const secret = crypto.randomBytes(32).toString('hex');
      process.env.VAULT_SECRET = secret;

      const envPath = path.resolve(process.cwd(), '.env');
      let envContents = '';
      try {
        envContents = fs.readFileSync(envPath, 'utf8');
      } catch {
        // .env doesn't exist yet — appendFileSync will create it
      }

      if (/^VAULT_SECRET=/m.test(envContents)) {
        // Line exists but dotenv didn't populate it (blank or invalid value)
        console.warn(
          '⚠️ VAULT_SECRET is defined in .env but was not loaded — check for a blank or invalid value. ' +
          'Credentials encrypted in this session will not survive a restart until it is fixed.'
        );
      } else {
        const line = envContents.length > 0 ? `\nVAULT_SECRET=${secret}\n` : `VAULT_SECRET=${secret}\n`;
        fs.appendFileSync(envPath, line, 'utf8');
        console.log(`✅ VAULT_SECRET generated and written to ${envPath}`);
      }
    }

    // Cache the raw vault secret and remove it from process.env here — before initDb(),
    // startScheduler(), or initializeToolRegistry() runs. This is the proven-safe point:
    // VAULT_SECRET is guaranteed present (generated above if missing), nothing has been
    // spawned yet, and no MCP server can inherit it from the environment after this line.
    // NODEBRAIN_DATA_DIR is deleted for the same reason; database.ts and ragEngine.ts
    // already captured it into module-level constants at import time.
    initVaultKey();
    delete process.env.NODEBRAIN_DATA_DIR;

    // /api/health has no DB/scheduler/vault dependency beyond what's already
    // done above, so open the port here — before await initDb() — instead of
    // after. Electron's readiness poll can then succeed as soon as the process
    // is alive, without waiting on DB init. Nothing else can reach the server
    // before that poll succeeds (the frontend isn't loaded until it does), so
    // no other route is exposed to a pre-initDb() request in practice.
    app.listen(PORT, BIND_HOST, () => {
      console.log(`\n🧠 NodeBrain backend running at http://${BIND_HOST}:${PORT}`);
      console.log(`📡 SSE events at http://localhost:${PORT}/api/events`);
      console.log(`💾 SQLite database at ./data/nodebrain.db\n`);
    });

    await initDb();
    console.log('✅ Database ready');

    // Reconcile state left behind by an unclean shutdown (e.g. the backend
    // dying with STATUS_CONTROL_C_EXIT). Runs before anything else touches
    // tasks/agents, so any row still 'running' here is necessarily orphaned.
    const orphanedTasks = reconcileOrphanedTasks();
    const orphanedAgents = reconcileOrphanedAgents();
    if (orphanedTasks > 0 || orphanedAgents > 0) {
      console.log(`♻️  Reconciled ${orphanedTasks} orphaned task(s) and ${orphanedAgents} orphaned agent(s) left running from a previous shutdown`);
    } else {
      console.log('✅ No orphaned tasks or agents from a previous shutdown');
    }

    startScheduler();
    console.log('✅ Scheduler ready');

    registerTelemetrySubscribers();

    // A few minutes after startup, not immediately — snapshot collection
    // shouldn't compete with the slow boot path above (DB init, scheduler,
    // tool registry, RAG). One-shot per process lifetime, which is also one
    // per app launch since this only runs through main().
    setTimeout(() => {
      emitUsageSnapshot().catch((err) => console.warn('[Telemetry] usage snapshot failed:', err));
    }, 3 * 60 * 1000);

    initializeToolRegistry()
      .then(() => console.log('✅ Tool registry ready'))
      .catch(err => console.warn('[ToolRegistry] Failed to initialize:', err));

    initRag()
      .then(() => console.log('✅ RAG engine ready'))
      .catch(err => console.warn('[RAG] Failed to initialize:', (err as Error).message ?? err));

  } catch (err) {
    writeFatalToStderr('fatal error during startup', err);
    process.exit(1);
  }
}

main().catch((err) => {
  writeFatalToStderr('unhandled error in main()', err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down NodeBrain...');
  try {
    await disconnectAll();
  } catch (e) {
    console.error('Error during shutdown:', e);
  }
  process.exit(0);
});

// SIGTERM, SIGHUP, and SIGBREAK previously had no listener at all, so Node's
// default disposition (silent termination) applied and none of them left any
// trace in the log. On Windows, SIGHUP is how Node surfaces
// CTRL_CLOSE_EVENT / CTRL_LOGOFF_EVENT / CTRL_SHUTDOWN_EVENT and SIGBREAK is
// CTRL_BREAK_EVENT — exactly the console-control-event family suspected of
// causing the unexplained STATUS_CONTROL_C_EXIT deaths. If one of these fires
// and this log line appears before the process disappears, that confirms a
// signal reached the process (and, for SIGHUP/SIGBREAK, narrows the cause to
// a console-control event). If the backend still dies with no line at all,
// that rules signals out entirely and confirms it's a direct TerminateProcess
// call, which no in-process handler can intercept.
// Logged synchronously (writeFatalToStderr uses fs.writeSync) and exits
// immediately without awaiting async cleanup — Windows gives very little grace
// period for SIGHUP/SIGBREAK before force-killing, so a slow async shutdown
// could easily lose the very log line this exists to capture.
function handleTerminationSignal(signal: NodeJS.Signals): void {
  writeFatalToStderr(`received ${signal}`, `process received ${signal} — exiting`);
  process.exit(0);
}

process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));
process.on('SIGHUP', () => handleTerminationSignal('SIGHUP'));
process.on('SIGBREAK', () => handleTerminationSignal('SIGBREAK'));

export default app;