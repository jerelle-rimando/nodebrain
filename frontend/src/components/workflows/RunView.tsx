import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, Hand, Loader2, MinusCircle, PauseCircle, RotateCcw, Square, XCircle } from 'lucide-react';
import type { RunForm, WorkflowRun, WorkflowRunStep } from '@shared/types';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';
import { STATUS_TONE, STATUS_WORDS } from './runFormUtils';

// One run, as it happens: the same phases as the run form, each step ticked
// off as the browser does it. Pauses are answered in the Take Control dialog.
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
  const [stopping, setStopping] = useState(false);
  const waiting = useStore((s) => s.pendingTakeControls.some((r) => r.runId === runId));

  useEffect(() => {
    api.getRunForm(workflowId).then(setForm).catch(() => {});
  }, [workflowId]);

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
        if (!d.active) return;
      } catch {
        // Keep trying: the backend may be restarting.
      }
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [runId]);

  async function stopRun() {
    setStopping(true);
    await api.cancelWorkflowRun(runId).catch(() => {});
  }

  const byKey = new Map(steps.map((s) => [s.stepKey, s]));
  const allKeys = form?.phases.flatMap((p) => p.steps.map((s) => s.stepKey)) ?? [];
  const currentKey = active ? allKeys.find((k) => !byKey.has(k)) : undefined;
  const status = run?.status ?? 'pending';
  const finished = !active && run !== null;

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
              {active && <Loader2 size={12} className="animate-spin" />}
              {waiting ? 'Waiting for you in the browser' : STATUS_WORDS[status]}
            </p>
          </div>
          {active ? (
            <button type="button" onClick={stopRun} disabled={stopping}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors">
              <Square size={12} /> {stopping ? 'Stopping…' : 'Stop'}
            </button>
          ) : finished && (
            <button type="button" onClick={onRunAgain}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-brain-accent hover:bg-brain-accent-dim text-white rounded-lg transition-colors">
              <RotateCcw size={12} /> Run again
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-2xl">
          {waiting && (
            <div className="flex items-start gap-2 rounded-lg border border-brain-warning/30 bg-brain-warning/10 px-3 py-2.5 mb-4 text-xs text-brain-text">
              <Hand size={13} className="text-brain-warning mt-0.5 flex-shrink-0" />
              The run is paused for you. Do the step in the browser window, then click Done in the dialog.
            </div>
          )}
          {finished && run?.error && (
            <div role="alert" className={`rounded-lg border px-3 py-2.5 mb-4 text-sm ${
              status === 'needs_attention' ? 'border-brain-warning/30 bg-brain-warning/10' : 'border-brain-border bg-brain-surface'
            } text-brain-text`}>
              {run.error}
            </div>
          )}
          {finished && status === 'completed' && (
            <p className="text-sm text-brain-success mb-4">Every step went through.</p>
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
                        <span className="mt-0.5 flex-shrink-0"><StepIcon row={r} current={s.stepKey === currentKey} pause={!!s.pause} /></span>
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
    </div>
  );
}

function StepIcon({ row, current, pause }: { row?: WorkflowRunStep; current: boolean; pause: boolean }) {
  if (row?.status === 'ok' || row?.status === 'repaired') return <CheckCircle2 size={13} className="text-brain-success" />;
  if (row?.status === 'skipped') return <MinusCircle size={13} className="text-brain-text-muted" />;
  if (row?.status === 'failed') return <XCircle size={13} className="text-brain-error" />;
  if (current) return <Loader2 size={13} className="text-brain-accent animate-spin" />;
  if (pause) return <PauseCircle size={13} className="text-brain-warning" />;
  return <Circle size={13} className="text-brain-text-muted" />;
}
