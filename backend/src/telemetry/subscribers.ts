import { agentEvents } from '../agents/agentEngine';
import type { TelemetryErrorType } from '../agents/agentEngine';
import { getFlag, setFlag } from '../db/metaRepository';
import { telemetry, minutesSinceInstall } from '../utils/telemetry';
import type { Task, Agent } from '../../shared-types';

// One-shot lifecycle events: gated on a flag in kv_store (same SQLite file as
// everything else, so it survives restarts and reinstalling the app doesn't
// reset it as long as the data dir is preserved).
function fireOnce(flagKey: string, eventName: string, properties?: Record<string, unknown>): void {
  if (getFlag(flagKey)) return;
  setFlag(flagKey, new Date().toISOString());
  telemetry(eventName, properties);
}

function durationMs(task: Task): number {
  if (!task.completedAt) return 0;
  return new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime();
}

interface TaskStartMeta {
  dryRun: boolean;
  approvalMode: boolean;
  providerType: 'local' | 'hosted';
}

interface TaskCompleteMeta {
  toolCallCount: number;
}

interface TaskFailedMeta {
  toolCallCount: number;
  errorType: TelemetryErrorType;
}

export function registerTelemetrySubscribers(): void {
  agentEvents.on('agent:created', (_agent: Agent) => {
    fireOnce('telemetry_first_agent_created', 'first_agent_created');
  });

  agentEvents.on('task:complete', (_task: Task) => {
    const minutes = minutesSinceInstall();
    fireOnce('telemetry_first_agent_run', 'first_agent_run', minutes !== undefined ? { minutesSinceInstall: minutes } : undefined);
  });

  agentEvents.on('tool:approval_resolved', (payload: { approved: boolean }) => {
    telemetry('approval_resolved', { approved: payload.approved });
  });

  agentEvents.on('task:start', (_task: Task, meta?: TaskStartMeta) => {
    if (!meta) return;
    telemetry('task_started', {
      dryRun: meta.dryRun,
      approvalMode: meta.approvalMode,
      providerType: meta.providerType,
    });
  });

  agentEvents.on('task:complete', (task: Task, meta?: TaskCompleteMeta) => {
    telemetry('task_completed', {
      durationMs: durationMs(task),
      toolCallCount: meta?.toolCallCount ?? 0,
    });
  });

  agentEvents.on('task:failed', (task: Task, meta?: TaskFailedMeta) => {
    telemetry('task_failed', {
      durationMs: durationMs(task),
      errorType: meta?.errorType ?? 'unknown',
    });
  });

  agentEvents.on('task:cancelled', (task: Task) => {
    telemetry('task_cancelled', {
      durationMs: durationMs(task),
    });
  });
}
