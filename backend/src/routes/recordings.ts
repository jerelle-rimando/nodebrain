import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  startRecording, getRecording, listRecordings, finishRecording, saveRecording, discardRecording, RecordingError,
} from '../recorder/recordingSession';
import { BrowserNotFoundError } from '../recorder/browserLauncher';
import type { SaveRecordingRequest } from '../../shared-types';

// Workflow recorder. Starting a recording opens a browser window at the
// given address; the person does the task there and presses Done on the
// pill (or the app calls /done). Done opens the review screen; nothing is
// saved until /save. Progress arrives on /api/events as recording:step,
// recording:finished (now in review), recording:saved,
// recording:discarded and recording:browser_closed.
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

// POST /api/recordings/:id/done → stops recording and closes the window.
// Nothing is saved yet: the status comes back in state 'review' with a
// `draft` for the review screen.
router.post('/:id/done', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await finishRecording(req.params.id) });
  } catch (err) {
    sendError(res, err, "The recording couldn't be finished.");
  }
});

const saveSchema = z.object({
  name: z.string().max(200),
  values: z.array(z.object({
    stepKey: z.string().min(1).max(20),
    mode: z.enum(['changes', 'fixed']),
    secret: z.boolean(),
  })).max(500),
  optional: z.array(z.string().min(1).max(20)).max(500).optional(),
  // Repeats to leave out. Must be listed here: zod drops unknown keys, and a
  // missing list means "leave out every one offered".
  dropRepeats: z.array(z.string().min(1).max(20)).max(500).optional(),
});

// The schema and SaveRecordingRequest must describe exactly the same body:
// zod drops keys it doesn't list, so a field added to the type alone was
// silently lost at this route (dropRepeats, 2026-11-22), and one added to
// the schema alone would be accepted with nothing reading it. Plain two-way
// assignability isn't enough: an extra optional field passes both ways. This
// is exact type identity, so a field on either side alone fails to compile.
type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const saveSchemaMatchesRequest: Exactly<z.infer<typeof saveSchema>, SaveRecordingRequest> = true;
void saveSchemaMatchesRequest;

// POST /api/recordings/:id/save { name, values } → creates the site agent,
// the workflow, its input fields (from values marked "Changes") and
// version 1. The status's `result` holds what was saved.
router.post('/:id/save', async (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Something was missing from the save request.' });
    return;
  }
  try {
    res.json({ success: true, data: await saveRecording(req.params.id, parsed.data) });
  } catch (err) {
    sendError(res, err, "The workflow couldn't be saved.");
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
