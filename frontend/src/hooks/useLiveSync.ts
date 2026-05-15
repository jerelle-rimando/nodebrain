import { useEffect } from 'react';
import { useStore } from '../stores/appStore';
import type { TaskLog, Task, Agent } from '@shared/types';

export function useLiveSync() {
  useEffect(() => {
    let es: EventSource;
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      es = new EventSource('/api/events');

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

      es.onerror = () => {
        es.close();
        if (!unmounted) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };
    }

    connect();

    return () => {
      unmounted = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      es.close();
    };
  }, []);
}
