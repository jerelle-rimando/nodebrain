import { create } from 'zustand';
import { api } from './api';

// Whether the person uses AI, and the in-app download of the local AI.
//
// aiMode is what they chose in the first-run wizard ('assistant' or 'none').
// null means no choice is stored: an install set up before the choice existed
// (treated as an AI user, which is how it was set up), or the app running
// outside Electron. It decides only how things start out (the site chat open
// or folded away); whether AI actually works is `configured` in useAiStatus.

export type AiMode = 'assistant' | 'none';

// available: NodeBrain's own local AI is set up. ownModel: it isn't, but the
// person runs Ollama themselves and it has this model.
interface LocalStatus { available: boolean; provider: string; model: string; ownModel?: string }

type DownloadStep = 'engine' | 'model';
export interface AiDownload {
  state: 'idle' | 'running' | 'failed' | 'done';
  step: DownloadStep;
  received: number;
  total: number;
  error: string | null;
}

interface AiSetupState {
  aiMode: AiMode | null;
  // undefined until first asked; null when the backend couldn't be asked.
  local: LocalStatus | null | undefined;
  download: AiDownload;
  setAiMode: (mode: AiMode | null) => void;
  refreshLocal: () => Promise<void>;
  startDownload: () => void;
}

const electronAPI = () => (window as unknown as { electronAPI?: Record<string, any> }).electronAPI;

const IDLE: AiDownload = { state: 'idle', step: 'engine', received: 0, total: 0, error: null };
let listening = false;

export const useAiSetup = create<AiSetupState>((set, get) => ({
  aiMode: null,
  local: undefined,
  download: IDLE,

  setAiMode: (aiMode) => set({ aiMode }),

  refreshLocal: async () => {
    try {
      const s = await api.getLocalEngineStatus();
      set({ local: { available: s.available, provider: s.provider, model: s.model, ownModel: s.ownModel } });
    } catch {
      set({ local: null });
    }
  },

  // The same download the wizard runs, driven by the main process. Its
  // progress arrives as calls named after the wizard's functions; they're
  // mapped onto `download` here. One listener for the app's lifetime, so
  // leaving the Dashboard mid-download doesn't lose track of it.
  startDownload: () => {
    const e = electronAPI();
    if (get().download.state === 'running') return;
    if (!e?.startLocalSetup) {
      set({ download: { ...IDLE, state: 'failed', error: 'Downloading works in the NodeBrain app.' } });
      return;
    }
    if (!listening && e.onLocalSetupEvent) {
      listening = true;
      e.onLocalSetupEvent(({ fn, args }: { fn: string; args?: unknown[] }) => onSetupEvent(fn, args ?? []));
    }
    set({ download: { ...IDLE, state: 'running' } });
    e.startLocalSetup().catch(() => {
      set({ download: { ...get().download, state: 'failed', error: "Couldn't start the download. Try again." } });
    });
  },
}));

function onSetupEvent(fn: string, args: unknown[]) {
  const { download } = useAiSetup.getState();
  const set = (d: Partial<AiDownload>) => useAiSetup.setState({ download: { ...useAiSetup.getState().download, ...d } });
  if (fn === 'setStepProgress') {
    const [step, received, total] = args as [DownloadStep, number, number];
    set({ state: 'running', step, received: received || 0, total: total || 0, error: null });
  } else if (fn === 'setStepComplete') {
    const [step] = args as [DownloadStep];
    if (step === 'engine') set({ step: 'model', received: 0, total: 0 });
  } else if (fn === 'setSetupFailed') {
    const [step, message] = args as [DownloadStep, string];
    set({ state: 'failed', step, error: message || "The download didn't finish. Try again." });
  } else if (fn === 'setSetupComplete') {
    if (download.state === 'done') return;
    set({ state: 'done', error: null });
    useAiSetup.setState({ aiMode: 'assistant' });
    electronAPI()?.setAiMode?.('assistant')?.catch?.(() => {});
    // The backend caches its answer for 10 s, so ask again once that's passed.
    const refresh = useAiSetup.getState().refreshLocal;
    void refresh().then(() => {
      if (!useAiSetup.getState().local?.available) setTimeout(() => void refresh(), 11_000);
    });
  }
}

// The run screens' way back: "Back to chat" only for someone who uses AI.
export function useBackLabel(): string {
  return useAiSetup((s) => s.aiMode) === 'none' ? 'Back' : 'Back to chat';
}

// Reads the stored choice once at startup.
export async function loadAiMode(): Promise<void> {
  const e = electronAPI();
  if (!e?.getAiMode) return;
  try {
    const mode = await e.getAiMode();
    useAiSetup.setState({ aiMode: mode === 'assistant' || mode === 'none' ? mode : null });
  } catch {
    /* keep null: behaves as before the choice existed */
  }
}
