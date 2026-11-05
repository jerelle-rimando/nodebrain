import { useEffect, useState } from 'react';
import { ChevronRight, Workflow as WorkflowIcon } from 'lucide-react';
import type { WorkflowListItem } from '@shared/types';
import { api } from '../../utils/api';
import { RunFormScreen } from './RunFormScreen';
import { RunView } from './RunView';
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
  return <WorkflowList onOpen={(workflowId) => setScreen({ name: 'form', workflowId })} />;
}

function WorkflowList({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<WorkflowListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getWorkflows()
      .then(setItems)
      .catch(() => setError("Couldn't load your workflows. Try again in a moment."));
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <h1 className="text-base font-semibold text-brain-text">Workflows</h1>
        <p className="text-xs text-brain-text-dim mt-0.5 mb-5">Tasks you recorded in your browser. Open one to run it with new details.</p>

        {error && <p role="alert" className="text-sm text-brain-error">{error}</p>}
        {items && items.length === 0 && (
          <div className="rounded-lg border border-dashed border-brain-border px-4 py-6 text-sm text-brain-text-dim text-center">
            No workflows yet. Workflows you record will show up here.
          </div>
        )}
        <ul className="space-y-2">
          {items?.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                onClick={() => onOpen(w.id)}
                className="w-full flex items-center gap-3 rounded-lg border border-brain-border bg-brain-surface hover:border-brain-border-bright px-4 py-3 text-left transition-colors"
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
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
