import { Router } from 'express';
import { z } from 'zod';
import {
  getAllCustomMCPServers,
  createCustomMCPServer,
  deleteCustomMCPServer,
  getCustomMCPServerById,
} from '../db/mcpServerRepository';
import { reloadToolRegistry } from '../mcp/toolRegistry';

const router = Router();

const CreateMCPServerSchema = z.discriminatedUnion('transport', [
  z.object({
    name: z.string().min(1),
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    envVars: z.record(z.string()).default({}),
  }),
  z.object({
    name: z.string().min(1),
    transport: z.literal('sse'),
    url: z.string().url(),
    args: z.array(z.string()).default([]),
    envVars: z.record(z.string()).default({}),
  }),
]);

router.get('/', (_req, res) => {
  try {
    const servers = getAllCustomMCPServers().map(s => ({
      ...s,
      envVars: Object.fromEntries(Object.keys(s.envVars).map(k => [k, '••••••••'])),
    }));
    res.json({ success: true, data: servers });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = CreateMCPServerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.message });
    }

    const data = parsed.data;
    const server = createCustomMCPServer({
      name: data.name,
      transport: data.transport,
      command: 'command' in data ? data.command : undefined,
      args: data.args,
      url: 'url' in data ? data.url : undefined,
      envVars: data.envVars,
    });

    reloadToolRegistry().catch(console.error);

    res.status(201).json({ success: true, data: { ...server, envVars: {} } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const deleted = deleteCustomMCPServer(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Server not found' });

    reloadToolRegistry().catch(console.error);

    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;