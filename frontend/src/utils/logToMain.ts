// Forward a renderer-side error to the Electron main process so it lands in
// nodebrain-log.txt. Local logging only — no network, no telemetry.
//
// Degrades cleanly when electronAPI is absent (e.g. running the frontend under
// plain `vite` in a browser during dev): it just logs to the console instead.
export function logToMain(kind: string, message: string, stack?: string, source?: string): void {
  const api = (window as { electronAPI?: { logRendererError?: (p: unknown) => Promise<unknown> } }).electronAPI;
  if (api?.logRendererError) {
    api.logRendererError({ kind, message, stack, source }).catch(() => { /* logging must never throw */ });
  } else {
    console.warn(`[${kind}] ${message}${source ? ` @ ${source}` : ''}${stack ? `\n${stack}` : ''}`);
  }
}
