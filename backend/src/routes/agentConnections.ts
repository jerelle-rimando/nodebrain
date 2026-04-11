import { Router } from 'express';
import { z } from 'zod';
import {
  getAllConnections,
  createConnection,
  deleteConnection,
  deleteConnectionByAgents,
} from '../db/agentConnectionRepository';

const router = Router();

const CreateConnectionSchema = z.object({
  sourceAgentId: z.string().min(1),
  targetAgentId: z.string().min(1),
});

router.get('/', (_req, res) => {
  try {
    const connections = getAllConnections();
    res.json({ success: true, data: connections });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.post('/', (req, res) => {
  try {
    const parsed = CreateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.message });
    }
    const { sourceAgentId, targetAgentId } = parsed.data;
    const connection = createConnection(sourceAgentId, targetAgentId);
    res.status(201).json({ success: true, data: connection });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const deleted = deleteConnection(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Connection not found' });
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.delete('/between/:sourceId/:targetId', (req, res) => {
  try {
    const deleted = deleteConnectionByAgents(req.params.sourceId, req.params.targetId);
    if (!deleted) return res.status(404).json({ success: false, error: 'Connection not found' });
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;