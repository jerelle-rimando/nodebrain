import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  getAllAgents,
  getAgentById,
  createAgent,
  updateAgent,
  deleteAgent,
} from '../db/agentRepository';
import { executeAgentTask } from '../agents/agentEngine';
import { scheduleAgent, unscheduleAgent } from '../scheduler/scheduler';
import type { Agent } from '../../shared-types';

const router = Router();

const AgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  provider: z.enum(['openai', 'anthropic', 'custom']).default('openai'),
  model: z.string().default('gpt-4o-mini'),
  systemPrompt: z.string().default('You are a helpful AI assistant.'),
  schedule: z.string().optional(),
  toolPermissions: z.array(z.string()).default([]),
  config: z.object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().optional(),
    credentialIds: z.array(z.string()).optional(),
  }).default({}),
});

// GET /api/agents
router.get('/', (_req, res) => {
  try {
    const agents = getAllAgents();
    res.json({ success: true, data: agents });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// GET /api/agents/:id
router.get('/:id', (req, res) => {
  try {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, data: agent });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/agents
router.post('/', (req, res) => {
  try {
    const parsed = AgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.message });
    }

    const now = new Date().toISOString();
    const agent: Agent = {
      id: uuidv4(),
      ...parsed.data,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
    };

    createAgent(agent);

    if (agent.schedule) {
      scheduleAgent(agent);
    }

    res.status(201).json({ success: true, data: agent });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// PATCH /api/agents/:id
router.patch('/:id', (req, res) => {
  try {
    const existing = getAgentById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: 'Agent not found' });

    const updated = updateAgent(req.params.id, req.body);
    if (!updated) return res.status(404).json({ success: false, error: 'Agent not found' });

    // Re-schedule if schedule changed
    if (updated.schedule) {
      scheduleAgent(updated);
    } else {
      unscheduleAgent(updated.id);
    }

    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// DELETE /api/agents/:id
router.delete('/:id', (req, res) => {
  try {
    unscheduleAgent(req.params.id);
    const deleted = deleteAgent(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Agent not found' });
    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// POST /api/agents/:id/execute
router.post('/:id/execute', async (req, res) => {
  try {
    const agent = getAgentById(req.params.id);
    if (!agent) return res.status(404).json({ success: false, error: 'Agent not found' });

    const { input } = req.body as { input?: string };
    if (!input) return res.status(400).json({ success: false, error: 'input is required' });

    // Fire and return immediately — task runs async
    executeAgentTask(agent, input).catch(console.error);

    res.json({ success: true, data: { message: 'Task started' } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
