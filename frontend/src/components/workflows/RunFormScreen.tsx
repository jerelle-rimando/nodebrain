import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, ClipboardPaste, Lock, PauseCircle, Play } from 'lucide-react';
import type { PlanPhase, PlanStep, RunForm, RunFormField } from '@shared/types';
import { api } from '../../utils/api';
import { fillFromRow, STATUS_TONE, STATUS_WORDS, timeAgo, type PastedRow } from './runFormUtils';

// The run form: this run's details on the left, what the run will do on the
// right with those details shown where they land. Nothing runs until Run.
export function RunFormScreen({ workflowId, initialError, onBack, onStarted }: {
  workflowId: string;
  initialError?: string; // Run on the list tried to start it and couldn't
  onBack: () => void;
  onStarted: (runId: string) => void;
}) {
  const [form, setForm] = useState<RunForm | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api.getRunForm(workflowId)
      .then(setForm)
      .catch((err) => setLoadError(err instanceof Error && err.message !== 'backend unreachable'
        ? err.message : "Couldn't load this workflow. Try again in a moment."));
  }, [workflowId]);

  if (loadError) {
    return (
      <div className="h-full p-6">
        <BackButton onClick={onBack} />
        <p role="alert" className="text-sm text-brain-error mt-4">{loadError}</p>
      </div>
    );
  }
  if (!form) return null;
  return <Loaded form={form} initialError={initialError} onBack={onBack} onStarted={onStarted} />;
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      className="flex items-center gap-1 text-xs text-brain-text-dim hover:text-brain-text transition-colors">
      <ArrowLeft size={13} /> Back to chat
    </button>
  );
}

function Loaded({ form, initialError, onBack, onStarted }: {
  form: RunForm;
  initialError?: string;
  onBack: () => void;
  onStarted: (runId: string) => void;
}) {
  // Previous run's values; secret boxes always start empty.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(form.fields.map((f) => [f.key, f.secret ? '' : (f.previousValue ?? '')])));
  const [focused, setFocused] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [starting, setStarting] = useState(false);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const setValue = (key: string, v: string) => {
    setValues((s) => ({ ...s, [key]: v }));
    setError(null);
  };

  async function run() {
    if (starting) return;
    const missing = form.fields.find((f) => f.required && !values[f.key]?.trim());
    if (missing) {
      setError(`Fill in "${missing.label}" before running.`);
      inputs.current[missing.key]?.focus();
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const body = Object.fromEntries(form.fields.map((f) => [f.key, values[f.key] ?? '']));
      const started = await api.startWorkflowRun(form.workflow.id, body);
      onStarted(started.id);
    } catch (err) {
      setError(err instanceof Error && err.message !== 'backend unreachable'
        ? err.message : "Couldn't reach NodeBrain to start the run. Try again in a moment.");
      setStarting(false);
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-brain-border bg-brain-surface flex-shrink-0">
        <BackButton onClick={onBack} />
        <h1 className="text-base font-semibold text-brain-text mt-2 truncate">{form.workflow.name}</h1>
        <p className="text-xs text-brain-text-dim mt-0.5">
          {form.workflow.siteName || form.workflow.siteKey}
          {' · '}
          {form.lastRun
            ? <>Last ran {timeAgo(form.lastRun.startedAt)} — <span className={STATUS_TONE[form.lastRun.status]}>{STATUS_WORDS[form.lastRun.status]}</span></>
            : "Hasn't run yet"}
        </p>
      </div>

      <div className="flex-1 grid grid-cols-2 min-h-0">
        {/* Left: this run's details */}
        <section aria-label="This run's details" className="overflow-y-auto border-r border-brain-border px-6 py-5">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-3">This run's details</p>

          {form.fields.length === 0 ? (
            <div className="rounded-lg border border-dashed border-brain-border px-4 py-3 text-sm text-brain-text-dim">
              Nothing to fill in. This workflow does the same thing every time it runs.
            </div>
          ) : (
            <div className="space-y-3">
              {form.fields.map((f) => (
                <FieldRow
                  key={f.key}
                  field={f}
                  value={values[f.key] ?? ''}
                  onChange={(v) => setValue(f.key, v)}
                  onFocus={() => setFocused(f.key)}
                  onBlur={() => setFocused((k) => (k === f.key ? null : k))}
                  inputRef={(el) => { inputs.current[f.key] = el; }}
                />
              ))}
            </div>
          )}

          {error && <p role="alert" className="text-xs text-brain-error mt-4">{error}</p>}

          <button
            type="button"
            onClick={run}
            disabled={starting}
            className="mt-5 w-full flex items-center justify-center gap-2 py-2.5 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            <Play size={14} />
            {starting ? 'Starting…' : 'Run'}
          </button>

          {form.fields.length > 0 && (
            <PasteRow
              labels={form.fields.map((f) => f.label)}
              onFill={(cells) => setValues((s) => {
                const next = { ...s };
                cells.forEach((v, i) => { next[form.fields[i].key] = v; });
                return next;
              })}
              onFilled={() => setError(null)}
            />
          )}
        </section>

        {/* Right: what it will do */}
        <section aria-label="What it will do" className="overflow-y-auto px-6 py-5 bg-brain-bg">
          <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-3">What it will do</p>
          <ol className="space-y-2">
            {form.phases.map((p, i) => (
              <PhaseRow key={i} index={i} phase={p} fields={form.fields} values={values} focused={focused} />
            ))}
          </ol>
          {form.phases.some((p) => p.steps.some((s) => s.pause)) && (
            <p className="flex items-center gap-1.5 text-xs text-brain-text-muted mt-3">
              <PauseCircle size={12} className="text-brain-warning" />
              Marked steps stop and wait for you in the browser.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function FieldRow({ field, value, onChange, onFocus, onBlur, inputRef }: {
  field: RunFormField;
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
  onBlur: () => void;
  inputRef: (el: HTMLInputElement | null) => void;
}) {
  const id = `run-field-${field.key}`;
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium text-brain-text-dim mb-1.5">
        {field.secret && <Lock size={11} className="flex-shrink-0" />}
        <span className="truncate">{field.label}</span>
        {!field.required && <span className="text-brain-text-muted font-normal">(optional)</span>}
      </label>
      <input
        id={id}
        ref={inputRef}
        type={field.secret ? 'password' : 'text'}
        autoComplete={field.secret ? 'new-password' : 'off'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={field.secret ? 'Kept secret — type it each time' : field.kind === 'option' ? 'The choice exactly as the site shows it' : undefined}
        className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-muted focus:outline-none focus:border-brain-accent transition-colors"
      />
    </div>
  );
}

function PasteRow({ labels, onFill, onFilled }: {
  labels: string[];
  onFill: (cells: string[]) => void;
  onFilled: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [result, setResult] = useState<PastedRow | null>(null);

  function apply(raw: string) {
    const r = fillFromRow(raw, labels);
    setResult(r.message ? r : null);
    if (r.values) {
      onFill(r.values);
      onFilled();
      setText('');
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="mt-3 flex items-center gap-1.5 text-xs text-brain-accent hover:text-brain-text transition-colors">
        <ClipboardPaste size={13} /> Or paste a spreadsheet row
      </button>
    );
  }
  return (
    <div className="mt-4">
      <label htmlFor="run-paste-row" className="block text-xs text-brain-text-dim mb-1.5">
        Copy one row from your spreadsheet and paste it here. The cells fill the boxes above in order, left to right.
      </label>
      <input
        id="run-paste-row"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => { e.preventDefault(); apply(e.clipboardData.getData('text')); }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(text); } }}
        placeholder="Paste a row"
        className="w-full bg-brain-bg border border-dashed border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-muted focus:outline-none focus:border-brain-accent transition-colors"
      />
      {result && (
        <p role="status" className={`text-xs mt-1.5 ${result.tone === 'ok' ? 'text-brain-text-dim' : 'text-brain-warning'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}

function PhaseRow({ index, phase, fields, values, focused }: {
  index: number;
  phase: PlanPhase;
  fields: RunFormField[];
  values: Record<string, string>;
  focused: string | null;
}) {
  const fieldKeys = useMemo(
    () => phase.steps.flatMap((s) => s.segments.flatMap((g) => ('field' in g ? [g.field] : []))),
    [phase],
  );
  // Phases where your details land, or where the run stops for you, start open.
  const [open, setOpen] = useState(() => fieldKeys.length > 0 || phase.steps.some((s) => s.pause));
  const pauses = phase.steps.filter((s) => s.pause).length;
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const highlighted = focused !== null && fieldKeys.includes(focused);

  return (
    <li className={`rounded-lg border bg-brain-surface transition-colors ${highlighted ? 'border-brain-accent/50' : 'border-brain-border'}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left"
      >
        <span className="mt-0.5 text-brain-text-muted flex-shrink-0">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
        <span className="w-4 text-xs text-brain-text-muted font-mono mt-0.5 flex-shrink-0">{index + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-sm text-brain-text truncate">{phase.title}</span>
            {pauses > 0 && (
              <span title="Stops and waits for you" className="flex items-center gap-1 text-xs text-brain-warning flex-shrink-0">
                <PauseCircle size={12} />{pauses > 1 ? pauses : ''}
              </span>
            )}
          </span>
          <span className="block text-xs text-brain-text-dim mt-0.5">
            {phase.steps.length} {phase.steps.length === 1 ? 'step' : 'steps'}
            {phase.note ? ` · ${phase.note}` : ''}
          </span>
          {!open && fieldKeys.length > 0 && (
            <span className="flex flex-wrap gap-1 mt-1.5">
              {fieldKeys.map((k) => <ValueMark key={k} field={byKey.get(k)} value={values[k] ?? ''} active={focused === k} />)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <ol className="px-3 pb-2.5 pl-10 space-y-1">
          {phase.steps.map((s) => <StepLine key={s.stepKey} step={s} byKey={byKey} values={values} focused={focused} />)}
        </ol>
      )}
    </li>
  );
}

function StepLine({ step, byKey, values, focused }: {
  step: PlanStep;
  byKey: Map<string, RunFormField>;
  values: Record<string, string>;
  focused: string | null;
}) {
  return (
    <li className="flex gap-2 text-xs text-brain-text leading-relaxed">
      <span className="w-3 flex-shrink-0 mt-0.5">
        {step.pause && (
          <PauseCircle size={12} className="text-brain-warning"
            aria-label={step.pause === 'handoff' ? 'You do this step' : 'Stops so you can check first'} />
        )}
      </span>
      <span className="min-w-0 break-words">
        {step.segments.map((g, i) => ('field' in g
          ? <ValueMark key={i} field={byKey.get(g.field)} value={values[g.field] ?? ''} active={focused === g.field} />
          : <span key={i}>{g.text}</span>))}
        {step.pause && (
          <span className="text-brain-warning">
            {step.pause === 'handoff' ? ' — waits for you to do this' : ' — waits for you to check first'}
          </span>
        )}
      </span>
    </li>
  );
}

// The run's value where it lands. Secrets show as dots, never the value.
function ValueMark({ field, value, active }: { field?: RunFormField; value: string; active: boolean }) {
  const label = field?.label ?? 'a value';
  const ring = active ? 'ring-1 ring-brain-accent' : '';
  if (!value.trim()) {
    return (
      <span className={`inline-block rounded px-1 border border-dashed border-brain-border-bright text-brain-text-muted italic ${ring}`}>
        {label}
      </span>
    );
  }
  return (
    <mark title={label} className={`rounded px-1 bg-brain-accent/15 text-brain-accent ${ring}`}>
      {field?.secret ? '••••••' : value}
    </mark>
  );
}
