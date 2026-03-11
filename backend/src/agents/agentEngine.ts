import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getCredentialForProvider } from '../vault/credentialVault';
import { createTask, updateTaskStatus, createLog } from '../db/taskRepository';
import { updateAgentStatus } from '../db/agentRepository';
import type { Agent, Task, TaskLog } from '../../shared-types';
import { EventEmitter } from 'events';

export const agentEvents = new EventEmitter();

const BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',

  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  ollama: 'http://localhost:11434/v1',
  mistral: 'https://api.mistral.ai/v1',
  together: 'https://api.together.xyz/v1',
  fireworks: 'https://api.fireworks.ai/inference/v1',
  custom: 'https://api.openai.com/v1',
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  groq: 'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-4-20250514',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2',
  mistral: 'mistral-small-latest',
  together: 'meta-llama/Llama-3-70b-chat-hf',
  fireworks: 'accounts/fireworks/models/llama-v3-70b-instruct',
  custom: 'gpt-4o-mini',
};

function getClient(provider: string, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey || 'ollama', // ollama doesn't need a real key
    baseURL: BASE_URLS[provider] ?? BASE_URLS.openai,
  });
}

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
    const apiKey = getCredentialForProvider(agent.provider) ?? '';

    if (!apiKey && agent.provider !== 'ollama') {
      throw new Error(`No API key found for provider "${agent.provider}". Add one in the Credential Vault.`);
    }

    const model = agent.model || DEFAULT_MODELS[agent.provider] || 'gpt-4o-mini';
persistLog(makeLog(taskId, agent.id, `Calling ${model} via ${agent.provider}...`));

let output = '';

if (agent.provider === 'anthropic') {
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model,
    max_tokens: agent.config.maxTokens ?? 1000,
    system: agent.systemPrompt || undefined,
    messages: [{ role: 'user', content: userInput }],
  });
  output = response.content[0].type === 'text' ? response.content[0].text : '(no response)';
} else {
  const client = getClient(agent.provider, apiKey);
  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (agent.systemPrompt) {
    messages.push({ role: 'system', content: agent.systemPrompt });
  }
  messages.push({ role: 'user', content: userInput });
  const completion = await client.chat.completions.create({
    model,
    messages,
    temperature: agent.config.temperature ?? 0.7,
    max_tokens: agent.config.maxTokens ?? 1000,
  });
  output = completion.choices[0]?.message?.content ?? '(no response)';
}
    persistLog(makeLog(taskId, agent.id, `Task completed successfully.`));

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

export async function parseAgentFromChat(userMessage: string): Promise<Partial<Agent> | null> {
  // Try providers in order of preference until one has a key
  const providerPriority = ['openai', 'groq', 'mistral', 'together', 'fireworks', 'ollama', 'custom'];
  
  let apiKey = '';
  let provider = 'openai';

  for (const p of providerPriority) {
    const key = getCredentialForProvider(p);
    if (key || p === 'ollama') {
      apiKey = key ?? '';
      provider = p;
      break;
    }
  }

  if (!apiKey && provider !== 'ollama') return null;

  const client = getClient(provider, apiKey);
  const model = DEFAULT_MODELS[provider] ?? 'gpt-4o-mini';

  const systemPrompt = `You are an AI agent configuration parser. When given a natural language description of an AI agent, extract structured configuration.

Return ONLY valid JSON in this exact format:
{
  "name": "Agent Name",
  "description": "What this agent does",
  "model": "${model}",
  "systemPrompt": "You are a helpful assistant that...",
  "schedule": "0 * * * *" or null,
  "toolPermissions": []
}

For schedule, use cron expressions if time-based tasks are mentioned (e.g., "every hour" = "0 * * * *", "daily at 9am" = "0 9 * * *"). Otherwise null.
Model should default to "${model}" unless the user specifies otherwise.`;

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create an agent configuration for: ${userMessage}` },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as Partial<Agent>;
  } catch {
    return null;
  }
}