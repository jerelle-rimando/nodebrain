import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getCredentialForProvider } from '../vault/credentialVault';
import { createTask, updateTaskStatus, createLog } from '../db/taskRepository';
import { updateAgentStatus } from '../db/agentRepository';
import { queryRelevantContext } from '../rag/ragEngine';
import { getToolsForAgent, formatToolsForOpenAI, formatToolsForAnthropic } from '../mcp/toolRegistry';
import { callTool } from '../mcp/mcpClient';
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

const MAX_TOOL_ITERATIONS = 10;

function getClient(provider: string, apiKey: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey || 'ollama',
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

function parseToolName(fullName: string): { serverName: string; toolName: string } {
  const parts = fullName.split('__');
  return {
    serverName: parts[0],
    toolName: parts.slice(1).join('__'),
  };
}

async function runOpenAIAgenticLoop(
  client: OpenAI,
  model: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  agent: Agent,
  taskId: string,
): Promise<string> {
  const tools = await getToolsForAgent();
  const formattedTools = formatToolsForOpenAI(tools);
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: agent.config.temperature ?? 0.7,
      max_tokens: agent.config.maxTokens ?? 2000,
      ...(formattedTools.length > 0 ? { tools: formattedTools } : {}),
    });

    const choice = completion.choices[0];
    const message = choice.message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? '(no response)';
    }

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      const { serverName, toolName } = parseToolName(toolCall.function.name);
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      persistLog(makeLog(taskId, agent.id, `Calling tool: ${toolCall.function.name}`));

      let toolResult: string;
      try {
        toolResult = await callTool(serverName, toolName, args);
        persistLog(makeLog(taskId, agent.id, `Tool "${toolCall.function.name}" completed`));
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
        persistLog(makeLog(taskId, agent.id, `Tool "${toolCall.function.name}" failed: ${toolResult}`, 'error'));
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }
  }

  return '(max tool iterations reached)';
}

async function runAnthropicAgenticLoop(
  anthropic: Anthropic,
  model: string,
  systemPrompt: string,
  userInput: string,
  agent: Agent,
  taskId: string,
): Promise<string> {
  const tools = await getToolsForAgent();
  const formattedTools = formatToolsForAnthropic(tools);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userInput },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: agent.config.maxTokens ?? 2000,
      system: systemPrompt || undefined,
      messages,
    };

    if (formattedTools.length > 0) {
      requestParams.tools = formattedTools as Anthropic.Tool[];
    }

    const response = await anthropic.messages.create(requestParams);

    if (response.stop_reason !== 'tool_use') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock && textBlock.type === 'text' ? textBlock.text : '(no response)';
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const { serverName, toolName } = parseToolName(block.name);
      const args = block.input as Record<string, unknown>;

      persistLog(makeLog(taskId, agent.id, `Calling tool: ${block.name}`));

      let toolResult: string;
      try {
        toolResult = await callTool(serverName, toolName, args);
        persistLog(makeLog(taskId, agent.id, `Tool "${block.name}" completed`));
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
        persistLog(makeLog(taskId, agent.id, `Tool "${block.name}" failed: ${toolResult}`, 'error'));
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: toolResult,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return '(max tool iterations reached)';
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

    const relevantContext = await queryRelevantContext(userInput, agent.id);
    const contextBlock = relevantContext.length > 0
      ? `\n\nRelevant context:\n${relevantContext.join('\n---\n')}`
      : '';

    const fullSystemPrompt = (agent.systemPrompt || 'You are a helpful AI assistant.') + contextBlock;

    let output = '';

    if (agent.provider === 'anthropic') {
      const anthropic = new Anthropic({ apiKey });
      output = await runAnthropicAgenticLoop(
        anthropic,
        model,
        fullSystemPrompt,
        userInput,
        agent,
        taskId,
      );
    } else {
      const client = getClient(agent.provider, apiKey);
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: userInput },
      ];
      output = await runOpenAIAgenticLoop(client, model, messages, agent, taskId);
    }

    persistLog(makeLog(taskId, agent.id, `Task completed successfully.`));
    updateTaskStatus(taskId, 'completed', output);
    updateAgentStatus(agent.id, 'idle');

    const completedTask = {
      ...task,
      status: 'completed' as const,
      output,
      completedAt: new Date().toISOString(),
    };
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
  const providerPriority = ['openai', 'groq', 'gemini', 'mistral', 'together', 'fireworks', 'ollama', 'custom'];

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