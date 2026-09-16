import { Router } from 'express';
import { telemetry } from '../utils/telemetry';

const router = Router();

// POST /api/telemetry — thin wrapper around the telemetry() helper so any
// caller that can't import backend internals directly (or a future non-Node
// call site) has an HTTP path to the same fire-and-forget forward to main.
// Always responds success; a telemetry failure must never surface as an error.
router.post('/', (req, res) => {
  const body = (req.body ?? {}) as { event?: unknown; properties?: unknown };
  if (typeof body.event === 'string' && body.event) {
    const properties = (body.properties && typeof body.properties === 'object') ? body.properties as Record<string, unknown> : {};
    telemetry(body.event, properties);
  }
  res.status(204).end();
});

export default router;
