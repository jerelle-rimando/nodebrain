// NodeBrain telemetry ingest. Runs in a V8 isolate on Cloudflare Workers —
// web platform APIs only (fetch, Request/Response, crypto.subtle), no Node.
//
// POST /events  body: JSON array of event envelopes, as written by the
// Electron main process to telemetry-queue.jsonl:
//   { installId, event, ts, appVersion, platform, osRelease, properties }
//
// Responses (the client keys its retry/clear decision off these):
//   200  every event in the batch is committed (or was already stored) — clear it
//   400  malformed batch; body says which event — retrying it unchanged can't succeed
//   401  missing/wrong shared secret
//   413  batch or body over the cap
//   429  per-IP rate limit hit — retry later
//   503  D1 write failed — retry later
//
// The shared secret ships inside the desktop app, so it is a noise filter, not
// authentication. The per-IP rate limit runs before it so guessing the secret
// or replaying it can't burn through D1's daily write allowance.

const AUTH_HEADER = 'x-nodebrain-telemetry-key';

// Keep in sync with TELEMETRY_BATCH_SIZE in electron/telemetrySender.ts.
const MAX_EVENTS_PER_BATCH = 100;
const MAX_BODY_BYTES = 256 * 1024;

// Mirrors the client scrubber's output shape (electron/main.ts) as defense in
// depth: anything outside it is not something the app would ever send.
const MAX_PROPERTY_KEYS = 30;
const MAX_PROPERTIES_JSON_BYTES = 4 * 1024;
const MAX_STRING_LEN = 100;
const MAX_ARRAY_LEN = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const APP_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const PLATFORM_RE = /^[a-z0-9]{1,16}$/;
const OS_RELEASE_RE = /^[0-9A-Za-z._+-]{1,64}$/;
const PROPERTY_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// Earliest plausible event (well before the first telemetry-enabled release)
// and how far ahead of server time a client clock may run.
const MIN_TS_MS = Date.UTC(2025, 0, 1);
const MAX_CLOCK_SKEW_MS = 2 * 24 * 60 * 60 * 1000;

interface EventRow {
  day: string;
  event: string;
  installId: string;
  ts: string;
  appVersion: string;
  platform: string;
  osRelease: string;
  properties: Record<string, unknown>;
  propertiesJson: string;
}

class BadEvent extends Error {
  constructor(readonly index: number, reason: string) {
    super(reason);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/events') return json(404, { error: 'not_found' });
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });

    if (!(await withinRateLimit(request, env))) {
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    }

    if (!secretMatches(request.headers.get(AUTH_HEADER), env.TELEMETRY_SECRETS)) {
      return json(401, { error: 'unauthorized' });
    }

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('application/json')) {
      return json(415, { error: 'unsupported_media_type' });
    }

    const declaredLength = Number(request.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json(413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
    }
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      return json(413, { error: 'body_too_large', maxBytes: MAX_BODY_BYTES });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return json(400, { error: 'invalid_json' });
    }
    if (!Array.isArray(payload) || payload.length === 0) {
      return json(400, { error: 'expected_non_empty_array' });
    }
    if (payload.length > MAX_EVENTS_PER_BATCH) {
      return json(413, { error: 'batch_too_large', maxEvents: MAX_EVENTS_PER_BATCH });
    }

    let rows: EventRow[];
    try {
      const now = Date.now();
      rows = payload.map((item, index) => validateEvent(item, index, now));
    } catch (err) {
      if (err instanceof BadEvent) return json(400, { error: 'invalid_event', index: err.index, reason: err.message });
      throw err;
    }

    const receivedAt = new Date().toISOString();
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO events (
         day, event, install_id, ts, dedup, received_at, app_version, platform, os_release,
         step, stage, reason_code, days_since_install, minutes_since_install, properties
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const statements = await Promise.all(rows.map(async (row) => insert.bind(
      row.day,
      row.event,
      row.installId,
      row.ts,
      await dedupKey(row.propertiesJson),
      receivedAt,
      row.appVersion,
      row.platform,
      row.osRelease,
      stringProp(row.properties, 'step'),
      stringProp(row.properties, 'stage'),
      stringProp(row.properties, 'reasonCode'),
      intProp(row.properties, 'daysSinceInstall'),
      intProp(row.properties, 'minutesSinceInstall'),
      row.propertiesJson,
    )));

    // D1 batch() runs the statements as one transaction and resolves only after
    // it commits, so a 200 here means every row is durably stored.
    let inserted = 0;
    try {
      const results = await env.DB.batch(statements);
      for (const result of results) inserted += result.meta.changes ?? 0;
    } catch (err) {
      console.error('D1 batch insert failed', err);
      return json(503, { error: 'storage_unavailable' }, { 'Retry-After': '300' });
    }

    // inserted < accepted means some rows were already stored by an earlier
    // attempt whose response never reached the client.
    return json(200, { accepted: rows.length, inserted });
  },
} satisfies ExportedHandler<Env>;

async function withinRateLimit(request: Request, env: Env): Promise<boolean> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  try {
    const { success } = await env.IP_RATE_LIMITER.limit({ key: ip });
    return success;
  } catch (err) {
    // Fail open: a rate limiter outage shouldn't drop legitimate telemetry.
    console.error('rate limiter unavailable', err);
    return true;
  }
}

// TELEMETRY_SECRETS is comma-separated so the secret can be rotated: add the
// new value, ship clients that send it, then remove the old one.
function secretMatches(provided: string | null, configured: string | undefined): boolean {
  if (!provided || !configured) return false;
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  let match = false;
  for (const candidate of configured.split(',')) {
    const candidateBytes = encoder.encode(candidate.trim());
    if (candidateBytes.byteLength === 0 || candidateBytes.byteLength !== providedBytes.byteLength) continue;
    if (crypto.subtle.timingSafeEqual(candidateBytes, providedBytes)) match = true;
  }
  return match;
}

function validateEvent(item: unknown, index: number, now: number): EventRow {
  if (!isPlainObject(item)) throw new BadEvent(index, 'event must be an object');
  const { installId, event, ts, appVersion, platform, osRelease, properties } = item;

  if (typeof installId !== 'string' || !UUID_RE.test(installId)) throw new BadEvent(index, 'installId');
  if (typeof event !== 'string' || !EVENT_RE.test(event)) throw new BadEvent(index, 'event');
  if (typeof ts !== 'string' || !ISO_TS_RE.test(ts)) throw new BadEvent(index, 'ts');
  const tsMs = Date.parse(ts);
  if (!Number.isFinite(tsMs) || tsMs < MIN_TS_MS || tsMs > now + MAX_CLOCK_SKEW_MS) {
    throw new BadEvent(index, 'ts out of range');
  }
  if (typeof appVersion !== 'string' || !APP_VERSION_RE.test(appVersion)) throw new BadEvent(index, 'appVersion');
  if (typeof platform !== 'string' || !PLATFORM_RE.test(platform)) throw new BadEvent(index, 'platform');
  if (typeof osRelease !== 'string' || !OS_RELEASE_RE.test(osRelease)) throw new BadEvent(index, 'osRelease');

  if (!isPlainObject(properties)) throw new BadEvent(index, 'properties must be an object');
  const keys = Object.keys(properties);
  if (keys.length > MAX_PROPERTY_KEYS) throw new BadEvent(index, 'too many properties');
  for (const key of keys) {
    if (!PROPERTY_KEY_RE.test(key)) throw new BadEvent(index, `property key ${JSON.stringify(key.slice(0, 64))}`);
    if (!isAllowedPropertyValue(properties[key])) throw new BadEvent(index, `property ${key}`);
  }
  const propertiesJson = JSON.stringify(properties);
  if (new TextEncoder().encode(propertiesJson).byteLength > MAX_PROPERTIES_JSON_BYTES) {
    throw new BadEvent(index, 'properties too large');
  }

  return {
    day: ts.slice(0, 10),
    event,
    installId: installId.toLowerCase(),
    ts,
    appVersion,
    platform,
    osRelease,
    properties,
    propertiesJson,
  };
}

function isAllowedPropertyValue(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STRING_LEN;
  if (Array.isArray(value)) {
    return value.length <= MAX_ARRAY_LEN
      && value.every((item) => typeof item === 'string' && item.length <= MAX_STRING_LEN);
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringProp(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === 'string' ? value : null;
}

function intProp(properties: Record<string, unknown>, key: string): number | null {
  const value = properties[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

async function dedupKey(propertiesJson: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(propertiesJson));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
