import { useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, KeyRound, Lock } from 'lucide-react';
import type { RecordedValue, RecordedValueMode, RecordingStatus } from '@shared/types';
import { useStore } from '../../stores/appStore';
import { api } from '../../utils/api';
import { toast } from '../shared/Toast';

// The review screen that opens after a recording's Done (sketch G). The
// recording is held by the backend until Save workflow or Discard; nothing
// is written before Save.
export function RecordingReview() {
  const review = useStore((s) => s.recordingReview);
  if (!review?.draft) return null;
  // Keyed by recording so a new recording starts with fresh choices.
  return <ReviewDialog key={review.id} status={review} />;
}

interface RowChoice {
  mode: RecordedValueMode;
  secret: boolean;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ReviewDialog({ status }: { status: RecordingStatus }) {
  const draft = status.draft!;
  const setRecordingReview = useStore((s) => s.setRecordingReview);
  const [name, setName] = useState(draft.suggestedName);
  const [choices, setChoices] = useState<Record<string, RowChoice>>(() =>
    Object.fromEntries(draft.values.map((v) => [v.stepKey, { mode: v.canChange ? v.defaultMode : 'fixed', secret: false }])),
  );
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<'save' | 'discard' | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState<string | null>(status.error ?? null);

  const setChoice = (stepKey: string, patch: Partial<RowChoice>) =>
    setChoices((c) => ({ ...c, [stepKey]: { ...c[stepKey], ...patch } }));

  const trimmedName = name.trim();
  const changingCount = draft.values.filter((v) => choices[v.stepKey]?.mode === 'changes').length;

  async function save() {
    if (!trimmedName || busy) return;
    setBusy('save');
    setError(null);
    try {
      const saved = await api.saveRecording(status.id, {
        name: trimmedName,
        values: draft.values.map((v) => ({ stepKey: v.stepKey, ...choices[v.stepKey] })),
      });
      const asks = saved.result?.fieldCount ?? 0;
      toast.success(asks
        ? `Saved "${trimmedName}". Each time it runs, it will ask you for ${plural(asks, 'value', 'values')}.`
        : `Saved "${trimmedName}".`);
      setRecordingReview(null);
    } catch (err) {
      setError(err instanceof Error && err.message !== 'backend unreachable'
        ? err.message
        : "Couldn't reach NodeBrain to save. Try again in a moment.");
      setBusy(null);
    }
  }

  async function discard() {
    if (busy) return;
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setBusy('discard');
    try {
      await api.discardRecording(status.id);
      setRecordingReview(null);
    } catch {
      setError("Couldn't reach NodeBrain to discard. Try again in a moment.");
      setBusy(null);
    }
  }

  const userSteps = draft.steps.filter((s) => s.position > 0 || s.action !== 'navigate');
  const opening = draft.steps.length > userSteps.length ? draft.steps[0] : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="recording-review-title"
        className="relative w-full max-w-xl mx-4 max-h-[90vh] flex flex-col bg-brain-surface border border-brain-border rounded-xl shadow-2xl animate-slide-up"
      >
        {/* Header */}
        <div className="flex items-start gap-3 px-5 py-4 border-b border-brain-border">
          <div className="w-8 h-8 rounded-lg bg-brain-success/10 border border-brain-success/30 flex items-center justify-center flex-shrink-0">
            <CheckCircle2 size={15} className="text-brain-success" />
          </div>
          <div className="min-w-0">
            <p id="recording-review-title" className="text-sm font-semibold text-brain-text">
              Got it — {plural(draft.stepCount, 'step', 'steps')} on {draft.siteKey}
            </p>
            <p className="text-xs text-brain-text-dim mt-0.5">Check what should change each time you run this.</p>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <div>
            <label htmlFor="recording-review-name" className="block text-xs font-medium text-brain-text-dim mb-1.5">
              Call this workflow
            </label>
            <input
              id="recording-review-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="For example: Get a quote"
              className="w-full bg-brain-bg border border-brain-border rounded-lg px-3 py-2 text-sm text-brain-text placeholder-brain-text-dim focus:outline-none focus:border-brain-accent transition-colors"
            />
            {!trimmedName && <p className="text-xs text-brain-warning mt-1.5">Give it a name so you can find it later.</p>}
          </div>

          <div>
            <p className="text-xs font-medium text-brain-text-dim uppercase tracking-wider mb-2">What you entered</p>
            {draft.values.length === 0 ? (
              <div className="rounded-lg border border-dashed border-brain-border px-4 py-3 text-sm text-brain-text-dim">
                Nothing you entered needs to change. Each time this runs, it will do exactly what you just did.
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {draft.values.map((v) => (
                    <ValueRow key={v.stepKey} value={v} choice={choices[v.stepKey]} onChange={(p) => setChoice(v.stepKey, p)} />
                  ))}
                </ul>
                <p className="text-xs text-brain-text-muted mt-2 leading-relaxed">
                  <span className="text-brain-text-dim">Changes</span> means you'll give a new value each time it runs.{' '}
                  <span className="text-brain-text-dim">Secret</span> keeps it locked away like a password.
                </p>
              </>
            )}
          </div>

          {draft.usesSavedLogin && (
            <div className="flex items-start gap-2 text-xs text-brain-text-dim">
              <KeyRound size={13} className="mt-0.5 flex-shrink-0" />
              <span>Your sign-in for {draft.siteKey} will be saved in the Vault, so it isn't listed here.</span>
            </div>
          )}

          <div>
            <button
              type="button"
              onClick={() => setShowAll((s) => !s)}
              aria-expanded={showAll}
              className="flex items-center gap-1 text-xs text-brain-accent hover:text-brain-text transition-colors"
            >
              {showAll ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {showAll ? 'Hide the steps' : `See all ${plural(draft.stepCount, 'step', 'steps')}`}
            </button>
            {showAll && (
              <div className="mt-2 rounded-lg border border-brain-border bg-brain-bg px-3 py-2">
                {opening && <p className="text-xs text-brain-text-muted py-1">{opening.description}</p>}
                <ol className="space-y-1">
                  {userSteps.map((s, i) => (
                    <li key={s.stepKey} className="flex gap-2 text-xs text-brain-text py-0.5">
                      <span className="w-5 text-right text-brain-text-muted font-mono flex-shrink-0">{i + 1}</span>
                      <span className="min-w-0 break-words">{s.description}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>

          {error && <p role="alert" className="text-xs text-brain-error">{error}</p>}
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-brain-border">
          <p className="text-xs text-brain-text-muted mr-auto">
            {changingCount > 0 ? `Will ask for ${plural(changingCount, 'value', 'values')} each run` : 'Runs the same way every time'}
          </p>
          <button
            type="button"
            onClick={discard}
            onBlur={() => setConfirmDiscard(false)}
            disabled={busy !== null}
            className="px-4 py-2 text-sm border border-brain-error/40 text-brain-error hover:bg-brain-error/10 disabled:opacity-40 rounded-lg transition-colors"
          >
            {busy === 'discard' ? 'Discarding…' : confirmDiscard ? 'Yes, discard it' : 'Discard'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || !trimmedName}
            className="px-4 py-2 text-sm bg-brain-accent hover:bg-brain-accent-dim disabled:opacity-40 text-white rounded-lg transition-colors"
          >
            {busy === 'save' ? 'Saving…' : 'Save workflow'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ValueRow({ value, choice, onChange }: {
  value: RecordedValue;
  choice: RowChoice;
  onChange: (patch: Partial<RowChoice>) => void;
}) {
  // A clicked option the recorder pinned some other way (not by its name)
  // can't take a different value, or be locked away, yet.
  const locked = value.kind === 'option-click' && !value.canChange;
  return (
    <li className="flex items-center gap-3 rounded-lg border border-brain-border bg-brain-bg px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-brain-text truncate flex items-center gap-1.5" title={value.value}>
          {choice.secret && <Lock size={11} className="text-brain-text-dim flex-shrink-0" />}
          {value.value ? value.value : <span className="italic text-brain-text-dim">Left empty</span>}
        </p>
        <p className="text-xs text-brain-text-dim truncate" title={value.label}>{value.label}</p>
      </div>

      <div role="radiogroup" aria-label={`${value.label}: does it change each run?`}
        className="inline-flex flex-shrink-0 rounded-lg border border-brain-border bg-brain-elevated p-0.5 text-xs">
        {(['changes', 'fixed'] as const).map((mode) => {
          const active = choice.mode === mode;
          const disabled = mode === 'changes' && !value.canChange;
          return (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              title={disabled ? "NodeBrain can't swap in a different choice here yet." : undefined}
              onClick={() => onChange({ mode })}
              className={`px-2.5 py-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                active ? 'bg-brain-accent/20 text-brain-accent' : 'text-brain-text-dim hover:text-brain-text'
              }`}
            >
              {mode === 'changes' ? 'Changes' : 'Always this'}
            </button>
          );
        })}
      </div>

      <label
        className={`flex flex-shrink-0 items-center gap-1.5 text-xs text-brain-text-dim ${locked ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        title={locked ? "This one can't be kept secret." : 'Store it encrypted, like a password. Good for things like a tax ID.'}
      >
        <input
          type="checkbox"
          checked={choice.secret}
          disabled={locked}
          onChange={(e) => onChange({ secret: e.target.checked })}
          className="accent-brain-accent"
        />
        Secret
      </label>
    </li>
  );
}
