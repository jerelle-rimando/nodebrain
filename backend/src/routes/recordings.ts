import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  startRecording, getRecording, listRecordings, finishRecording, discardRecording, RecordingError,
} from '../recorder/recordingSession';
import { BrowserNotFoundError } from '../recorder/browserLauncher';

// Workflow recorder. Starting a recording opens a browser window at the
// given address; the person does the task there and presses Done on the
// pill (or the app calls /done). Progress arrives on /api/events as
// recording:step, recording:finished, recording:discarded and
// recording:browser_closed.
const router = Router();

const startSchema = z.object({ url: z.string().min(1).max(2048) });

function sendError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof RecordingError || err instanceof BrowserNotFoundError) {
    res.status(400).json({ success: false, error: err.message });
    return;
  }
  console.error('[recordings]', err);
  res.status(500).json({ success: false, error: fallback });
}

// POST /api/recordings { url } → the new recording's status
router.post('/', async (req: Request, res: Response) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Give the address of the page to start on.' });
    return;
  }
  const raw = parsed.data.url.trim();
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    res.status(201).json({ success: true, data: await startRecording(url) });
  } catch (err) {
    sendError(res, err, "The recording couldn't start.");
  }
});

router.get('/', (_req: Request, res: Response) => {
  res.json({ success: true, data: listRecordings() });
});

router.get('/:id', (req: Request, res: Response) => {
  const status = getRecording(req.params.id);
  if (!status) {
    res.status(404).json({ success: false, error: 'That recording is no longer open.' });
    return;
  }
  res.json({ success: true, data: status });
});

// POST /api/recordings/:id/done → saves the site agent, workflow and
// version 1; the status's `result` holds what was captured.
router.post('/:id/done', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await finishRecording(req.params.id) });
  } catch (err) {
    sendError(res, err, "The recording couldn't be saved.");
  }
});

router.post('/:id/discard', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await discardRecording(req.params.id) });
  } catch (err) {
    sendError(res, err, "The recording couldn't be thrown away.");
  }
});

export default router;
