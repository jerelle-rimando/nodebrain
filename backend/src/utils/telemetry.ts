// Forwards telemetry events to the loopback listener in the Electron main
// process, which re-runs the consent check, scrubs the payload, and is the
// sole writer of telemetry-queue.jsonl. This module never touches disk and
// never throws — a telemetry failure must never affect agent execution.
//
// Port discovery: main starts its loopback listener before spawning this
// process and passes the resolved port as NODEBRAIN_TELEMETRY_PORT in the
// child's env (main.ts already sets PORT/VAULT_SECRET/etc. the same way).
// Read once at import time since the port never changes for the process
// lifetime — main is always up before the backend is spawned.
const TELEMETRY_PORT = process.env.NODEBRAIN_TELEMETRY_PORT
  ? Number(process.env.NODEBRAIN_TELEMETRY_PORT)
  : null;

// Fire-and-forget: call sites never await this and it never rejects/throws.
export function telemetry(event: string, properties: Record<string, unknown> = {}): void {
  if (!TELEMETRY_PORT || !Number.isFinite(TELEMETRY_PORT)) return;
  try {
    fetch(`http://127.0.0.1:${TELEMETRY_PORT}/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, properties }),
    }).catch(() => { /* dropped — never affects the caller */ });
  } catch {
    // Synchronous failure (e.g. fetch unavailable) — still must never throw.
  }
}
