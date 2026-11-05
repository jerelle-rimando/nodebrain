import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { buildRunForm } from '../workflows/runPlan';
import { buildOverview } from '../workflows/workflowList';
import { setWorkflowIcon } from '../db/workflowRepository';

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
