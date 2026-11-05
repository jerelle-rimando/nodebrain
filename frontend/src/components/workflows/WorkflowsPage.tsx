import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import type { RecordingStatus, SiteSummary, WorkflowRow, WorkflowsOverview } from '@shared/types';
import { deriveAgentEmoji } from '@shared/emoji';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { EmojiPicker } from '../dashboard/EmojiPicker';
import { RunFormScreen } from './RunFormScreen';
import { RunView } from './RunView';
import { OPEN_STATES, RecordButton, StartRecordingDialog } from './RecordControls';

// Saved workflows: the list (scoped to one site), the run form, and the run
// view, in one tab.
type Screen =
  | { name: 'list' }
  | { name: 'form'; workflowId: string }
  | { name: 'run'; workflowId: string; runId: string };

export function WorkflowsPage() {
  const [screen, setScreen] = useState<Screen>({ name: 'list' });

  if (screen.name === 'form') {
    return (
      <RunFormScreen
        key={screen.workflowId}
        workflowId={screen.workflowId}
        onBack={() => setScreen({ name: 'list' })}
        onStarted={(runId) => setScreen({ name: 'run', workflowId: screen.workflowId, runId })}
      />
    );
  }
  if (screen.name === 'run') {
    return (
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
    <WorkflowList
      onRun={(workflowId) => setScreen({ name: 'form', workflowId })}
      onOpenRun={(workflowId, runId) => setScreen({ name: 'run', workflowId, runId })}
    />
  );
}

const SITE_KEY = 'nb_workflows_site';

// A site in the picker, including one that only has a recording going so far.
interface PickerSite extends SiteSummary { recordingOnly?: boolean }

function WorkflowList({ onRun, onOpenRun }: {
  onRun: (workflowId: string) => void;
  onOpenRun: (workflowId: string, runId: string) => void;
}) {
  const [overview, setOverview] = useState<WorkflowsOverview | null>(null);
  const [recordings, setRecordings] = useState<RecordingStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(SITE_KEY));
  const [dialog, setDialog] = useState<{ address: string } | null>(null);
  const pauses = useStore((s) => s.pendingTakeControls);
  const openPause = useStore((s) => s.setTakeControlOpenFor);

  const choose = useCallback((siteKey: string) => {
    setChosen(siteKey);
    localStorage.setItem(SITE_KEY, siteKey);
  }, []);

  // Rows carry live state (running, paused, stopped), so the list follows it.
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

  if (!overview) {
    return (
      <div className="h-full flex items-center justify-center">
        {error ? <p role="alert" className="text-sm text-brain-error">{error}</p> : <Loader2 size={16} className="animate-spin text-brain-text-dim" />}
      </div>
    );
  }

  // Sites in the picker: those with saved workflows, plus a new site that
  // only has a recording open so far.
  const sites: PickerSite[] = [...overview.sites];
  for (const rec of recordings) {
    if (!sites.some((s) => s.siteKey === rec.siteKey)) {
      sites.push({
        id: `recording:${rec.id}`, siteKey: rec.siteKey, name: rec.siteName, icon: deriveAgentEmoji(rec.siteName),
        startUrl: rec.startUrl, workflowCount: 0, attention: 'Recording now', recordingOnly: true,
      });
    }
  }

  const dialogEl = (
    <StartRecordingDialog
      open={dialog !== null}
      initialAddress={dialog?.address}
      onClose={() => setDialog(null)}
      onStarted={(status) => {
        setDialog(null);
        choose(status.siteKey);
        setRecordings((rs) => (rs.some((r) => r.id === status.id) ? rs : [...rs, status]));
      }}
    />
  );

  // Nothing recorded anywhere yet: recording is the only thing to do.
  if (sites.length === 0) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-10">
          <div className="rounded-xl border border-dashed border-brain-border bg-brain-surface px-8 py-12 text-center">
            <div className="w-12 h-12 mx-auto rounded-xl bg-brain-accent/10 border border-brain-accent/30 flex items-center justify-center">
              <WorkflowIcon size={22} className="text-brain-accent" />
            </div>
            <h1 className="text-base font-semibold text-brain-text mt-4">Record your first workflow</h1>
            <p className="text-sm text-brain-text-dim mt-2 max-w-sm mx-auto leading-relaxed">
              Show NodeBrain a task you do on a website, like getting a quote. Do it once in your browser,
              and NodeBrain can repeat it for you with new details.
            </p>
            <div className="flex justify-center mt-6">
              <RecordButton onClick={() => setDialog({ address: '' })} big />
            </div>
          </div>
        </div>
        {dialogEl}
      </div>
    );
  }

  // The chosen site; else the one that needs attention, else the most recent.
  const current = sites.find((s) => s.siteKey === chosen)
    ?? sites.find((s) => s.attention)
    ?? [...sites].sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))[0];
  const rows = overview.workflows.filter((w) => w.siteAgentId === current.id);
  const recording = recordings.find((r) => r.siteKey === current.siteKey);
  const others = sites.filter((s) => s.siteKey !== current.siteKey);
  const othersNeedingYou = others.filter((s) => s.attention);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-3 mb-5">
          <SitePicker
            sites={sites}
            current={current}
            onChoose={choose}
            onRecordNew={() => setDialog({ address: '' })}
          />
          <div className="ml-auto">
            <RecordButton onClick={() => setDialog({ address: current.startUrl })} />
          </div>
        </div>

        {error && <p role="alert" className="text-xs text-brain-error mb-3">{error}</p>}
        <ul className="space-y-2">
          {recording && <RecordingRow status={recording} />}
          {rows.map((w) => (
            <Row key={w.id} row={w} onAction={() => {
              // Continue answers the pause in place: the dialog, then the browser.
              const pause = w.state === 'paused' ? pauses.find((p) => p.runId === w.runId) : undefined;
              if (pause) openPause(pause.requestId);
              else if (w.state === 'idle' || !w.runId) onRun(w.id);
              else onOpenRun(w.id, w.runId);
            }} onIconChanged={load} />
          ))}
        </ul>
        {rows.length === 0 && !recording && (
          <p className="text-sm text-brain-text-dim">No workflows on this site yet. Press Record to show NodeBrain one.</p>
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
                    <button type="button" onClick={() => choose(s.siteKey)}
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
      {dialogEl}
    </div>
  );
}

// ── The site picker ─────────────────────────────────────────────────────────

function SitePicker({ sites, current, onChoose, onRecordNew }: {
  sites: PickerSite[];
  current: PickerSite;
  onChoose: (siteKey: string) => void;
  onRecordNew: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}
        className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 -ml-2 hover:bg-brain-surface transition-colors min-w-0">
        <SiteIcon icon={current.icon} />
        <span className="min-w-0 text-left">
          <span className="block text-base font-semibold text-brain-text truncate">{current.name}</span>
          <span className="block text-xs text-brain-text-dim truncate">{current.siteKey}</span>
        </span>
        <ChevronDown size={15} className="text-brain-text-dim flex-shrink-0" />
      </button>

      {open && (
        <div role="listbox" aria-label="Sites"
          className="absolute z-40 left-0 mt-1 w-80 rounded-xl border border-brain-border bg-brain-surface shadow-2xl py-1.5">
          {sites.map((s) => {
            const isCurrent = s.siteKey === current.siteKey;
            return (
              <button key={s.siteKey} type="button" role="option" aria-selected={isCurrent}
                onClick={() => { onChoose(s.siteKey); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-brain-border/60 transition-colors">
                <SiteIcon icon={s.icon} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-brain-text truncate">{s.name}</span>
                  <span className={`block text-xs truncate ${s.attention ? 'text-brain-warning' : 'text-brain-text-dim'}`}>
                    {s.attention ?? s.siteKey}
                  </span>
                </span>
                {isCurrent && <Check size={15} className="text-brain-accent flex-shrink-0" />}
              </button>
            );
          })}
          <div className="border-t border-brain-border mt-1.5 pt-1.5">
            <button type="button" onClick={() => { setOpen(false); onRecordNew(); }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-brain-text-dim hover:text-brain-text hover:bg-brain-border/60 transition-colors">
              <span className="w-8 h-8 rounded-lg border border-dashed border-brain-border flex items-center justify-center flex-shrink-0">
                <Plus size={14} />
              </span>
              Record on a new site
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SiteIcon({ icon }: { icon: string }) {
  return (
    <span className="w-8 h-8 rounded-lg bg-brain-bg border border-brain-border flex items-center justify-center text-base flex-shrink-0" aria-hidden="true">
      {icon}
    </span>
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
