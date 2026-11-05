import { useEffect, useRef, useState } from 'react';
import { Circle, Plus, X } from 'lucide-react';
import type { RecordingStatus } from '@shared/types';
import { api } from '../../utils/api';
import { checkStartAddress, hostIsOnSite } from './startAddress';

// Starting a recording from the app: the Record button and the one-question
// dialog. An open recording shows as a row in the Workflows list. The
// recording itself (the pill, Done, the review screen) is the recorder's.

// States in which a recording is still open in the browser.
export const OPEN_STATES = new Set(['recording', 'browser_closed', 'finishing']);

export function RecordButton({ onClick, big = false }: { onClick: () => void; big?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={big
        ? 'flex items-center gap-2 px-5 py-2.5 text-sm bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors'
        : 'flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors'}
    >
      <Plus size={big ? 15 : 13} /> Record
    </button>
  );
}

// Turns a failed start into something a person can act on.
function startProblem(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  if (msg === 'backend unreachable') return "Couldn't reach NodeBrain. Wait a moment and try again.";
  // The recorder's own messages are already plain (no browser found, a
  // workflow running on that site, a bad address). Its catch-all isn't.
  if (!msg || msg === "The recording couldn't start." || msg === 'Request failed') {
    return "NodeBrain couldn't open your browser. If a browser window from an earlier recording is still open, close it and try again.";
  }
  return msg;
}

export function StartRecordingDialog({ open, initialAddress = '', onClose, onStarted }: {
  open: boolean;
  initialAddress?: string; // the current site's address, or empty for a new site
  onClose: () => void;
  // A recording already open for that site is carried on with, not a new one.
  onStarted: (status: RecordingStatus) => void;
}) {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setAddress(initialAddress);
      setError(null);
      setStarting(false);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open, initialAddress]);

  if (!open) return null;

  async function openFor(host: string): Promise<RecordingStatus | undefined> {
    const all = await api.getRecordings().catch(() => [] as RecordingStatus[]);
    return all.find((r) => OPEN_STATES.has(r.state) && hostIsOnSite(host, r.siteKey));
  }

  async function start() {
    if (starting) return;
    const checked = checkStartAddress(address);
    if (!checked.ok) {
      setError(checked.message);
      input.current?.focus();
      return;
    }
    setStarting(true);
    setError(null);
    // Already recording on this site: carry on with that one.
    const existing = await openFor(checked.host);
    if (existing) {
      onStarted(existing);
      setAddress('');
      return;
    }
    try {
      const status = await api.startRecording(checked.url);
      onStarted(status);
      setAddress('');
    } catch (err) {
      // Opened from somewhere else a moment ago.
      const raced = await openFor(checked.host);
      if (raced) {
        onStarted(raced);
        setAddress('');
        return;
      }
      setError(startProblem(err));
      setStarting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !starting && onClose()} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-recording-title"
        className="relative w-full max-w-md mx-4 bg-brain-surface border border-brain-border rounded-xl shadow-2xl animate-slide-up"
      >
        <div className="flex items-center gap-3 px-5 py-4 border-b border-brain-border">
          <div className="w-8 h-8 rounded-lg bg-brain-error/10 border border-brain-error/30 flex items-center justify-center flex-shrink-0">
            <Circle size={13} className="text-brain-error fill-brain-error" />
          </div>
          <p id="start-recording-title" className="text-sm font-semibold text-brain-text flex-1">Record a workflow</p>
          <button type="button" onClick={onClose} disabled={starting} aria-label="Close"
            className="text-brain-text-dim hover:text-brain-text disabled:opacity-40 transition-colors">
            <X size={15} />
          </button>
        </div>

        <form className="px-5 py-4" onSubmit={(e) => { e.preventDefault(); void start(); }}>
          <label htmlFor="start-recording-address" className="block text-xs font-medium text-brain-text-dim mb-1.5">
            Web address to start at
          </label>
          <input
            id="start-recording-address"
            ref={input}
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(null); }}
            placeholder="For example: carrier-portal.com"
            autoComplete="url"
            spellCheck={false}
            disabled={starting}
            className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-muted focus:outline-none focus:border-brain-accent disabled:opacity-60 transition-colors"
          />
          <p className="text-xs text-brain-text-dim mt-2">NodeBrain will open your browser. Do the task once, then press Done.</p>
          {error && <p role="alert" className="text-xs text-brain-error mt-2">{error}</p>}

          <div className="flex justify-end mt-4">
            <button
              type="submit"
              disabled={starting}
              className="px-4 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
            >
              {starting ? 'Opening your browser…' : 'Start'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
