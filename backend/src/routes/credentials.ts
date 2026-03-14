import { Router } from 'express';
import { z } from 'zod';
import {
  getAllCredentials,
  getCredentialById,
  createCredential,
  updateCredential,
  deleteCredential,
} from '../vault/credentialVault';
import { reloadToolRegistry } from '../mcp/toolRegistry';

const router = Router();

const CreateCredentialSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
  value: z.string().min(1),
  description: z.string().optional(),
});

router.get('/', (_req, res) => {
  try {
    const credentials = getAllCredentials();
    res.json({ success: true, data: credentials });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.get('/:id', (req, res) => {
  try {
    const credential = getCredentialById(req.params.id);
    if (!credential) return res.status(404).json({ success: false, error: 'Credential not found' });
    res.json({ success: true, data: credential });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.post('/', async (req, res) => {
  try {
    const parsed = CreateCredentialSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.message });
    }

    const { name, provider, value, description } = parsed.data;
    const credential = createCredential(name, provider, value, description);

    // Reload tool registry so newly added integration activates immediately
    reloadToolRegistry().catch(console.error);

    res.status(201).json({ success: true, data: credential });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { value } = req.body as { value?: string };
    if (!value) return res.status(400).json({ success: false, error: 'value is required' });

    const updated = updateCredential(req.params.id, value);
    if (!updated) return res.status(404).json({ success: false, error: 'Credential not found' });

    // Reload tool registry so updated credential takes effect immediately
    reloadToolRegistry().catch(console.error);

    res.json({ success: true, data: { id: req.params.id, updated: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const deleted = deleteCredential(req.params.id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Credential not found' });

    // Reload so disconnected integration deactivates immediately
    reloadToolRegistry().catch(console.error);

    res.json({ success: true, data: { id: req.params.id } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;