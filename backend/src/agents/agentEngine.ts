import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getCredentialForProvider } from '../vault/credentialVault';
import { createTask, updateTaskStatus, createLog } from '../db/taskRepository';
import { updateAgentStatus, getAgentById } from '../db/agentRepository';
import type { Agent, Task, TaskLog } from '../../shared-types';
import { EventEmitter } from 'events';

export const agentEvents = new EventEmitter();

function makeLog(taskId: string, agentId: string, message: string, level: TaskLog['level'] = 'info'): TaskLog {
  return {
    id: uuidv4(),
    taskId,
    agentId,
    level,
    message,
    timestamp: new Date().toISOString(),
  };
}

function persistLog(log: TaskLog): void {
  createLog(log);
  agentEvents.emit('log', log);
}

export async function executeAgentTask(agent: Agent, userInput: string): Promise<Task> {
  const taskId = uuidv4();
  const now = new Date().toISOString();

  const task: Task = {
    id: taskId,
    agentId: agent.id,
    name: `Task for ${agent.name}`,
    description: userInput.slice(0, 200),
    input: userInput,
    status: 'running',
    createdAt: now,
  };

  createTask(task);
  updateAgentStatus(agent.id, 'running');
  agentEvents.emit('task:start', task);

  persistLog(makeLog(taskId, agent.id, `Starting task for agent "${agent.name}"`));

  try {
    // Get OpenAI API key from vault
    const apiKey = getCredentialForProvider(agent.provider);
    if (!apiKey) {
      throw new Error(`No API key found for provider "${agent.provider}". Add one in the Credential Vault.`);
    }

    const openai = new OpenAI({ apiKey });

    persistLog(makeLog(taskId, agent.id, `Calling ${agent.model} with user input...`));

    const messages: OpenAI.ChatCompletionMessageParam[] = [];

    if (agent.systemPrompt) {
      messages.push({ role: 'system', content: agent.systemPrompt });
    }

    messages.push({ role: 'user', content: userInput });

    const completion = await openai.chat.completions.create({
      model: agent.model,
      messages,
      temperature: agent.config.temperature ?? 0.7,
      max_tokens: agent.config.maxTokens ?? 1000,
    });

    const output = completion.choices[0]?.message?.content ?? '(no response)';

    persistLog(makeLog(taskId, agent.id, `Task completed. Tokens used: ${completion.usage?.total_tokens ?? 'unknown'}`));

    updateTaskStatus(taskId, 'completed', output);
    updateAgentStatus(agent.id, 'idle');

    const completedTask = { ...task, status: 'completed' as const, output, completedAt: new Date().toISOString() };
    agentEvents.emit('task:complete', completedTask);

    return completedTask;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    persistLog(makeLog(taskId, agent.id, `Task failed: ${errorMessage}`, 'error'));

    updateTaskStatus(taskId, 'failed', undefined, errorMessage);
    updateAgentStatus(agent.id, 'error');

    const failedTask = { ...task, status: 'failed' as const, error: errorMessage };
    agentEvents.emit('task:failed', failedTask);

    return failedTask;
  }
}

// Parse a natural language chat message and extract agent configuration
export async function parseAgentFromChat(userMessage: string): Promise<Partial<Agent> | null> {
  const apiKey = getCredentialForProvider('openai');
  if (!apiKey) return null;

  const openai = new OpenAI({ apiKey });

  const systemPrompt = `You are an AI agent configuration parser. When given a natural language description of an AI agent, extract structured configuration.

Return ONLY valid JSON in this exact format:
{
  "name": "Agent Name",
  "description": "What this agent does",
  "model": "gpt-4o-mini",
  "systemPrompt": "You are a helpful assistant that...",
  "schedule": "0 * * * *" or null,
  "toolPermissions": []
}

For schedule, use cron expressions if time-based tasks are mentioned (e.g., "every hour" = "0 * * * *", "daily" = "0 9 * * *"). Otherwise null.
Model should default to "gpt-4o-mini" unless specified.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create an agent configuration for: ${userMessage}` },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    return JSON.parse(content) as Partial<Agent>;
  } catch {
    return null;
  }
}
