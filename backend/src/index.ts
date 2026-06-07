import 'dotenv/config';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { initDb } from './db/database';
import { startScheduler } from './scheduler/scheduler';
import { initRag } from './rag/ragEngine';
import { initializeToolRegistry } from './mcp/toolRegistry';
import { disconnectAll } from './mcp/mcpClient';
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

    // Verify pdfjs-dist loads correctly
    import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      console.warn('[PDF] pdfjs-dist failed to load:', err.message);
    });

    await initDb();
    console.log('✅ Database ready');

    await initializeToolRegistry();
    console.log('✅ Tool registry ready');

    startScheduler();
    console.log('✅ Scheduler ready');

    app.listen(PORT, BIND_HOST, () => {
      console.log(`\n🧠 NodeBrain backend running at http://${BIND_HOST}:${PORT}`);
      console.log(`📡 SSE events at http://localhost:${PORT}/api/events`);
      console.log(`💾 SQLite database at ./data/nodebrain.db\n`);
    });

    initRag()
      .then(() => console.log('✅ RAG engine ready'))
      .catch(err => console.warn('[RAG] Failed to initialize:', (err as Error).message ?? err));

  } catch (err) {
    console.error('❌ Fatal error during startup:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('❌ Unhandled error in main():', err);
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

export default app;