import cron from 'node-cron';
import { getAllAgents, getAgentById } from '../db/agentRepository';
import { executeAgentTask } from '../agents/agentEngine';
import type { Agent } from '../../shared-types';

interface ScheduledJob {
  agentId: string;
  task: cron.ScheduledTask;
}

const scheduledJobs = new Map<string, ScheduledJob>();

// node-cron stores every task in global.scheduledTasks keyed by a UUID.
// task.stop() only clears the setTimeout — it does not remove the entry.
// Call this after stop() to fully deregister and allow GC.
function deregisterFromCron(task: cron.ScheduledTask): void {
  const name = (task as unknown as { options?: { name?: string } }).options?.name;
  if (name) cron.getTasks().delete(name);
}

export function startScheduler(): void {
  console.log('[Scheduler] Starting agent scheduler...');
  refreshSchedules();
}

export function refreshSchedules(): void {
  const agents = getAllAgents();

  // Remove jobs for agents that no longer have schedules
  for (const [agentId, job] of scheduledJobs.entries()) {
    const agent = agents.find(a => a.id === agentId);
    if (!agent || !agent.schedule) {
      job.task.stop();
      deregisterFromCron(job.task);
      scheduledJobs.delete(agentId);
      console.log(`[Scheduler] Removed schedule for agent ${agentId}`);
    }
  }

  // Add or update jobs for agents with schedules
  for (const agent of agents) {
    if (!agent.schedule) continue;
    if (!cron.validate(agent.schedule)) {
      console.warn(`[Scheduler] Invalid cron expression for agent ${agent.id}: ${agent.schedule}`);
      continue;
    }

    const existing = scheduledJobs.get(agent.id);
    if (existing) continue; // already scheduled

    scheduleAgent(agent);
  }
}

export function scheduleAgent(agent: Agent): void {
  if (!agent.schedule || !cron.validate(agent.schedule)) return;

  // Remove existing job if any
  unscheduleAgent(agent.id);

  const agentId = agent.id;
  const task = cron.schedule(agent.schedule, async () => {
    const fresh = getAgentById(agentId);
    if (!fresh) return;
    console.log(`[Scheduler] Running scheduled task for agent "${fresh.name}"`);
    await executeAgentTask(fresh, fresh.systemPrompt);
  });

  scheduledJobs.set(agent.id, { agentId: agent.id, task });
  console.log(`[Scheduler] Scheduled agent "${agent.name}" with cron: ${agent.schedule}`);
}

export function unscheduleAgent(agentId: string): void {
  const existing = scheduledJobs.get(agentId);
  if (existing) {
    existing.task.stop();
    deregisterFromCron(existing.task);
    scheduledJobs.delete(agentId);
  }
}

export function stopScheduler(): void {
  for (const job of scheduledJobs.values()) {
    job.task.stop();
  }
  scheduledJobs.clear();
  console.log('[Scheduler] All scheduled jobs stopped.');
}

export function getScheduledAgentIds(): string[] {
  return Array.from(scheduledJobs.keys());
}
