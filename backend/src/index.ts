import express from 'express';
import cors from 'cors';
import { initDb } from './db/database';
import { startScheduler } from './scheduler/scheduler';
import agentRouter from './routes/agents';
import { taskRouter, logsRouter } from './routes/tasks';
import credentialRouter from './routes/credentials';
import chatRouter from './routes/chat';
import eventsRouter from './routes/events';

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

async function main() {
  await initDb();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`\n🧠 NodeBrain backend running at http://localhost:${PORT}`);
    console.log(`📡 SSE events at http://localhost:${PORT}/api/events`);
    console.log(`💾 SQLite database at ./data/nodebrain.db\n`);
  });
}

main().catch(console.error);

process.on('SIGINT', () => { process.exit(0); });

export default app;
