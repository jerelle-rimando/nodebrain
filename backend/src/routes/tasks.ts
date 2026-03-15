import { Router } from 'express';
import {
  getAllTasks,
  getTasksByAgent,
  getTaskById,
  getLogsByTask,
  getLogsByAgent,
  getAllRecentLogs,
} from '../db/taskRepository';

const router = Router();

// GET /api/tasks
router.get('/', (_req, res) => {
  try {
    const tasks = getAllTasks();
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/tasks/agent/:agentId
router.get('/agent/:agentId', (req, res) => {
  try {
    const tasks = getTasksByAgent(req.params.agentId);
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/tasks/:id
router.get('/:id', (req, res) => {
  try {
    const task = getTaskById(req.params.id);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    res.json({ success: true, data: task });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/tasks/:id/logs
router.get('/:id/logs', (req, res) => {
  try {
    const logs = getLogsByTask(req.params.id);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/logs — all recent logs
router.get('/logs/all', (_req, res) => {
  try {
    const logs = getAllRecentLogs();
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export { router as taskRouter };

// Separate logs router
const logsRouter = Router();

logsRouter.get('/', (_req, res) => {
  try {
    const logs = getAllRecentLogs(200);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

logsRouter.get('/agent/:agentId', (req, res) => {
  try {
    const logs = getLogsByAgent(req.params.agentId);
    res.json({ success: true, data: logs });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export { logsRouter };
