import { Router, Request, Response } from 'express';
import { listWorkflows, buildRunForm } from '../workflows/runPlan';
import { repairStatus } from '../replay/repair';

// Saved workflows for the app: the list, and the run form (inputs plus the
// steps in plain words). Starting a run is POST /api/workflows/:id/runs in
// workflowRuns.ts.
export const workflowsRouter = Router();

workflowsRouter.get('/workflows', (_req: Request, res: Response) => {
  // A workflow whose last run stopped because the site changed gets a Fix.
  const items = listWorkflows().map((w) => (w.lastRun?.status === 'needs_attention'
    ? { ...w, lastRun: { ...w.lastRun, needsFix: !!repairStatus(w.lastRun.id)?.canFix } }
    : w));
  res.json({ success: true, data: items });
});

workflowsRouter.get('/workflows/:id/run-form', (req: Request, res: Response) => {
  const form = buildRunForm(req.params.id);
  if (!form) {
    res.status(404).json({ success: false, error: "That workflow doesn't exist anymore." });
    return;
  }
  res.json({ success: true, data: form });
});
