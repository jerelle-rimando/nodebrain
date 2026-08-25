import { useCallback, useEffect, useRef, useState } from 'react';
import { clearBuffer, drainAll, drainChars, pendingLength } from '../utils/tokenStreamBuffer';

// Baseline pace tuned to read like a fast typist rather than a token firehose.
// Ramps up toward MAX when the pending buffer grows (a burst from a fast
// provider like Groq, or a slow rAF frame) so the display doesn't permanently
// fall behind the model, and drops back to baseline once it has caught up so
// it doesn't stall waiting for text it's already shown.
const BASE_CHARS_PER_SEC = 45;
const MAX_CHARS_PER_SEC = 400;
const CATCHUP_START_CHARS = 40;
const CATCHUP_FULL_CHARS = 300;
// Clamp huge frame gaps (tab backgrounded, GC pause) so a single frame never
// dumps a large chunk of the buffer at once.
const MAX_FRAME_DT_SEC = 0.25;

function drainRateFor(pendingChars: number): number {
  if (pendingChars <= CATCHUP_START_CHARS) return BASE_CHARS_PER_SEC;
  const t = Math.min(1, (pendingChars - CATCHUP_START_CHARS) / (CATCHUP_FULL_CHARS - CATCHUP_START_CHARS));
  return BASE_CHARS_PER_SEC + t * (MAX_CHARS_PER_SEC - BASE_CHARS_PER_SEC);
}

// Smooths token arrival into a steady, readable stream of characters.
// Tokens land in a shared buffer (see tokenStreamBuffer.ts, fed by
// useLiveSync); this hook drains that buffer on requestAnimationFrame at an
// adaptive rate rather than showing text exactly as unevenly as it arrives.
export function useSmoothedStream(requestId: string | null) {
  const [displayedText, setDisplayedText] = useState('');
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const carryRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);

  const stopLoop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastTsRef.current = null;
    carryRef.current = 0;
  }, []);

  useEffect(() => {
    activeIdRef.current = requestId;
    setDisplayedText('');
    stopLoop();

    if (!requestId) return;

    const tick = (ts: number) => {
      const id = activeIdRef.current;
      if (!id) return;

      const last = lastTsRef.current ?? ts;
      const dt = Math.min((ts - last) / 1000, MAX_FRAME_DT_SEC);
      lastTsRef.current = ts;

      const pending = pendingLength(id);
      if (pending > 0) {
        // Fractional accumulator so a sub-1-char/frame rate still averages
        // out correctly instead of rounding down to zero every frame.
        carryRef.current += drainRateFor(pending) * dt;
        const charsToDrain = Math.floor(carryRef.current);
        if (charsToDrain > 0) {
          carryRef.current -= charsToDrain;
          const chunk = drainChars(id, charsToDrain);
          if (chunk) setDisplayedText((prev) => prev + chunk);
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopLoop();
      clearBuffer(requestId);
    };
  }, [requestId, stopLoop]);

  // Drain whatever's left immediately and stop the loop. Call this once the
  // POST response resolves with the final message so the last few characters
  // don't keep trickling in after the real, complete message is already known.
  const flush = useCallback(() => {
    const id = activeIdRef.current;
    stopLoop();
    if (!id) return;
    const rest = drainAll(id);
    if (rest) setDisplayedText((prev) => prev + rest);
  }, [stopLoop]);

  return { displayedText, flush };
}
