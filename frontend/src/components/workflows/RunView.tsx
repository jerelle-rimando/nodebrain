import { useEffect, useState } from 'react';
import {
  AppWindow, ArrowLeft, CheckCircle2, Circle, Hand, Loader2, MessageSquare, MinusCircle, MousePointerClick, PauseCircle,
  RotateCcw, Square, Wrench, XCircle,
} from 'lucide-react';
import type { RunForm, WorkflowRun, WorkflowRunRepair, WorkflowRunStep } from '@shared/types';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { STATUS_TONE, STATUS_WORDS } from './runFormUtils';

// One run, as it happens: the same phases as the run form, each step ticked
// off as the browser does it, the current one marked, the rest dimmed ahead.
// While it's going: a banner when it's waiting for the person (with Done),
// and controls at the bottom to bring the browser forward or stop the run.
//
// A run that stopped because a step's element couldn't be found shows the
// Fix panel at the top: what it got as far as, what it couldn't find, and
// two ways out — point at the element in the browser, or ask in the chat.
export function RunView({ workflowId, runId, onBack, onRunAgain }: {
  workflowId: string;
  runId: string;
  onBack: () => void;
  onRunAgain: () => void;
}) {
  const [form, setForm] = useState<RunForm | null>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [steps, setSteps] = useState<WorkflowRunStep[]>([]);
  const [active, setActive] = useState(true);
  const [repair, setRepair] = useState<WorkflowRunRepair | undefined>();
  const [stopping, setStopping] = useState(false);
  // Bumped to start polling again after an action on a finished run.
  const [pollKey, setPollKey] = useState(0);
  const pause = useStore((s) => s.pendingTakeControls.find((r) => r.runId === runId));
  const removePause = useStore((s) => s.removePendingTakeControl);
  const waiting = !!pause;
  const [answering, setAnswering] = useState(false);
  const [raiseProblem, setRaiseProblem] = useState<string | null>(null);

  useEffect(() => {
    api.getRunForm(workflowId).then(setForm).catch(() => {});
  }, [workflowId, run?.status]); // a repair changes the steps' wording

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const d = await api.getWorkflowRun(runId);
        if (stop) return;
        setRun(d.run);
        setSteps(d.steps);
        setActive(d.active);
        setRepair(d.repair);
        const repairing = !!d.repair?.phase && d.repair.phase !== 'failed';
        if (!d.active && !repairing) return;
      } catch {
        // Keep trying: the backend may be restarting.
      }
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [runId, pollKey]);

  async function stopRun() {
    setStopping(true);
    await api.cancelWorkflowRun(runId).catch(() => {});
  }

  // Done on the banner: the person finished the step in the browser.
  async function donePause() {
    if (!pause) return;
    setAnswering(true);
    await api.respondToTakeControl(pause.requestId, true).catch(() => {});
    removePause(pause.requestId);
    setAnswering(false);
  }

  async function showBrowser() {
    setRaiseProblem(null);
    try {
      await api.raiseRunBrowser(runId);
    } catch (e) {
      setRaiseProblem(e instanceof Error ? e.message : "Couldn't bring the browser forward.");
    }
  }

  const status = run?.status ?? 'pending';
  // Stopped at a step, window still open, waiting for a fix.
  const held = status === 'needs_attention' && !!repair?.live;
  const running = active && !held;
  const finished = !active && run !== null;

  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const allKeys = form?.phases.flatMap((p) => p.steps.map((s) => s.stepKey)) ?? [];
  const currentKey = running ? allKeys.find((k) => !byKey.has(k) || byKey.get(k)?.status === 'failed') : undefined;

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-4 pb-3 border-b border-brain-border bg-brain-surface flex-shrink-0">
        <button type="button" onClick={onBack}
          className="flex items-center gap-1 text-xs text-brain-text-dim hover:text-brain-text transition-colors">
          <ArrowLeft size={13} /> All workflows
        </button>
        <div className="flex items-center gap-3 mt-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-brain-text truncate">{form?.workflow.name ?? 'Workflow run'}</h1>
            <p className={`text-xs mt-0.5 flex items-center gap-1.5 ${STATUS_TONE[status]}`}>
              {running && !waiting && <Loader2 size={12} className="animate-spin" />}
              {waiting ? 'Waiting for you' : held ? 'Stopped — the browser is waiting for you' : STATUS_WORDS[status]}
            </p>
          </div>
          {finished && (
            <button type="button" onClick={onRunAgain}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-colors ${
                repair && !repair.fixed
                  ? 'border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-border-bright'
                  : 'bg-brain-accent hover:bg-brain-accent-dim text-white'
              }`}>
              <RotateCcw size={12} /> Run again
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-2xl">
          {waiting && (
            <div role="status" className="flex items-center gap-3 rounded-lg border border-brain-warning/30 bg-brain-warning/10 px-4 py-3 mb-4">
              <Hand size={16} className="text-brain-warning flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-brain-text">Your turn: {pause.reason}</p>
                <p className="text-xs text-brain-text-dim mt-0.5">Do it in the browser window, then press Done and NodeBrain carries on.</p>
              </div>
              <button type="button" onClick={donePause} disabled={answering}
                className="px-4 py-1.5 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-50 text-white rounded-lg transition-colors flex-shrink-0">
                {answering ? 'Carrying on…' : 'Done'}
              </button>
            </div>
          )}
          {repair && status === 'needs_attention' ? (
            <FixPanel runId={runId} repair={repair} onChanged={() => setPollKey((k) => k + 1)} onRunAgain={onRunAgain} />
          ) : finished && run?.error && (
            <div role="alert" className={`rounded-lg border px-3 py-2.5 mb-4 text-sm ${
              status === 'needs_attention' ? 'border-brain-warning/30 bg-brain-warning/10' : 'border-brain-border bg-brain-surface'
            } text-brain-text`}>
              {run.error}
            </div>
          )}
          {finished && status === 'completed' && (
            <p className="text-sm text-brain-success mb-4">
              Every step went through.{steps.some((s) => s.status === 'repaired') ? ' The step you fixed is saved, so the next run will use it too.' : ''}
            </p>
          )}

          <ol className="space-y-3">
            {form?.phases.map((p, i) => (
              <li key={i}>
                <p className="text-xs font-medium text-brain-text-dim mb-1">
                  {p.title}{p.note ? <span className="text-brain-text-muted font-normal"> · {p.note}</span> : null}
                </p>
                <ol className="space-y-1">
                  {p.steps.map((s) => {
                    const r = byKey.get(s.stepKey);
                    const text = s.segments.map((g) => ('field' in g
                      ? (form.fields.find((f) => f.key === g.field)?.secret ? '••••••' : run?.inputs[g.field] ?? form.fields.find((f) => f.key === g.field)?.label ?? '')
                      : g.text)).join('');
                    return (
                      <li key={s.stepKey} className="flex gap-2 text-xs leading-relaxed">
                        <span className="mt-0.5 flex-shrink-0"><StepIcon row={r} current={s.stepKey === currentKey} waiting={waiting && s.stepKey === currentKey} pause={!!s.pause} /></span>
                        <span className="min-w-0">
                          <span className={r || s.stepKey === currentKey ? 'text-brain-text' : 'text-brain-text-muted'}>{text}</span>
                          {r?.error && <span className={`block ${r.status === 'failed' ? 'text-brain-warning' : 'text-brain-text-muted'}`}>{r.error}</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {running && (
        <div className="px-6 py-3 border-t border-brain-border bg-brain-surface flex-shrink-0 flex items-center gap-2">
          <button type="button" onClick={showBrowser}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-border text-brain-text hover:border-brain-border-bright rounded-lg transition-colors">
            <AppWindow size={13} /> Show the browser
          </button>
          {raiseProblem && <p role="alert" className="text-xs text-brain-text-dim">{raiseProblem}</p>}
          <button type="button" onClick={stopRun} disabled={stopping}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors">
            <Square size={12} /> {stopping ? 'Stopping…' : 'Stop the run'}
          </button>
        </div>
      )}
    </div>
  );
}

// The run stopped because something on the page couldn't be found.
function FixPanel({ runId, repair, onChanged, onRunAgain }: {
  runId: string;
  repair: WorkflowRunRepair;
  onChanged: () => void;
  onRunAgain: () => void;
}) {
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setChatDraft = useStore((s) => s.setChatDraft);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [showPicture, setShowPicture] = useState(false);
  const busy = !!repair.phase && repair.phase !== 'failed';

  async function showMe() {
    setError(null);
    setStarting(true);
    try {
      await api.startRepair(runId);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start.");
    } finally {
      setStarting(false);
    }
  }

  // The question goes into the site chat's composer beside this view, for
  // the person to read and send. That chat knows the site's workflows and
  // recent runs, but can't see the browser.
  function askAgent() {
    setChatDraft(repair.askText);
    setActiveTab('dashboard');
  }

  async function cancel() {
    await api.cancelRepair(runId).catch(() => {});
    onChanged();
  }

  async function fixLater() {
    await api.releaseWorkflowRun(runId).catch(() => {});
    onChanged();
  }

  return (
    <section aria-label="Fix this workflow" className={`rounded-lg border px-4 py-3.5 mb-5 ${
      repair.fixed ? 'border-brain-success/30 bg-brain-success/10' : 'border-brain-warning/30 bg-brain-warning/10'
    }`}>
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-brain-text">
        {repair.fixed ? <CheckCircle2 size={14} className="text-brain-success" /> : <Wrench size={14} className="text-brain-warning" />}
        {repair.fixed ? 'Fixed' : 'The website seems to have changed'}
      </h2>
      <p className="text-sm text-brain-text mt-1.5 leading-relaxed">{repair.explanation}</p>

      {repair.hasScreenshot && (
        <div className="mt-2">
          <button type="button" onClick={() => setShowPicture((v) => !v)}
            className="text-xs text-brain-text-dim hover:text-brain-text underline underline-offset-2">
            {showPicture ? 'Hide' : 'Show'} the page as it was when it stopped
          </button>
          {showPicture && (
            <img src={api.runScreenshotUrl(runId)} alt="The page when the run stopped"
              className="mt-2 rounded border border-brain-border max-h-80 w-auto" />
          )}
        </div>
      )}

      {busy ? (
        <div className="mt-3 flex items-center gap-3 rounded-md bg-brain-surface border border-brain-border px-3 py-2">
          <Loader2 size={13} className="animate-spin text-brain-accent flex-shrink-0" />
          <p className="text-xs text-brain-text flex-1">
            {repair.phase === 'opening' ? 'Opening the site…'
              : repair.phase === 'saving' ? 'Saving…'
              : repair.phase === 'checking' ? 'Checking what you clicked…'
              : 'Over to you in the browser window: follow the bar at the bottom of the page.'}
          </p>
          {(repair.phase === 'picking' || repair.phase === 'browsing') && (
            <button type="button" onClick={cancel}
              className="text-xs text-brain-text-dim hover:text-brain-text px-2 py-1 rounded transition-colors">
              Cancel
            </button>
          )}
        </div>
      ) : repair.fixed ? (
        <div className="mt-3">
          <button type="button" onClick={onRunAgain}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors">
            <RotateCcw size={12} /> Run again
          </button>
        </div>
      ) : (
        <>
          {repair.whyNot && <p className="text-xs text-brain-text-dim mt-2">{repair.whyNot}</p>}
          {repair.canFix && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={showMe} disabled={starting}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-50 text-white rounded-lg transition-colors">
                <MousePointerClick size={13} /> {starting ? 'Opening…' : 'Show me where it is'}
              </button>
              <button type="button" onClick={askAgent}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-border text-brain-text-dim hover:text-brain-text hover:border-brain-border-bright rounded-lg transition-colors">
                <MessageSquare size={13} /> I don’t know either — ask the agent
              </button>
            </div>
          )}
          {repair.canFix && (
            <p className="text-xs text-brain-text-dim mt-2">
              {repair.live
                ? 'Point at the new one in the browser, and NodeBrain carries on from this step. The earlier steps aren’t done again.'
                : 'Point at the new one, and the next run will use it.'}
            </p>
          )}
          {repair.live && (
            <button type="button" onClick={fixLater}
              className="mt-2 text-xs text-brain-text-dim hover:text-brain-text underline underline-offset-2">
              Close the browser and fix it later
            </button>
          )}
        </>
      )}
      {(error || repair.problem) && <p role="alert" className="text-xs text-brain-error mt-2">{error ?? repair.problem}</p>}
    </section>
  );
}

function StepIcon({ row, current, waiting, pause }: { row?: WorkflowRunStep; current: boolean; waiting: boolean; pause: boolean }) {
  if (row?.status === 'ok' || row?.status === 'repaired') return <CheckCircle2 size={13} className="text-brain-success" />;
  if (waiting) return <Hand size={13} className="text-brain-warning" />;
  if (current) return <Loader2 size={13} className="text-brain-accent animate-spin" />;
  if (row?.status === 'skipped') return <MinusCircle size={13} className="text-brain-text-muted" />;
  if (row?.status === 'failed') return <XCircle size={13} className="text-brain-error" />;
  if (pause) return <PauseCircle size={13} className="text-brain-warning" />;
  return <Circle size={13} className="text-brain-text-muted" />;
}
