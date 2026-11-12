import { useCallback, useEffect, useState } from 'react';
import { Circle, Loader2, Trash2 } from 'lucide-react';
import type { RecordingStatus, WorkflowRow, WorkflowsOverview } from '@shared/types';
import { deriveAgentEmoji } from '@shared/emoji';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { RunFormScreen } from '../workflows/RunFormScreen';
import { RunView } from '../workflows/RunView';
import { OPEN_STATES, RecordButton, StartRecordingDialog } from '../workflows/RecordControls';
import { SiteChatPanel, SiteIcon, type PickerSite } from '../workflows/SiteChatPanel';

// The Dashboard, the app's home: on the left a chat about one site, whose
// header holds the site picker, or in its place a workflow's run form or run
// view; on the right the list of that site's workflows, always.
type Screen =
  | { name: 'list' }
  | { name: 'form'; workflowId: string; error?: string }
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
        id: `recording:${rec.id}`, siteKey: rec.siteKey, name: rec.siteName, icon: deriveAgentEmoji(rec.siteName), favicon: rec.siteIcon,
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
        initialError={screen.error}
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
          onChoose={choose}
          onRecordingStarted={(status) => {
            choose(status.siteKey);
            setRecordings((rs) => (rs.some((r) => r.id === status.id) ? rs : [...rs, status]));
          }}
          onOpenForm={(workflowId) => setScreen({ name: 'form', workflowId })}
          onRun={async (workflowId) => {
            const result = await runNow(workflowId);
            // A run that starts straight away goes on in the background: the
            // chat stays, the row shows it running, and the row opens it.
            if (result.runId) await load();
            else setScreen({ name: 'form', workflowId, error: result.error });
          }}
          onOpenRun={(workflowId, runId) => setScreen({ name: 'run', workflowId, runId })}
          onDeleted={load}
        />
      </div>
    </div>
  );
}

// Run on a row runs: when every required box would be filled from the last
// run, it starts straight away with those values, and a workflow with no
// boxes always does. Otherwise (never run, or a secret box, which is never
// filled for you) the form opens to ask.
async function runNow(workflowId: string): Promise<{ runId?: string; error?: string }> {
  let form;
  try {
    form = await api.getRunForm(workflowId);
  } catch {
    return {};
  }
  if (!form.lastRun && form.fields.length > 0) return {};
  const values: Record<string, string> = {};
  for (const f of form.fields) {
    const v = f.secret ? '' : (f.previousValue ?? '');
    if (f.required && !v.trim()) return {};
    values[f.key] = v;
  }
  try {
    return { runId: (await api.startWorkflowRun(workflowId, values)).id };
  } catch (err) {
    return { error: err instanceof Error && err.message !== 'backend unreachable' ? err.message : undefined };
  }
}

function WorkflowList({ overview, recordings, sites, current, error, onChoose, onRecordingStarted, onRun, onOpenForm, onOpenRun, onDeleted }: {
  overview: WorkflowsOverview | null;
  recordings: RecordingStatus[];
  sites: PickerSite[];
  current: PickerSite | null;
  error: string | null;
  onChoose: (siteKey: string) => void;
  onRecordingStarted: (status: RecordingStatus) => void;
  onRun: (workflowId: string) => Promise<void>;
  onOpenForm: (workflowId: string) => void;
  onOpenRun: (workflowId: string, runId: string) => void;
  onDeleted: () => Promise<void>;
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
            <Row key={w.id} row={w} site={current} onOpen={() => (w.state !== 'idle' && w.runId ? onOpenRun(w.id, w.runId) : onOpenForm(w.id))} onAction={() => {
              if (w.state === 'idle' || !w.runId) return onRun(w.id);
              onOpenRun(w.id, w.runId); // Continue, Open and Fix all go to the run
            }} onDelete={async () => { await api.deleteWorkflow(w.id); await onDeleted(); }} />
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
      <div className="h-[72px] flex items-center gap-3 px-[22px] flex-shrink-0">
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

// The row itself opens its run while one is going (or waiting on you), else
// the run form (to change the details first); its button does the verb.
// Its icon is the site's favicon: every workflow on a site shares it, and the
// name tells them apart.
// Delete asks first, in the row itself, since it removes the recording and
// its run history. Not offered while a run is going or waiting on the person.
function Row({ row, site, onOpen, onAction, onDelete }: {
  row: WorkflowRow; site: PickerSite; onOpen: () => void; onAction: () => void | Promise<void>; onDelete: () => Promise<void>;
}) {
  const [acting, setActing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const needsYou = row.state === 'paused' || row.state === 'stopped';
  const canDelete = row.state === 'idle' || row.state === 'stopped';

  if (confirming) {
    return (
      <li className="flex items-center gap-3 rounded-lg border border-brain-error/40 bg-brain-surface px-4 py-3">
        <SiteIcon icon={site.icon} favicon={site.favicon} />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-brain-text">Delete this workflow?</p>
          <p className={`text-xs truncate ${deleteError ? 'text-brain-error' : 'text-brain-text-dim'}`} role={deleteError ? 'alert' : undefined}>
            {deleteError ?? row.name}
          </p>
        </div>
        <button type="button" disabled={deleting} autoFocus
          onClick={async () => {
            setDeleting(true);
            setDeleteError(null);
            try {
              await onDelete();
            } catch (err) {
              setDeleteError(err instanceof Error && err.message !== 'backend unreachable' ? err.message : "Couldn't delete it. Try again.");
              setDeleting(false);
            }
          }}
          className="px-3 py-1.5 text-xs rounded-lg flex-shrink-0 min-w-[4.5rem] bg-brain-error hover:bg-brain-error/80 text-white disabled:opacity-50">
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
        <ActionButton label="Cancel" strong={false} disabled={deleting} onClick={() => { setConfirming(false); setDeleteError(null); }} />
      </li>
    );
  }

  return (
    <li onClick={onOpen}
      className={`flex items-center gap-3 rounded-lg border bg-brain-surface px-4 py-3 cursor-pointer hover:border-brain-border-bright transition-colors ${needsYou ? 'border-brain-warning/40' : 'border-brain-border'}`}>
      <SiteIcon icon={site.icon} favicon={site.favicon} />
      <div role="button" tabIndex={0} aria-label={`Open ${row.name}`} className="min-w-0 flex-1 focus:outline-none"
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}>
        <p className="flex items-center gap-1.5 text-sm text-brain-text">
          <span className="truncate">{row.name}</span>
          {row.state === 'running' && <Loader2 size={13} className="animate-spin text-brain-accent flex-shrink-0" aria-label="Running" />}
        </p>
        <p className={`text-xs truncate ${TONE[row.state]}`}>{row.stateText}</p>
      </div>
      <span onClick={(e) => e.stopPropagation()} className="flex-shrink-0 flex items-center gap-1.5">
        {canDelete && (
          <button type="button" aria-label={`Delete ${row.name}`} title="Delete" onClick={() => setConfirming(true)}
            className="p-1.5 rounded-lg text-brain-text-muted hover:text-brain-error hover:bg-brain-error/10 transition-colors">
            <Trash2 size={14} />
          </button>
        )}
        <ActionButton label={acting ? 'Starting…' : VERB[row.state]} strong={needsYou} disabled={acting} onClick={async () => {
          setActing(true);
          try { await onAction(); } finally { setActing(false); }
        }} />
      </span>
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
