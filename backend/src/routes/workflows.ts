import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { buildRunForm } from '../workflows/runPlan';
import { buildOverview } from '../workflows/workflowList';
import { setWorkflowIcon } from '../db/workflowRepository';
import { askAboutSite, SiteChatError } from '../workflows/siteChat';

// Saved workflows for the app: the list with its sites, the run form (inputs
// plus the steps in plain words), and the icon a person picks. Starting a run
// is POST /api/workflows/:id/runs in workflowRuns.ts.
export const workflowsRouter = Router();

// GET /api/workflows → { sites, workflows }, each workflow with its state and next action
workflowsRouter.get('/workflows', (_req: Request, res: Response) => {
  res.json({ success: true, data: buildOverview() });
});

workflowsRouter.get('/workflows/:id/run-form', (req: Request, res: Response) => {
  const form = buildRunForm(req.params.id);
  if (!form) {
    res.status(404).json({ success: false, error: "That workflow doesn't exist anymore." });
    return;
  }
  res.json({ success: true, data: form });
});

// PUT /api/workflows/:id/icon { emoji } — null goes back to the icon from its name.
const iconSchema = z.object({ emoji: z.string().min(1).max(16).nullable() });
workflowsRouter.put('/workflows/:id/icon', (req: Request, res: Response) => {
  const parsed = iconSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'That icon was not in the expected shape.' });
    return;
  }
  if (!setWorkflowIcon(req.params.id, parsed.data.emoji)) {
    res.status(404).json({ success: false, error: "That workflow doesn't exist anymore." });
    return;
  }
  res.json({ success: true, data: { id: req.params.id, emoji: parsed.data.emoji } });
});

// POST /api/sites/:id/chat { messages: [{ role, content }], provider?, model? } → { reply }
// The Dashboard's site chat: questions about this site's workflows.
const chatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8_000) })).min(1).max(60),
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
});
workflowsRouter.post('/sites/:id/chat', async (req: Request, res: Response) => {
  const parsed = chatSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'That message was not in the expected shape.' });
    return;
  }
  try {
    const reply = await askAboutSite(req.params.id, parsed.data.messages, parsed.data);
    res.json({ success: true, data: { reply } });
  } catch (err) {
    if (err instanceof SiteChatError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[site-chat] failed:', msg);
    res.status(500).json({
      success: false,
      error: /ECONNREFUSED|connection error|fetch failed/i.test(msg)
        ? "Couldn't reach the AI model. Check it's set up in Settings, then try again."
        : `The AI model didn't answer: ${msg}`,
    });
  }
});
