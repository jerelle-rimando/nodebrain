import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getWorkflowById, getRunsByWorkflow, getFieldsByWorkflow } from '../db/workflowRepository';
import { startRun, cancelRun, getRunDetail, isRunActive, RunStartError } from '../replay/replayEngine';
import { resolveTakeControl, listTakeControlRequests } from '../browser/takeControl';
import { repairStatus, stoppedScreenshot, startRepair, cancelRepair, releaseRun, RepairError } from '../replay/repair';

// Replaying saved workflows. A run starts here and goes on in the
// background; progress arrives on /api/events as run:started, run:step and
// run:finished, and a pause for the person as browser:take_control_needed.
export const workflowRunsRouter = Router();

const startSchema = z.object({
  inputs: z.record(z.string(), z.string().max(10_000)).default({}),
  trigger: z.enum(['manual', 'chat', 'schedule']).default('manual'),
});

// GET /api/workflows/:id/inputs → what the run asks for (never recorded secret values)
workflowRunsRouter.get('/workflows/:id/inputs', (req: Request, res: Response) => {
  if (!getWorkflowById(req.params.id)) {
    res.status(404).json({ success: false, error: "That workflow doesn't exist anymore." });
    return;
  }
  const fields = getFieldsByWorkflow(req.params.id).map((f) => ({
    key: f.key, label: f.label, kind: f.kind, secret: f.secret, required: f.required,
    recordedValue: f.secret ? undefined : f.recordedValue,
  }));
  res.json({ success: true, data: fields });
});

// POST /api/workflows/:id/runs { inputs: { [fieldKey]: value } } → the new run
workflowRunsRouter.post('/workflows/:id/runs', (req: Request, res: Response) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'The values for this run were not in the expected shape.' });
    return;
  }
  try {
    const run = startRun(req.params.id, parsed.data.inputs, parsed.data.trigger);
    res.status(201).json({ success: true, data: run });
  } catch (err) {
    if (err instanceof RunStartError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    console.error('[workflow-runs] start failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: "The workflow couldn't start." });
  }
});

workflowRunsRouter.get('/workflows/:id/runs', (req: Request, res: Response) => {
  res.json({ success: true, data: getRunsByWorkflow(req.params.id) });
});

// GET /api/workflow-runs/:id → { run, steps, active, repair? }
workflowRunsRouter.get('/workflow-runs/:id', (req: Request, res: Response) => {
  const detail = getRunDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ success: false, error: "That run doesn't exist." });
    return;
  }
  res.json({ success: true, data: { ...detail, active: isRunActive(req.params.id), repair: repairStatus(req.params.id) } });
});

// The picture taken where the run stopped.
workflowRunsRouter.get('/workflow-runs/:id/screenshot', (req: Request, res: Response) => {
  const file = stoppedScreenshot(req.params.id);
  if (!file) {
    res.status(404).json({ success: false, error: 'There is no picture for this run.' });
    return;
  }
  res.sendFile(file);
});

// "Show me where it is": the browser comes forward (or opens, if the run's
// window has closed) with a pill asking the person to point at the element.
workflowRunsRouter.post('/workflow-runs/:id/repair', async (req: Request, res: Response) => {
  try {
    await startRepair(req.params.id);
    res.json({ success: true, data: repairStatus(req.params.id) ?? null });
  } catch (err) {
    if (err instanceof RepairError) {
      res.status(400).json({ success: false, error: err.message });
      return;
    }
    console.error('[workflow-runs] repair failed to start:', err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: "Couldn't start fixing this step." });
  }
});

workflowRunsRouter.post('/workflow-runs/:id/repair/cancel', (req: Request, res: Response) => {
  if (!cancelRepair(req.params.id)) {
    res.status(404).json({ success: false, error: "Nothing is being fixed for this run." });
    return;
  }
  res.json({ success: true, data: { runId: req.params.id } });
});

// "Fix it later": a run waiting for a repair closes its window and ends.
workflowRunsRouter.post('/workflow-runs/:id/release', (req: Request, res: Response) => {
  if (!releaseRun(req.params.id)) {
    res.status(404).json({ success: false, error: "This run isn't waiting for you." });
    return;
  }
  res.json({ success: true, data: { runId: req.params.id } });
});

workflowRunsRouter.post('/workflow-runs/:id/cancel', (req: Request, res: Response) => {
  if (!cancelRun(req.params.id)) {
    res.status(404).json({ success: false, error: "That run isn't going right now." });
    return;
  }
  res.json({ success: true, data: { runId: req.params.id } });
});

// Take Control, for runs and (once the agent engine uses this module) tasks.
workflowRunsRouter.get('/take-control', (_req: Request, res: Response) => {
  res.json({ success: true, data: listTakeControlRequests() });
});

// POST /api/take-control/:requestId { done } — done: the person finished in
// the browser; false: they want the run to stop.
workflowRunsRouter.post('/take-control/:requestId', (req: Request, res: Response) => {
  const { done } = (req.body ?? {}) as { done?: unknown };
  if (typeof done !== 'boolean') {
    res.status(400).json({ success: false, error: 'Say whether you are done (true) or want to stop (false).' });
    return;
  }
  if (!resolveTakeControl(req.params.requestId, done)) {
    res.status(404).json({ success: false, error: 'That pause has already ended.' });
    return;
  }
  res.json({ success: true, data: { requestId: req.params.requestId, done } });
});
