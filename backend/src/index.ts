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

const PORT = process.env.PORT ?? 3001;
const app = express();

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok', timestamp: new Date().toISOString() } });
});

app.use('/api/agents', agentRouter);
app.use('/api/tasks', taskRouter);
app.use('/api/logs', logsRouter);
app.use('/api/credentials', credentialRouter);
app.use('/api/chat', chatRouter);
app.use('/api/events', eventsRouter);
app.use('/api/integrations', integrationsRouter);
app.use('/api/auth', authRouter);

async function main() {
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
}

main().catch(console.error);

process.on('SIGINT', async () => {
  console.log('\nShutting down NodeBrain...');
  await disconnectAll();
  process.exit(0);
});

export default app;