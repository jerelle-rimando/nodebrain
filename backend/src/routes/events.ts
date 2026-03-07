import { Router, Request, Response } from 'express';
import { agentEvents } from '../agents/agentEngine';
import type { TaskLog, Task } from '../../shared-types';

const router = Router();

// GET /api/events — SSE stream for real-time updates
router.get('/', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send a heartbeat every 15s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  const onLog = (log: TaskLog) => sendEvent('log', log);
  const onTaskStart = (task: Task) => sendEvent('task:start', task);
  const onTaskComplete = (task: Task) => sendEvent('task:complete', task);
  const onTaskFailed = (task: Task) => sendEvent('task:failed', task);

  agentEvents.on('log', onLog);
  agentEvents.on('task:start', onTaskStart);
  agentEvents.on('task:complete', onTaskComplete);
  agentEvents.on('task:failed', onTaskFailed);

  req.on('close', () => {
    clearInterval(heartbeat);
    agentEvents.off('log', onLog);
    agentEvents.off('task:start', onTaskStart);
    agentEvents.off('task:complete', onTaskComplete);
    agentEvents.off('task:failed', onTaskFailed);
  });
});

export default router;
