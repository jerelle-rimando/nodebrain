// Bridges the always-on SSE listener (useLiveSync, mounted once at the App
// level) and the Dashboard's rAF drain loop (mounted only while the dashboard
// tab is active). Pushing a token here does NOT touch React/zustand state, so
// token arrival never forces a re-render by itself — only the drain loop does,
// at a controlled rate. Plain module-level Map is deliberate: it needs to
// outlive whatever component happens to be reading from it at a given moment.
const pendingByRequestId = new Map<string, string>();

export function pushToken(requestId: string, token: string): void {
  pendingByRequestId.set(requestId, (pendingByRequestId.get(requestId) ?? '') + token);
}

export function pendingLength(requestId: string): number {
  return pendingByRequestId.get(requestId)?.length ?? 0;
}

export function drainChars(requestId: string, count: number): string {
  const pending = pendingByRequestId.get(requestId);
  if (!pending) return '';
  const chunk = pending.slice(0, count);
  const rest = pending.slice(chunk.length);
  if (rest) {
    pendingByRequestId.set(requestId, rest);
  } else {
    pendingByRequestId.delete(requestId);
  }
  return chunk;
}

export function drainAll(requestId: string): string {
  const pending = pendingByRequestId.get(requestId) ?? '';
  pendingByRequestId.delete(requestId);
  return pending;
}

export function clearBuffer(requestId: string): void {
  pendingByRequestId.delete(requestId);
}
