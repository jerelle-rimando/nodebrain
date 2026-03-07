import { useEffect } from 'react';
import { useStore } from '../stores/appStore';
import type { TaskLog, Task } from '@shared/types';

export function useEventStream() {
  const { addLog, updateAgent } = useStore();

  useEffect(() => {
    const es = new EventSource('/api/events');

    es.addEventListener('log', (e) => {
      const log: TaskLog = JSON.parse(e.data);
      addLog(log);
    });

    es.addEventListener('task:start', (e) => {
      const task: Task = JSON.parse(e.data);
      // Update agent status to running
      useStore.setState((s) => ({
        agents: s.agents.map((a) =>
          a.id === task.agentId ? { ...a, status: 'running' } : a
        ),
      }));
    });

    es.addEventListener('task:complete', (e) => {
      const task: Task = JSON.parse(e.data);
      useStore.setState((s) => ({
        agents: s.agents.map((a) =>
          a.id === task.agentId ? { ...a, status: 'idle' } : a
        ),
        tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)],
      }));
    });

    es.addEventListener('task:failed', (e) => {
      const task: Task = JSON.parse(e.data);
      useStore.setState((s) => ({
        agents: s.agents.map((a) =>
          a.id === task.agentId ? { ...a, status: 'error' } : a
        ),
      }));
    });

    es.onerror = () => {
      // Will auto-reconnect
    };

    return () => es.close();
  }, [addLog, updateAgent]);
}
