import { useEffect } from 'react';
import { useStore } from '../stores/appStore';
import type { ToolApprovalRequest } from '../stores/appStore';
import type { TaskLog, Task, Agent } from '@shared/types';
import { pushToken } from '../utils/tokenStreamBuffer';

// A brief drop shouldn't flash the "reconnecting" banner — only surface it
// once the stream has actually been down for a couple of seconds.
const DISCONNECT_DEBOUNCE_MS = 2500;

export function useLiveSync() {
  useEffect(() => {
    let es: EventSource;
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let disconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource('/api/events');

      es.onopen = () => {
        if (disconnectTimer !== null) {
          clearTimeout(disconnectTimer);
          disconnectTimer = null;
        }
        useStore.getState().setBackendConnected(true);
      };

      es.addEventListener('log', (e) => {
        const log: TaskLog = JSON.parse((e as MessageEvent).data);
        useStore.getState().addLog(log);
      });

      es.addEventListener('task:start', (e) => {
        const task: Task = JSON.parse((e as MessageEvent).data);
        useStore.getState().addTask(task);
      });

      es.addEventListener('task:complete', (e) => {
        const task: Task = JSON.parse((e as MessageEvent).data);
        useStore.getState().updateTask(task);
      });

      es.addEventListener('task:failed', (e) => {
        const task: Task = JSON.parse((e as MessageEvent).data);
        useStore.getState().updateTask(task);
      });

      es.addEventListener('task:cancelled', (e) => {
        const task: Task = JSON.parse((e as MessageEvent).data);
        useStore.getState().updateTask(task);
      });

      es.addEventListener('tool:approval_needed', (e) => {
        const req: ToolApprovalRequest = JSON.parse((e as MessageEvent).data);
        useStore.getState().addPendingApproval(req);
      });

      es.addEventListener('agent:created', (e) => {
        const agent: Agent = JSON.parse((e as MessageEvent).data);
        useStore.getState().addAgent(agent);
      });

      es.addEventListener('agent:updated', (e) => {
        const agent: Agent = JSON.parse((e as MessageEvent).data);
        useStore.getState().updateAgent(agent);
      });

      es.addEventListener('agent:deleted', (e) => {
        const { id } = JSON.parse((e as MessageEvent).data) as { id: string };
        useStore.getState().removeAgent(id);
      });

      es.addEventListener('chat:token', (e) => {
        const { requestId, token } = JSON.parse((e as MessageEvent).data) as { requestId: string; token: string };
        // Buffered, not applied to the store directly — Dashboard's
        // useSmoothedStream drains this at a steady rate instead of
        // re-rendering once per token.
        pushToken(requestId, token);
      });

      es.addEventListener('chat:phase', (e) => {
        const { requestId, phase } = JSON.parse((e as MessageEvent).data) as { requestId: string; phase: string };
        useStore.getState().setChatPhase({ requestId, phase });
      });

      es.onerror = () => {
        es.close();
        if (disconnectTimer === null) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null;
            useStore.getState().setBackendConnected(false);
          }, DISCONNECT_DEBOUNCE_MS);
        }
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      if (disconnectTimer !== null) clearTimeout(disconnectTimer);
      es.close();
    };
  }, []);
}
