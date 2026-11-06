import { useCallback, useEffect, useState } from 'react';
import { Circle, Loader2 } from 'lucide-react';
import type { RecordingStatus, WorkflowRow, WorkflowsOverview } from '@shared/types';
import { deriveAgentEmoji } from '@shared/emoji';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { EmojiPicker } from './EmojiPicker';
import { RunFormScreen } from '../workflows/RunFormScreen';
import { RunView } from '../workflows/RunView';
import { OPEN_STATES, RecordButton, StartRecordingDialog } from '../workflows/RecordControls';
import { SiteChatPanel, type PickerSite } from '../workflows/SiteChatPanel';

// The Dashboard, the app's home: on the left a chat about one site, whose
// header holds the site picker, or in its place a workflow's run form or run
// view; on the right the list of that site's workflows, always.
type Screen =
  | { name: 'list' }
  | { name: 'form'; workflowId: string }
  | { name: 'run'; workflowId: string; runId: string };

const SITE_KEY = 'nb_workflows_site';

export function Dashboard() {
  const [screen, setScreen] = useState<Screen>({ name: 'list' });
  const [overview, setOverview] = useState<WorkflowsOverview | null>(null);
  const [recordings, setRecordings] = useState<RecordingStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(SITE_KEY));

  // A stopped run's "ask the agent" puts its question in the chat's composer,
  // so the chat comes back in place of the run view.
  const chatDraft = useStore((s) => s.chatDraft);
  useEffect(() => {
    if (chatDraft) setScreen({ name: 'list' });
  }, [chatDraft]);

  const choose = useCallback((siteKey: string) => {
    setChosen(siteKey);
    localStorage.setItem(SITE_KEY, siteKey);
  }, []);

  // Rows and the picker carry live state (running, paused, stopped), so the
  // page follows it.
  const load = useCallback(async () => {
    const [o, r] = await Promise.all([
      api.getWorkflows().catch(() => null),
      api.getRecordings().catch(() => null),
    ]);
    if (o) { setOverview(o); setError(null); } else setError("Couldn't load your workflows. Trying again…");
    if (r) setRecordings(r.filter((x) => OPEN_STATES.has(x.state)));
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);

  // Sites: those with saved workflows, plus a new site that only has a
  // recording open so far.
  const sites: PickerSite[] = [...(overview?.sites ?? [])];
  for (const rec of recordings) {
    if (!sites.some((s) => s.siteKey === rec.siteKey)) {
      sites.push({
        id: `recording:${rec.id}`, siteKey: rec.siteKey, name: rec.siteName, icon: deriveAgentEmoji(rec.siteName),
        startUrl: rec.startUrl, workflowCount: 0, attention: 'Recording now', recordingOnly: true,
      });
    }
  }
  // The chosen site; else the one that needs attention, else the most recent.
  const current = sites.find((s) => s.siteKey === chosen)
    ?? sites.find((s) => s.attention)
    ?? [...sites].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0]
    ?? null;

  let runScreen = null;
  if (screen.name === 'form') {
    runScreen = (
      <RunFormScreen
        key={screen.workflowId}
        workflowId={screen.workflowId}
        onBack={() => setScreen({ name: 'list' })}
        onStarted={(runId) => setScreen({ name: 'run', workflowId: screen.workflowId, runId })}
      />
    );
  } else if (screen.name === 'run') {
    runScreen = (
      <RunView
        key={screen.runId}
        workflowId={screen.workflowId}
        runId={screen.runId}
        onBack={() => setScreen({ name: 'list' })}
        onRunAgain={() => setScreen({ name: 'form', workflowId: screen.workflowId })}
      />
    );
  }

  return (
    <div className="h-full flex">
      <div className="basis-[55%] min-w-0 border-r border-brain-border">
        {runScreen}
        {/* Stays mounted behind a run so each site's conversation survives it. */}
        <div className={runScreen ? 'hidden' : 'h-full'}>
          <SiteChatPanel sites={sites} current={current} onChoose={choose} />
        </div>
      </div>
      <div className="basis-[45%] min-w-0">
        <WorkflowList
          overview={overview} recordings={recordings} sites={sites} current={current} error={error}
          onChoose={choose} onReload={load}
          onRecordingStarted={(status) => {
            choose(status.siteKey);
            setRecordings((rs) => (rs.some((r) => r.id === status.id) ? rs : [...rs, status]));
          }}
          onRun={(workflowId) => setScreen({ name: 'form', workflowId })}
          onOpenRun={(workflowId, runId) => setScreen({ name: 'run', workflowId, runId })}
        />
      </div>
    </div>
  );
}

function WorkflowList({ overview, recordings, sites, current, error, onChoose, onReload, onRecordingStarted, onRun, onOpenRun }: {
  overview: WorkflowsOverview | null;
  recordings: RecordingStatus[];
  sites: PickerSite[];
  current: PickerSite | null;
  error: string | null;
  onChoose: (siteKey: string) => void;
  onReload: () => void;
  onRecordingStarted: (status: RecordingStatus) => void;
  onRun: (workflowId: string) => void;
  onOpenRun: (workflowId: string, runId: string) => void;
}) {
  const [dialog, setDialog] = useState<{ address: string } | null>(null);

  let body;
  if (!overview) {
    body = (
      <div className="h-full flex items-center justify-center">
        {error ? <p role="alert" className="text-sm text-brain-error">{error}</p> : <Loader2 size={16} className="animate-spin text-brain-text-dim" />}
      </div>
    );
  } else if (!current) {
    // Nothing recorded anywhere yet. Recording is the only thing to do, and
    // the header's Record button does it.
    body = (
      <div className="h-full flex flex-col items-center justify-center text-center px-8">
        <span className="w-10 h-10 rounded-full bg-brain-error/10 border border-brain-error/30 flex items-center justify-center">
          <Circle size={14} className="text-brain-error fill-brain-error" />
        </span>
        <h2 className="text-[15px] text-brain-text mt-3">Record your first workflow</h2>
        <p className="text-[13px] text-brain-text-dim mt-1.5 leading-relaxed max-w-sm">
          Show NodeBrain a task you do on a website. Do it once in your browser, and it can repeat it with new details.
        </p>
      </div>
    );
  } else {
    const rows = overview.workflows.filter((w) => w.siteAgentId === current.id);
    const recording = recordings.find((r) => r.siteKey === current.siteKey);
    const others = sites.filter((s) => s.siteKey !== current.siteKey);
    const othersNeedingYou = others.filter((s) => s.attention);
    body = (
      <div className="h-full overflow-y-auto px-[22px] py-5">
        {error && <p role="alert" className="text-xs text-brain-error mb-3">{error}</p>}
        <ul className="space-y-2">
          {recording && <RecordingRow status={recording} />}
          {rows.map((w) => (
            <Row key={w.id} row={w} onAction={() => {
              if (w.state === 'idle' || !w.runId) onRun(w.id);
              else onOpenRun(w.id, w.runId); // Continue, Open and Fix all go to the run
            }} onIconChanged={onReload} />
          ))}
        </ul>
        {rows.length === 0 && !recording && (
          <p className="text-sm text-brain-text-dim">No workflows on {current.name} yet. Press Record to show NodeBrain one.</p>
        )}

        {others.length > 0 && (
          <p className="text-xs text-brain-text-muted mt-6">
            {others.length === 1 ? '1 other site has workflows' : `${others.length} other sites have workflows`}
            {othersNeedingYou.length > 0 && (
              <>
                {' · '}
                {othersNeedingYou.map((s, i) => (
                  <span key={s.siteKey}>
                    {i > 0 && ', '}
                    <button type="button" onClick={() => onChoose(s.siteKey)}
                      className="text-brain-warning hover:underline underline-offset-2">
                      {s.name}
                    </button>
                  </span>
                ))}
                {othersNeedingYou.length === 1 ? ' needs you' : ' need you'}
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  // Record is the one way to start a recording. It opens on the current
  // site's address; changing the address records on another site.
  return (
    <section aria-label="Your Workflows" className="h-full flex flex-col">
      <div className="flex items-center gap-3 px-[22px] py-4 border-b border-brain-border flex-shrink-0">
        <h1 className="text-[15px] font-medium text-brain-text">Your Workflows</h1>
        <div className="ml-auto">
          <RecordButton onClick={() => setDialog({ address: current?.startUrl ?? '' })} />
        </div>
      </div>
      <div className="flex-1 min-h-0">{body}</div>
      <StartRecordingDialog
        open={dialog !== null}
        initialAddress={dialog?.address}
        onClose={() => setDialog(null)}
        onStarted={(status) => { setDialog(null); onRecordingStarted(status); }}
      />
    </section>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

const VERB: Record<WorkflowRow['state'], string> = { paused: 'Continue', running: 'Open', stopped: 'Fix', idle: 'Run' };
const TONE: Record<WorkflowRow['state'], string> = {
  paused: 'text-brain-warning', running: 'text-brain-accent', stopped: 'text-brain-warning', idle: 'text-brain-text-dim',
};

function Row({ row, onAction, onIconChanged }: { row: WorkflowRow; onAction: () => void; onIconChanged: () => void }) {
  const [picking, setPicking] = useState(false);
  const needsYou = row.state === 'paused' || row.state === 'stopped';

  async function setIcon(emoji: string | null) {
    setPicking(false);
    await api.setWorkflowIcon(row.id, emoji).catch(() => {});
    onIconChanged();
  }

  return (
    <li className={`flex items-center gap-3 rounded-lg border bg-brain-surface px-4 py-3 ${needsYou ? 'border-brain-warning/40' : 'border-brain-border'}`}>
      <div className="relative flex-shrink-0">
        <button type="button" onClick={() => setPicking((v) => !v)} title="Change icon" aria-label={`Change the icon for ${row.name}`}
          className="w-8 h-8 rounded-lg bg-brain-bg border border-brain-border hover:border-brain-border-bright flex items-center justify-center text-base transition-colors">
          {row.icon}
        </button>
        {picking && (
          <div className="absolute left-0 top-full">
            <EmojiPicker onSelect={(e) => void setIcon(e)} onClose={() => setPicking(false)} />
            {row.iconPicked && (
              <button type="button" onMouseDown={(e) => e.stopPropagation()} onClick={() => void setIcon(null)}
                className="absolute z-50 left-0 mt-[15.5rem] w-64 rounded-b-xl border border-t-0 border-brain-border bg-brain-surface px-3 py-1.5 text-xs text-brain-text-dim hover:text-brain-text text-left">
                Use the icon from its name
              </button>
            )}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm text-brain-text">
          <span className="truncate">{row.name}</span>
          {row.state === 'running' && <Loader2 size={13} className="animate-spin text-brain-accent flex-shrink-0" aria-label="Running" />}
        </p>
        <p className={`text-xs truncate ${TONE[row.state]}`}>{row.stateText}</p>
      </div>
      <ActionButton label={VERB[row.state]} strong={needsYou} onClick={onAction} />
    </li>
  );
}

// A recording that's still open: finish it from here or in the browser.
function RecordingRow({ status }: { status: RecordingStatus }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishing = status.state === 'finishing';
  const text = finishing ? 'Finishing the recording…'
    : status.state === 'browser_closed' ? 'The browser window was closed. Press Done to keep what you did.'
    : `Recording now, ${status.stepCount} ${status.stepCount === 1 ? 'step' : 'steps'} so far`;

  async function done() {
    setBusy(true);
    setError(null);
    try {
      await api.finishRecording(status.id); // the review screen opens from here
    } catch {
      setError("Couldn't finish the recording. Press Done in the browser instead.");
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 rounded-lg border border-brain-error/30 bg-brain-surface px-4 py-3">
      <span className="w-8 h-8 rounded-lg bg-brain-error/10 border border-brain-error/30 flex items-center justify-center flex-shrink-0">
        <span className="w-2.5 h-2.5 rounded-full bg-brain-error animate-pulse" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-brain-text truncate">New workflow</p>
        <p className="text-xs text-brain-text-dim truncate">{error ?? text}</p>
      </div>
      {!finishing && <ActionButton label={busy ? 'Finishing…' : 'Done'} strong onClick={done} disabled={busy} />}
    </li>
  );
}

function ActionButton({ label, strong, onClick, disabled }: { label: string; strong: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={`px-3 py-1.5 text-xs rounded-lg transition-colors flex-shrink-0 min-w-[4.5rem] disabled:opacity-50 ${
        strong
          ? 'bg-brain-accent hover:bg-brain-accent-dim text-white'
          : 'border border-brain-border text-brain-text hover:border-brain-border-bright'
      }`}>
      {label}
    </button>
  );
}
