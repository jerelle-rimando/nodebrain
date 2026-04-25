import { Router } from 'express';
import { z } from 'zod';
import {
  getAllCustomMCPServers,
  createCustomMCPServer,
  deleteCustomMCPServer,
} from '../db/mcpServerRepository';
import { reloadToolRegistry } from '../mcp/toolRegistry';
import { parseMcpInstallCommand } from '../utils/parseMcpCommand';

const router = Router();

// Accepts either a raw installCommand string or a structured payload
const CreateMCPServerSchema = z.union([
  // Simple format — just a name and install command
  z.object({
    name: z.string().min(1),
    installCommand: z.string().min(1),
    envVars: z.record(z.string()).default({}),
  }),
  // Legacy structured format — still supported
  z.discriminatedUnion('transport', [
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
  ]),
]);

router.get('/', (_req, res) => {
  try {
    const servers = getAllCustomMCPServers().map(s => ({
      ...s,
      envVars: Object.fromEntries(
        Object.keys(s.envVars).map(k => [k, '••••••••'])
      ),
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
    let transport: 'stdio' | 'sse';
    let command: string | undefined;
    let args: string[];
    let url: string | undefined;
    let envVars: Record<string, string>;

    if ('installCommand' in data) {
      // Simple format — parse the install command
      const parsed = parseMcpInstallCommand(data.installCommand);
      transport = parsed.transport;
      command = parsed.command;
      args = parsed.args;
      url = parsed.url;
      envVars = data.envVars;
    } else {
      // Legacy structured format
      transport = data.transport;
      command = 'command' in data ? data.command : undefined;
      args = data.args;
      url = 'url' in data ? data.url : undefined;
      envVars = data.envVars;
    }

    const server = createCustomMCPServer({
      name: data.name,
      transport,
      command,
      args,
      url,
      envVars,
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
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Server not found' });
    }

    reloadToolRegistry().catch(console.error);

    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;