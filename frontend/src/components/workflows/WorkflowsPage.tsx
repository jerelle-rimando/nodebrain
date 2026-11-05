import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Workflow as WorkflowIcon, Wrench } from 'lucide-react';
import type { RecordingStatus, WorkflowListItem } from '@shared/types';
import { api } from '../../utils/api';
import { RunFormScreen } from './RunFormScreen';
import { RunView } from './RunView';
import { OPEN_STATES, RecordButton, RecordingBanner, StartRecordingDialog } from './RecordControls';
import { STATUS_TONE, STATUS_WORDS, timeAgo } from './runFormUtils';

// Saved workflows: the list, the run form, and the run view, in one tab.
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
      onOpen={(workflowId) => setScreen({ name: 'form', workflowId })}
      onFix={(workflowId, runId) => setScreen({ name: 'run', workflowId, runId })}
    />
  );
}

function WorkflowList({ onOpen, onFix }: {
  onOpen: (id: string) => void;
  onFix: (workflowId: string, runId: string) => void;
}) {
  const [items, setItems] = useState<WorkflowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [note, setNote] = useState<string | undefined>();

  const load = useCallback(() => {
    api.getWorkflows()
      .then((w) => { setItems(w); setError(null); })
      .catch(() => setError("Couldn't load your workflows. Try again in a moment."));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Follow any recording that's open, including one started before this
  // screen was opened. When one is saved (from the review screen, after the
  // browser has closed), refresh the list so the new workflow shows.
  useEffect(() => {
    let stop = false;
    let openId: string | undefined;
    let saved: Set<string> | undefined;
    const tick = async () => {
      const all = await api.getRecordings().catch(() => null);
      if (stop || !all) return;
      const open = all.find((r) => OPEN_STATES.has(r.state)) ?? null;
      if (openId && open?.id !== openId) setNote(undefined);
      openId = open?.id;
      setRecording(open);
      const nowSaved = new Set(all.filter((r) => r.state === 'saved').map((r) => r.id));
      if (saved && [...nowSaved].some((id) => !saved!.has(id))) load();
      saved = nowSaved;
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => { stop = true; clearInterval(timer); };
  }, [load]);

  const ask = () => setAsking(true);
  const dialog = (
    <StartRecordingDialog
      open={asking}
      onClose={() => setAsking(false)}
      onStarted={(status, reattached) => {
        setAsking(false);
        setRecording(status);
        setNote(reattached
          ? `You were already recording on ${status.siteKey}, so NodeBrain carried on with that one. Switch to its browser window, then press Done there or here.`
          : undefined);
      }}
    />
  );

  // No workflows yet: recording one is the only thing to do here.
  if (items && items.length === 0 && !error) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-xl mx-auto px-6 py-10">
          {recording && <RecordingBanner status={recording} note={note} />}
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
              <RecordButton onClick={ask} big />
            </div>
          </div>
        </div>
        {dialog}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-start gap-3 mb-5">
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-brain-text">Workflows</h1>
            <p className="text-xs text-brain-text-dim mt-0.5">Tasks you recorded in your browser. Open one to run it with new details.</p>
          </div>
          <RecordButton onClick={ask} />
        </div>

        {recording && <RecordingBanner status={recording} note={note} />}
        {error && <p role="alert" className="text-sm text-brain-error">{error}</p>}
        <ul className="space-y-2">
          {items?.map((w) => (
            <li key={w.id} className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => onOpen(w.id)}
                className="min-w-0 flex-1 flex items-center gap-3 rounded-lg border border-brain-border bg-brain-surface hover:border-brain-border-bright px-4 py-3 text-left transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-brain-accent/10 border border-brain-accent/30 flex items-center justify-center flex-shrink-0">
                  <WorkflowIcon size={15} className="text-brain-accent" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-brain-text truncate">{w.name}</p>
                  <p className="text-xs text-brain-text-dim truncate">
                    {w.siteName || w.siteKey}
                    {' · '}
                    {w.fieldCount === 0 ? 'Nothing to fill in' : `${w.fieldCount} ${w.fieldCount === 1 ? 'detail' : 'details'} to fill in`}
                    {' · '}
                    {w.lastRun
                      ? <>Last ran {timeAgo(w.lastRun.startedAt)} — <span className={STATUS_TONE[w.lastRun.status]}>{STATUS_WORDS[w.lastRun.status]}</span></>
                      : "Hasn't run yet"}
                  </p>
                </div>
                <ChevronRight size={15} className="text-brain-text-muted flex-shrink-0" />
              </button>
              {w.lastRun?.needsFix && (
                // The last run stopped because the site changed: its run view
                // says what happened and has "Show me where it is".
                <button
                  type="button"
                  onClick={() => onFix(w.id, w.lastRun!.id)}
                  className="flex items-center gap-1.5 px-3 rounded-lg border border-brain-warning/40 text-xs text-brain-warning hover:bg-brain-warning/10 transition-colors flex-shrink-0"
                >
                  <Wrench size={13} /> Fix
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      {dialog}
    </div>
  );
}
