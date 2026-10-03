import { Router } from 'express';
import { z } from 'zod';
import {
  getAllCustomMCPServers,
  createCustomMCPServer,
  deleteCustomMCPServer,
  updateCustomMCPServerAccessWarning,
} from '../db/mcpServerRepository';
import { reloadToolRegistry } from '../mcp/toolRegistry';
import { parseMcpInstallCommand } from '../utils/parseMcpCommand';
import { assessMcpServerAccess } from '../utils/mcpAccessRisk';

const router = Router();

const InstallCommandSchema = z.object({
  name: z.string().min(1),
  installCommand: z.string().min(1),
  envVars: z.record(z.string()).default({}),
});

// Accepts either a raw installCommand string or a structured payload
const CreateMCPServerSchema = z.union([
  // Simple format — just a name and install command
  InstallCommandSchema,
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

const AssessMCPServerSchema = InstallCommandSchema.omit({ name: true });

router.get('/', (_req, res) => {
  try {
    const servers = getAllCustomMCPServers().map(s => {
      // Re-derive on every load so a row edited outside the app (or added
      // before access_warning existed) still gets the right badge. The stored
      // value is only rewritten when it actually changed.
      const accessWarning = assessMcpServerAccess(s);
      if (JSON.stringify(accessWarning) !== JSON.stringify(s.accessWarning)) {
        updateCustomMCPServerAccessWarning(s.id, accessWarning);
      }
      return {
        ...s,
        accessWarning,
        envVars: Object.fromEntries(
          Object.keys(s.envVars).map(k => [k, '••••••••'])
        ),
      };
    });
    res.json({ success: true, data: servers });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

// Dry run for the Add MCP Server form: returns what the server would be able to
// reach so the user can confirm before anything is saved or spawned. Purely
// informational — POST / never requires this to have been called.
router.post('/assess', (req, res) => {
  try {
    const parsed = AssessMCPServerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.message });
    }
    const { transport, command, args } = parseMcpInstallCommand(parsed.data.installCommand);
    const accessWarning = assessMcpServerAccess({ transport, command, args, envVars: parsed.data.envVars });
    res.json({ success: true, data: { accessWarning } });
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
      accessWarning: assessMcpServerAccess({ transport, command, args, envVars }),
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
