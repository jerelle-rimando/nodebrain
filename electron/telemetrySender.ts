// ── Telemetry: transport ──────────────────────────────────────────────────────
// Drains telemetry-queue.jsonl to the Cloudflare Worker in telemetry-worker/.
// main.ts stays the sole *appender* to the queue; this module only ever
// removes lines, and only lines it has either confirmed landed (2xx) or
// decided to drop (malformed, or older than the backlog cap).
//
// Every queue read/rewrite here is synchronous, so it can't interleave with
// main's synchronous appendFileSync / trim / clear — the only window where the
// file changes under us is while a request is awaited, which is why removal
// re-reads the file and deletes the sent lines by content rather than by
// position.
//
// Schedule: first flush FIRST_FLUSH_DELAY_MS after launch, then every
// FLUSH_INTERVAL_MS while the app runs (it lives in the tray, so that's most
// of the time). On failure the next attempt backs off exponentially instead.
// At quit, main calls flushBeforeQuit() for one last capped send, so a short
// first session isn't lost if the user never launches again. Whatever doesn't
// make it within the cap stays on disk for the next launch.
import * as fs from 'fs';
import * as path from 'path';

// Keep in sync with MAX_EVENTS_PER_BATCH in telemetry-worker/src/index.ts.
const TELEMETRY_BATCH_SIZE = 100;
// Backlog cap: someone offline for weeks sends only the newest events; older
// ones are dropped rather than stalling the queue behind a long catch-up.
const TELEMETRY_MAX_EVENTS_PER_FLUSH = 1000;
const FIRST_FLUSH_DELAY_MS = 60 * 1000;
const FLUSH_INTERVAL_MS = 30 * 60 * 1000;
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const AUTH_HEADER = 'x-nodebrain-telemetry-key';
export const TELEMETRY_CONFIG_FILE_NAME = 'telemetry-config.json';

export interface TelemetryTransportConfig {
  endpoint: string;
  key: string;
}

export interface TelemetrySenderOptions {
  queuePath: string;
  isConsentGranted: () => boolean;
  log: (msg: string) => void;
  // Shipped defaults (electron/telemetry-config.json, copied to resources/).
  bundledConfigPath: string;
  // Per-machine override that survives app updates.
  userConfigPath: string;
  // Unpackaged/dev builds send nothing unless explicitly enabled.
  isDevBuild: boolean;
}

interface RawTelemetryConfig {
  endpoint?: unknown;
  key?: unknown;
  enabled?: unknown;
  sendFromDevBuilds?: unknown;
}

// ── Configuration ────────────────────────────────────────────────────────────
// Resolved fresh on every flush, so editing either file (or the env vars,
// on next launch) takes effect without a rebuild. Precedence, highest first:
//   1. env: NODEBRAIN_TELEMETRY_ENDPOINT, NODEBRAIN_TELEMETRY_KEY,
//           NODEBRAIN_TELEMETRY_DEV_SEND=1 (allow sending from a dev build)
//   2. <userData>/telemetry-config.json
//   3. telemetry-config.json shipped with the app
// Any layer may set "enabled": false to turn transport off entirely (events
// still queue locally under the normal consent rules; nothing is sent).
function readConfigFile(filePath: string, log: (msg: string) => void): RawTelemetryConfig {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return {}; // absent is normal (the user override usually doesn't exist)
  }
  try {
    const parsed = JSON.parse(text);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as RawTelemetryConfig : {};
  } catch (err) {
    log(`[TELEMETRY] ignoring unreadable ${path.basename(filePath)}: ${err}`);
    return {};
  }
}

function isAllowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    // Plain http only for a local `wrangler dev` instance.
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
  } catch {
    return false;
  }
}

export function resolveTelemetryTransportConfig(opts: TelemetrySenderOptions): TelemetryTransportConfig | null {
  const bundled = readConfigFile(opts.bundledConfigPath, opts.log);
  const user = readConfigFile(opts.userConfigPath, opts.log);
  const env: RawTelemetryConfig = {
    endpoint: process.env.NODEBRAIN_TELEMETRY_ENDPOINT || undefined,
    key: process.env.NODEBRAIN_TELEMETRY_KEY || undefined,
    sendFromDevBuilds: process.env.NODEBRAIN_TELEMETRY_DEV_SEND === '1' ? true : undefined,
  };
  const merged: RawTelemetryConfig = { ...bundled };
  for (const layer of [user, env]) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }

  if (merged.enabled === false) return null;
  if (opts.isDevBuild && merged.sendFromDevBuilds !== true) return null;
  if (typeof merged.endpoint !== 'string' || !isAllowedEndpoint(merged.endpoint)) return null;
  if (typeof merged.key !== 'string' || !merged.key) return null;
  return { endpoint: merged.endpoint, key: merged.key };
}

// ── Queue access ─────────────────────────────────────────────────────────────
function readQueueLines(queuePath: string): string[] {
  try {
    return fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return []; // no queue file yet (or cleared on consent withdrawal)
  }
}

// Removes each given line once (multiset semantics) from the current queue
// file. Done by content, re-reading first, because main may have appended new
// events or trimmed old ones while a request was in flight. If the file is
// gone — e.g. consent was withdrawn and main cleared it — it stays gone.
function removeQueueLines(queuePath: string, lines: string[], log: (msg: string) => void): void {
  if (lines.length === 0) return;
  let current: string[];
  try {
    current = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  const pending = new Map<string, number>();
  for (const line of lines) pending.set(line, (pending.get(line) ?? 0) + 1);
  const kept: string[] = [];
  for (const line of current) {
    const n = pending.get(line) ?? 0;
    if (n > 0) {
      pending.set(line, n - 1);
    } else {
      kept.push(line);
    }
  }
  try {
    if (kept.length === 0) {
      fs.rmSync(queuePath, { force: true });
    } else {
      fs.writeFileSync(queuePath, kept.join('\n') + '\n');
    }
  } catch (err) {
    // Lines stay queued and get re-sent next flush; the Worker's dedup key
    // absorbs the repeat, so this costs bandwidth, not correctness.
    log(`[TELEMETRY] failed to remove sent events from queue: ${err}`);
  }
}

// Cheap structural check before sending. The Worker validates the same shape
// and rejects the whole batch on a bad line, so a corrupt line (e.g. a write
// torn by a crash) is dropped here instead of poisoning every batch after it.
function isSendableLine(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const e = parsed as Record<string, unknown>;
  return typeof e.installId === 'string'
    && typeof e.event === 'string'
    && typeof e.ts === 'string'
    && typeof e.appVersion === 'string'
    && typeof e.platform === 'string'
    && typeof e.osRelease === 'string'
    && !!e.properties && typeof e.properties === 'object' && !Array.isArray(e.properties);
}

// ── Sending ──────────────────────────────────────────────────────────────────
type SendResult =
  | { kind: 'ok' }
  | { kind: 'rejected'; badIndex: number | null; detail: string } // 400/413: resending unchanged can't succeed
  | { kind: 'retry'; retryAfterMs: number | null; detail: string }; // network, 401/403, 429, 5xx

async function postBatch(
  config: TelemetryTransportConfig,
  lines: string[],
  signal: AbortSignal,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [AUTH_HEADER]: config.key },
      // The queue lines are already the JSON envelopes — send them verbatim.
      body: `[${lines.join(',')}]`,
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
  } catch (err) {
    return { kind: 'retry', retryAfterMs: null, detail: `network: ${err}` };
  }

  if (res.status >= 200 && res.status < 300) {
    res.body?.cancel().catch(() => { /* ignore */ });
    return { kind: 'ok' };
  }

  let body: { error?: unknown; index?: unknown; reason?: unknown } = {};
  try { body = await res.json() as typeof body; } catch { /* non-JSON error body */ }
  const detail = `HTTP ${res.status}${typeof body.error === 'string' ? ` ${body.error}` : ''}${typeof body.reason === 'string' ? ` (${body.reason})` : ''}`;

  if (res.status === 400 || res.status === 413) {
    const badIndex = typeof body.index === 'number' && Number.isInteger(body.index)
      && body.index >= 0 && body.index < lines.length ? body.index : null;
    return { kind: 'rejected', badIndex, detail };
  }

  const retryAfterSec = Number(res.headers.get('retry-after'));
  return {
    kind: 'retry',
    retryAfterMs: Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null,
    detail,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────
export interface TelemetrySender {
  stop(): void;
  // One final send at quit, then stop. Always resolves (never rejects) within
  // timeoutMs: at the deadline any in-flight request is aborted and its events
  // stay queued. Same consent gate as every scheduled flush.
  flushBeforeQuit(timeoutMs: number): Promise<void>;
}

export function startTelemetrySender(opts: TelemetrySenderOptions): TelemetrySender {
  const { queuePath, isConsentGranted, log } = opts;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  // Set by flushBeforeQuit: no more scheduling, but the final flush may still run.
  let closing = false;
  let inFlight: Promise<unknown> | null = null;
  let consecutiveFailures = 0;
  const abort = new AbortController();

  function schedule(delayMs: number): void {
    if (stopped || closing) return;
    timer = setTimeout(() => { void runFlush(); }, delayMs);
    // Never the reason the process stays alive (or delays quitting).
    timer.unref();
  }

  async function runFlush(): Promise<void> {
    timer = null;
    let outcome: { ok: true } | { ok: false; retryAfterMs: number | null };
    const run = flush();
    inFlight = run;
    try {
      outcome = await run;
    } catch (err) {
      log(`[TELEMETRY] flush failed unexpectedly: ${err}`);
      outcome = { ok: false, retryAfterMs: null };
    } finally {
      inFlight = null;
    }
    if (stopped || closing) return;
    if (outcome.ok) {
      consecutiveFailures = 0;
      schedule(FLUSH_INTERVAL_MS);
    } else {
      consecutiveFailures++;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS);
      const jittered = backoff * (0.8 + Math.random() * 0.4);
      schedule(Math.min(Math.max(jittered, outcome.retryAfterMs ?? 0), RETRY_MAX_MS));
    }
  }

  async function flush(): Promise<{ ok: true } | { ok: false; retryAfterMs: number | null }> {
    // Hard consent gate, checked before the queue file is even opened.
    if (!isConsentGranted()) return { ok: true };
    const config = resolveTelemetryTransportConfig(opts);
    if (!config) return { ok: true };

    let lines = readQueueLines(queuePath);
    if (lines.length === 0) return { ok: true };

    if (lines.length > TELEMETRY_MAX_EVENTS_PER_FLUSH) {
      const overflow = lines.slice(0, lines.length - TELEMETRY_MAX_EVENTS_PER_FLUSH);
      removeQueueLines(queuePath, overflow, log);
      lines = lines.slice(overflow.length);
      log(`[TELEMETRY] backlog over ${TELEMETRY_MAX_EVENTS_PER_FLUSH} events — dropped ${overflow.length} oldest`);
    }

    const unsendable = lines.filter((line) => !isSendableLine(line));
    if (unsendable.length > 0) {
      removeQueueLines(queuePath, unsendable, log);
      lines = lines.filter(isSendableLine);
      log(`[TELEMETRY] dropped ${unsendable.length} malformed queue line(s)`);
    }

    let sent = 0;
    let offset = 0;
    while (offset < lines.length) {
      // Re-checked per batch: consent can be withdrawn mid-flush, and main
      // clears the queue file when it is.
      if (stopped || !isConsentGranted()) return { ok: true };

      let batch = lines.slice(offset, offset + TELEMETRY_BATCH_SIZE);
      let result = await postBatch(config, batch, abort.signal);

      // A 400 naming one bad event: drop just that line and resend the rest,
      // so one bad line can't take 99 good ones down with it. Each pass
      // removes a line, so this terminates.
      while (result.kind === 'rejected' && result.badIndex !== null && batch.length > 1) {
        if (stopped || !isConsentGranted()) return { ok: true };
        const badIndex = result.badIndex;
        log(`[TELEMETRY] endpoint rejected one event (${result.detail}) — dropping it`);
        removeQueueLines(queuePath, [batch[badIndex]], log);
        batch = batch.filter((_, i) => i !== badIndex);
        result = await postBatch(config, batch, abort.signal);
      }

      if (result.kind === 'retry') {
        if (closing) {
          log(`[TELEMETRY] quit flush incomplete (${result.detail}) — rest stays queued for next launch; ${sent} sent`);
        } else if (!stopped) {
          log(`[TELEMETRY] send failed (${result.detail}) — will retry; ${sent} sent this flush`);
        }
        return { ok: false, retryAfterMs: result.retryAfterMs };
      }
      if (result.kind === 'rejected') {
        log(`[TELEMETRY] endpoint rejected a batch of ${batch.length} (${result.detail}) — dropping it`);
      } else {
        sent += batch.length;
      }
      if (!isConsentGranted()) return { ok: true }; // withdrawn while in flight: main already cleared the file
      removeQueueLines(queuePath, batch, log);
      offset += TELEMETRY_BATCH_SIZE;
    }

    if (sent > 0) log(`[TELEMETRY] sent ${sent} event(s)`);
    return { ok: true };
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    abort.abort();
  }

  async function flushBeforeQuit(timeoutMs: number): Promise<void> {
    if (stopped || closing) return;
    closing = true;
    if (timer) clearTimeout(timer);
    timer = null;

    const work = (async () => {
      // A scheduled flush already mid-send finishes first (its lines are read
      // and partly sent); the second pass picks up anything queued since.
      // Running both at once would just double-send what the Worker dedups.
      if (inFlight) await inFlight.catch(() => undefined);
      await flush();
    })().catch((err) => log(`[TELEMETRY] quit flush failed: ${err}`));

    // Hard cap on the whole thing, not per request. Aborting ends any pending
    // fetch, so its batch is treated as unsent and left on disk; the race
    // guarantees we resolve on time even if something ignores the abort.
    let deadline: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      deadline = setTimeout(() => {
        log(`[TELEMETRY] quit flush hit ${timeoutMs}ms cap — leaving remaining events queued`);
        abort.abort();
        resolve();
      }, timeoutMs);
    });
    try {
      await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(deadline);
      stop();
    }
  }

  schedule(FIRST_FLUSH_DELAY_MS);

  return { stop, flushBeforeQuit };
}
