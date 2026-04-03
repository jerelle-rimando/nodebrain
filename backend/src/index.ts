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
import authRouter from './routes/auth';
import { parseNaturalSchedule } from './utils/parseSchedule';

const PORT = process.env.PORT ?? 3001;
const app = express();

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
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
app.use('/api/auth', limiter, authRouter);

async function main() {
  try {
    /**
     * SAFE VAULT_SECRET HANDLING
     * - No overwriting .env during runtime under PM2
     * - Only generates in-memory if missing
     * - Logs warning instead of mutating files
     */
    if (!process.env.VAULT_SECRET) {
      const secret = crypto.randomBytes(32).toString('hex');
      process.env.VAULT_SECRET = secret;

      console.warn(
        '⚠️ VAULT_SECRET not found in .env. Using generated value in memory only. ' +
        'Persist it manually in .env to avoid regeneration on restart.'
      );
    }

    // Verify pdfjs-dist loads correctly
    import('pdfjs-dist/legacy/build/pdf.mjs').catch((err) => {
      console.warn('[PDF] pdfjs-dist failed to load:', err.message);
    });

    await initDb();
    console.log('✅ Database ready');

    await initRag();
    console.log('✅ RAG engine ready');

    await initializeToolRegistry();
    console.log('✅ Tool registry ready');

    startScheduler();
    console.log('✅ Scheduler ready');

    app.listen(PORT, () => {
      console.log(`\n🧠 NodeBrain backend running at http://localhost:${PORT}`);
      console.log(`📡 SSE events at http://localhost:${PORT}/api/events`);
      console.log(`💾 SQLite database at ./data/nodebrain.db\n`);
    });

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