import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { buildRunForm } from '../workflows/runPlan';
import { buildOverview } from '../workflows/workflowList';
import { askAboutSite, SiteChatError } from '../workflows/siteChat';
import { ICON_TYPES, siteIconsDir } from '../recorder/siteLook';
import { deleteWorkflow, getRunsByWorkflow } from '../db/workflowRepository';
import { isRunActive } from '../replay/replayEngine';

// Saved workflows for the app: the list with its sites, the run form (inputs
// plus the steps in plain words), and the sites' saved favicons. Starting a
// run is POST /api/workflows/:id/runs in workflowRuns.ts.
export const workflowsRouter = Router();

// GET /api/site-icons/<file> → a site's favicon, saved while recording or
// running there (recorder/siteLook.ts). Only files in that folder, by a name
// NodeBrain made; an SVG is served so that it can't run anything even if
// opened on its own.
workflowsRouter.get('/site-icons/:file', (req: Request, res: Response) => {
  const m = /^([a-z0-9._-]+)\.(png|ico|svg|gif|jpg|webp)$/i.exec(req.params.file);
  if (!m || m[1].startsWith('.')) { res.status(404).end(); return; }
  res.setHeader('Content-Type', ICON_TYPES[m[2].toLowerCase() as keyof typeof ICON_TYPES]);
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // the URL's ?v= changes with the file
  res.sendFile(m[0], { root: siteIconsDir(), dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

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

// DELETE /api/workflows/:id → removes the workflow with its recording and run
// history. Refused while one of its runs is still going.
workflowsRouter.delete('/workflows/:id', (req: Request, res: Response) => {
  if (getRunsByWorkflow(req.params.id).some((r) => isRunActive(r.id))) {
    res.status(409).json({ success: false, error: 'Stop the run first, then delete the workflow.' });
    return;
  }
  if (!deleteWorkflow(req.params.id)) {
    res.status(404).json({ success: false, error: "That workflow doesn't exist anymore." });
    return;
  }
  res.json({ success: true, data: { id: req.params.id } });
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
