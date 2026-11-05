import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

// Take Control: NodeBrain hands the live browser window to the person (a
// one-time code, a review before submitting), waits, and carries on when they
// say they're done. Same pattern as the agent engine's handover on the
// spike/playwright-biberk branch, moved here so a replayed workflow and an
// agent share one pause, one event pair and one dialog:
//   - the wait is a Promise held by request id,
//   - 'browser:take_control_needed' tells the app to show "Your turn in the browser",
//   - POST /api/take-control/:requestId { done } resolves it (true = continue,
//     false = stop),
//   - aborting the owner's signal (the run or task was stopped) ends the wait
//     as "stop", and 'browser:take_control_resolved' closes the dialog.
// There is no time limit: the person may take as long as they need.

export const takeControlEvents = new EventEmitter();

export interface TakeControlRequest {
  requestId: string;
  reason: string; // plain words for the person: what to do in the window
  title: string; // who is waiting, e.g. the workflow's name
  runId?: string; // a workflow run
  taskId?: string; // an agent task
  agentId?: string;
}

const pending = new Map<string, { request: TakeControlRequest; finish: (done: boolean) => void }>();

export function requestTakeControl(
  details: Omit<TakeControlRequest, 'requestId'>, signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const request: TakeControlRequest = { requestId: uuidv4(), ...details };
    const finish = (done: boolean) => {
      signal.removeEventListener('abort', onAbort);
      pending.delete(request.requestId);
      takeControlEvents.emit('browser:take_control_resolved', { requestId: request.requestId, runId: request.runId, taskId: request.taskId });
      resolve(done);
    };
    const onAbort = () => {
      if (pending.has(request.requestId)) finish(false);
    };
    pending.set(request.requestId, { request, finish });
    signal.addEventListener('abort', onAbort);
    takeControlEvents.emit('browser:take_control_needed', request);
  });
}

export function resolveTakeControl(requestId: string, done: boolean): boolean {
  const entry = pending.get(requestId);
  if (!entry) return false;
  entry.finish(done);
  return true;
}

// Open requests, so an app window opened (or reloaded) during a pause can
// still show the dialog.
export function listTakeControlRequests(): TakeControlRequest[] {
  return [...pending.values()].map((e) => e.request);
}
