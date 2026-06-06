import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { getCredentialForProvider } from '../vault/credentialVault';
import { createTask, updateTaskStatus, createLog } from '../db/taskRepository';
import { dbRun } from '../db/database';
import { updateAgentStatus } from '../db/agentRepository';
import { queryRelevantContext } from '../rag/ragEngine';
import { getToolsForAgent, formatToolsForOpenAI, formatToolsForAnthropic } from '../mcp/toolRegistry';
import { callTool } from '../mcp/mcpClient';
import type { Agent, Task, TaskLog } from '../../shared-types';
import { EventEmitter } from 'events';
import { getConnectionsForAgent } from '../db/agentConnectionRepository';
import { getAllAgents } from '../db/agentRepository';
import { getTasksByAgent } from '../db/taskRepository';

export const agentEvents = new EventEmitter();

const activeTaskControllers = new Map<string, AbortController>();

export function cancelTask(taskId: string): boolean {
  const controller = activeTaskControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  return true;
}

const pendingApprovals = new Map<string, (approved: boolean) => void>();

export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const resolve = pendingApprovals.get(approvalId);
  if (!resolve) return false;
  pendingApprovals.delete(approvalId);
  resolve(approved);
  return true;
}

function requestApproval(
  taskId: string,
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const approvalId = uuidv4();
    pendingApprovals.set(approvalId, resolve);
    agentEvents.emit('tool:approval_needed', { taskId, agentId, approvalId, toolName, args });
  });
}

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
  anthropic: 'claude-sonnet-4-6',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2',
  mistral: 'mistral-small-latest',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  fireworks: 'accounts/fireworks/models/llama-v3-70b-instruct',
  custom: 'gpt-4o-mini',
};

// Prices are local estimates used only for cost display — not real billing data.
// Any model not in this table will show $0.00 cost even though token counts remain accurate.
// Prices in USD per million tokens { input, output }.
export const PRICING_LAST_VERIFIED = '2026-06-05';

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── OpenAI ────────────────────────────────────────────────────────────────
  'gpt-4o-mini':   { input:  0.15,  output:  0.60 }, // verified: multiple sources May 2026
  'gpt-4o':        { input:  2.50,  output: 10.00 }, // verified: multiple sources May 2026
  'gpt-4-turbo':   { input: 10.00,  output: 30.00 }, // helicone.ai + lmmarketcap.com (official page 403; pricepertoken.com shows $5/$15)
  'gpt-4':         { input: 30.00,  output: 60.00 }, // verified: multiple sources
  'gpt-3.5-turbo': { input:  0.50,  output:  1.50 }, // gpt-3.5-turbo-0125 pricing; official page blocked
  'o1':            { input: 15.00,  output: 60.00 }, // verified: multiple sources May 2026
  'o1-mini':       { input:  1.10,  output:  4.40 }, // helicone.ai May 2026
  'o3-mini':       { input:  1.10,  output:  4.40 }, // verified: multiple sources May 2026

  // ── Anthropic ─────────────────────────────────────────────────────────────
  'claude-opus-4-8':            { input:  5.00, output: 25.00 }, // official docs (verified Jun 2026)
  'claude-opus-4-7':            { input:  5.00, output: 25.00 }, // official docs (verified Jun 2026)
  'claude-opus-4-6':            { input:  5.00, output: 25.00 }, // official docs (verified Jun 2026)
  'claude-sonnet-4-6':          { input:  3.00, output: 15.00 }, // official docs (verified Jun 2026)
  'claude-haiku-4-5':           { input:  1.00, output:  5.00 }, // official docs (verified Jun 2026)
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 }, // retired alias; last known price
  'claude-sonnet-4-20250514':   { input:  3.00, output: 15.00 }, // retiring Jun 15 2026; use claude-sonnet-4-6
  'claude-3-5-sonnet-20241022': { input:  3.00, output: 15.00 }, // retired; not on current pricing page
  'claude-3-5-haiku-20241022':  { input:  0.80, output:  4.00 }, // retired; Bedrock/Vertex only
  'claude-3-opus-20240229':     { input: 15.00, output: 75.00 }, // retired; not on current pricing page
  'claude-3-sonnet-20240229':   { input:  3.00, output: 15.00 }, // retired; not on current pricing page
  'claude-3-haiku-20240307':    { input:  0.25, output:  1.25 }, // retired; not on current pricing page

  // ── Groq ──────────────────────────────────────────────────────────────────
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 }, // official groq.com/pricing
  'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 }, // deprecated on Groq; last known price
  'llama-3.1-8b-instant':    { input: 0.05, output: 0.08 }, // official groq.com/pricing
  'mixtral-8x7b-32768':      { input: 0.24, output: 0.24 }, // deprecated on Groq; last known price
  'gemma2-9b-it':            { input: 0.20, output: 0.20 }, // helicone.ai (Groq)

  // ── Gemini (Google AI) ────────────────────────────────────────────────────
  'gemini-2.0-flash':    { input: 0.10,   output: 0.40  }, // official ai.google.dev/pricing (deprecated Jun 2026)
  'gemini-1.5-flash':    { input: 0.075,  output: 0.30  }, // retired from Google AI pricing page; last known price
  'gemini-1.5-flash-8b': { input: 0.0375, output: 0.15  }, // retired from Google AI pricing page; last known price
  'gemini-1.5-pro':      { input: 1.25,   output: 5.00  }, // retired from Google AI pricing page; last known price

  // ── Mistral ───────────────────────────────────────────────────────────────
  'mistral-small-latest':  { input: 0.10, output: 0.30 }, // aicostcheck.com (Mistral Small 3.2)
  'mistral-medium-latest': { input: 1.50, output: 7.50 }, // aicostcheck.com (Mistral Medium 3.5)
  'mistral-large-latest':  { input: 0.50, output: 1.50 }, // aicostcheck.com (Mistral Large 3)
  'codestral-latest':      { input: 0.30, output: 0.90 }, // verified: multiple sources

  // ── Together AI ───────────────────────────────────────────────────────────
  'meta-llama/Llama-3.3-70B-Instruct-Turbo':        { input: 0.88, output: 0.88 }, // together.ai (verified Jun 2026)
  'meta-llama/Llama-3-70b-chat-hf':                { input: 0.88, output: 0.88 }, // together.ai (legacy)
  'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo':  { input: 0.88, output: 0.88 }, // together.ai
  'meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo': { input: 3.50, output: 3.50 }, // aipricing.guru May 2026
  'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo':   { input: 0.18, output: 0.18 }, // together.ai

  // ── Fireworks ─────────────────────────────────────────────────────────────
  'accounts/fireworks/models/llama-v3-70b-instruct':    { input: 0.90, output: 0.90 }, // docs.fireworks.ai (>16B tier)
  'accounts/fireworks/models/llama-v3p1-70b-instruct':  { input: 0.90, output: 0.90 }, // docs.fireworks.ai (>16B tier)
  'accounts/fireworks/models/llama-v3p1-405b-instruct': { input: 3.00, output: 3.00 }, // aipricing.guru May 2026
  'accounts/fireworks/models/llama-v3p1-8b-instruct':   { input: 0.20, output: 0.20 }, // docs.fireworks.ai (4B–16B tier)
};

const FREE_PROVIDERS = new Set(['ollama', 'custom']);

function recordUsage(
  taskId: string,
  agentId: string,
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): void {
  const pricing = FREE_PROVIDERS.has(provider) ? { input: 0, output: 0 } : (MODEL_PRICING[model] ?? { input: 0, output: 0 });
  const estimatedCostUsd =
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output;
  dbRun(
    `INSERT INTO usage_records
       (id, task_id, agent_id, provider, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), taskId, agentId, provider, model,
      promptTokens, completionTokens, promptTokens + completionTokens,
      estimatedCostUsd, new Date().toISOString(),
    ],
  );
}

const MAX_TOOL_ITERATIONS = 15;

const READ_ONLY_TOOL_PREFIXES = [
  'search_',
  'get_',
  'list_',
  'read_',
  'query_',
  'find_',
  'fetch_',
];

function isReadOnlyTool(toolName: string): boolean {
  return READ_ONLY_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix));
}

const DESTRUCTIVE_TOOLS = new Set([
  // telegram (@iqai/mcp-telegram) — tools/send-message.js, forward-message.js, pin-message.js
  'telegram__SEND_MESSAGE',
  'telegram__FORWARD_MESSAGE',
  'telegram__PIN_MESSAGE',
  // slack (@modelcontextprotocol/server-slack) — dist/index.js
  'slack__slack_post_message',
  'slack__slack_reply_to_thread',
  'slack__slack_add_reaction',
  // github (@modelcontextprotocol/server-github) — dist/index.js
  'github__create_or_update_file',
  'github__create_repository',
  'github__push_files',
  'github__create_issue',
  'github__create_pull_request',
  'github__fork_repository',
  'github__create_branch',
  'github__update_issue',
  'github__add_issue_comment',
  'github__create_pull_request_review',
  'github__merge_pull_request',
  'github__update_pull_request_branch',
  // filesystem (@modelcontextprotocol/server-filesystem) — dist/index.js
  'filesystem__write_file',
  'filesystem__edit_file',
  'filesystem__create_directory',
  'filesystem__move_file',
  // notion (@notionhq/notion-mcp-server) — tools derive names from OpenAPI operationIds
  // proxy.ts builds names as `API-{operationId}`; confirmed from scripts/notion-openapi.json
  'notion__API-post-page',
  'notion__API-patch-page',
  'notion__API-create-a-comment',
  'notion__API-delete-a-block',
  'notion__API-update-a-block',
  'notion__API-patch-block-children',
  'notion__API-move-page',
]);

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
  signal: AbortSignal,
  depth = 0,
  destructiveFailRef: { value: boolean } = { value: false },
): Promise<string> {
  const tools = await getToolsForAgent(agent.id);
  const formattedTools = formatToolsForOpenAI(tools);
  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    if (signal.aborted) return '(task cancelled by user)';
    iterations++;

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: agent.config.temperature ?? 0.7,
      max_tokens: agent.config.maxTokens ?? 2000,
      ...(formattedTools.length > 0 ? { tools: formattedTools, tool_choice: 'auto' } : {}),
    });

    if (completion.usage) {
      recordUsage(taskId, agent.id, agent.provider, model, completion.usage.prompt_tokens, completion.usage.completion_tokens);
    }

    const choice = completion.choices[0];
    const message = choice.message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? '(no response)';
    }

    messages.push(message);

    for (const toolCall of message.tool_calls) {
      const { serverName, toolName } = parseToolName(toolCall.function.name);
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;

      if (agent.config.approvalMode && DESTRUCTIVE_TOOLS.has(toolCall.function.name)) {
        persistLog(makeLog(taskId, agent.id, `Awaiting approval for tool: ${toolCall.function.name}`, 'warn'));
        const approved = await requestApproval(taskId, agent.id, toolCall.function.name, args);
        if (!approved) {
          persistLog(makeLog(taskId, agent.id, `Tool "${toolCall.function.name}" denied by user`, 'warn'));
          messages.push({ role: 'tool', tool_call_id: toolCall.id, content: '(tool execution denied by user)' });
          continue;
        }
      }

      if (agent.config.dryRun && !isReadOnlyTool(toolName)) {
        const simulated = `(DRY-RUN) Would have called ${toolCall.function.name} with args: ${JSON.stringify(args)}`;
        persistLog(makeLog(taskId, agent.id, `[DRY-RUN] Skipping tool "${toolCall.function.name}" with args: ${JSON.stringify(args)}`));
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: simulated });
        continue;
      }

      persistLog(makeLog(taskId, agent.id, `Calling tool: ${toolCall.function.name}`));

      let toolResult = '';
      let toolFailed = false;
      try {
        if (serverName === 'pdf-reader') {
          const { readPdfAsText } = await import('../utils/pdfReader');
          toolResult = await readPdfAsText(args.file_path as string);
        } else if (serverName === 'agent-coordinator' && toolName === 'delegate_to_agent') {
          const targetName = args.target_agent_name as string;
          const task = args.task as string;
          if (depth >= 3) {
            toolResult = 'Error: Maximum delegation depth of 3 reached. Cannot delegate further.';
          } else {
            const connections = getConnectionsForAgent(agent.id);
            const allAgents = getAllAgents();
            const targetAgent = allAgents.find(a =>
              a.name.toLowerCase() === targetName.toLowerCase() &&
              connections.some(c => c.targetAgentId === a.id)
            );
            if (!targetAgent) {
              const connectedNames = connections
                .map(c => allAgents.find(a => a.id === c.targetAgentId)?.name)
                .filter(Boolean)
                .join(', ');
              toolResult = `Error: No connected agent found with name "${targetName}". Your connected agents are: ${connectedNames || 'none'}`;
            } else {
              persistLog(makeLog(taskId, agent.id, `Delegating to agent "${targetAgent.name}" (depth ${depth + 1})`));
              const delegatedTask = await executeAgentTask(targetAgent, task, depth + 1);
              toolResult = delegatedTask.output ?? delegatedTask.error ?? '(no response from sub-agent)';
            }
          }
        } else {
          toolResult = await callTool(serverName, toolName, args);
        }
        persistLog(makeLog(taskId, agent.id, `Tool "${toolCall.function.name}" completed`));
      } catch (err) {
        toolResult = `[TOOL ERROR] ${err instanceof Error ? err.message : String(err)}`;
        toolFailed = true;
        persistLog(makeLog(taskId, agent.id, `Tool "${toolCall.function.name}" failed: ${toolResult}`, 'error'));
      }

      if (toolFailed && DESTRUCTIVE_TOOLS.has(toolCall.function.name)) {
        destructiveFailRef.value = true;
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
  signal: AbortSignal,
  depth = 0,
  destructiveFailRef: { value: boolean } = { value: false },
): Promise<string> {
  const tools = await getToolsForAgent(agent.id);
  const formattedTools = formatToolsForAnthropic(tools);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userInput },
  ];

  let iterations = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    if (signal.aborted) return '(task cancelled by user)';
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

    recordUsage(taskId, agent.id, 'anthropic', model, response.usage.input_tokens, response.usage.output_tokens);

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

      if (agent.config.approvalMode && DESTRUCTIVE_TOOLS.has(block.name)) {
        persistLog(makeLog(taskId, agent.id, `Awaiting approval for tool: ${block.name}`, 'warn'));
        const approved = await requestApproval(taskId, agent.id, block.name, args);
        if (!approved) {
          persistLog(makeLog(taskId, agent.id, `Tool "${block.name}" denied by user`, 'warn'));
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: '(tool execution denied by user)' });
          continue;
        }
      }

      if (agent.config.dryRun && !isReadOnlyTool(toolName)) {
        const simulated = `(DRY-RUN) Would have called ${block.name} with args: ${JSON.stringify(args)}`;
        persistLog(makeLog(taskId, agent.id, `[DRY-RUN] Skipping tool "${block.name}" with args: ${JSON.stringify(args)}`));
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: simulated });
        continue;
      }

      persistLog(makeLog(taskId, agent.id, `Calling tool: ${block.name}`));

      let toolResult = '';
      let toolFailed = false;
      try {
        if (serverName === 'pdf-reader') {
          const { readPdfAsText } = await import('../utils/pdfReader');
          toolResult = await readPdfAsText(args.file_path as string);
        } else if (serverName === 'agent-coordinator' && toolName === 'delegate_to_agent') {
          const targetName = args.target_agent_name as string;
          const task = args.task as string;
          if (depth >= 3) {
            toolResult = 'Error: Maximum delegation depth of 3 reached. Cannot delegate further.';
          } else {
            const connections = getConnectionsForAgent(agent.id);
            const allAgents = getAllAgents();
            const targetAgent = allAgents.find(a =>
              a.name.toLowerCase() === targetName.toLowerCase() &&
              connections.some(c => c.targetAgentId === a.id)
            );
            if (!targetAgent) {
              const connectedNames = connections
                .map(c => allAgents.find(a => a.id === c.targetAgentId)?.name)
                .filter(Boolean)
                .join(', ');
              toolResult = `Error: No connected agent found with name "${targetName}". Your connected agents are: ${connectedNames || 'none'}`;
            } else {
              persistLog(makeLog(taskId, agent.id, `Delegating to agent "${targetAgent.name}" (depth ${depth + 1})`));
              const delegatedTask = await executeAgentTask(targetAgent, task, depth + 1);
              toolResult = delegatedTask.output ?? delegatedTask.error ?? '(no response from sub-agent)';
            }
          }
        } else {
          toolResult = await callTool(serverName, toolName, args);
        }
        persistLog(makeLog(taskId, agent.id, `Tool "${block.name}" completed`));
      } catch (err) {
        toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
        toolFailed = true;
        persistLog(makeLog(taskId, agent.id, `Tool "${block.name}" failed: ${toolResult}`, 'error'));
      }

      if (toolFailed && DESTRUCTIVE_TOOLS.has(block.name)) {
        destructiveFailRef.value = true;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: toolResult,
        ...(toolFailed ? { is_error: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return '(max tool iterations reached)';
}

export async function executeAgentTask(agent: Agent, userInput: string, depth = 0): Promise<Task> {
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

  const controller = new AbortController();
  activeTaskControllers.set(taskId, controller);

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

    // Build context from connected agents' recent activity
    const connections = getConnectionsForAgent(agent.id);
    let connectionContext = '';
    if (connections.length > 0) {
      const allAgents = getAllAgents();
      const contextParts: string[] = [];
      for (const conn of connections) {
        const connectedAgent = allAgents.find(a => a.id === conn.targetAgentId);
        if (!connectedAgent) continue;
        const recentTasks = getTasksByAgent(conn.targetAgentId).slice(0, 3);
        if (recentTasks.length > 0) {
          const summary = recentTasks
            .map(t => `- Task: ${t.input?.slice(0, 100) ?? 'unknown'} → Result: ${t.output?.slice(0, 200) ?? t.error ?? 'no output'}`)
            .join('\n');
          contextParts.push(`Connected agent "${connectedAgent.name}" recent activity:\n${summary}`);
        }
      }
      if (contextParts.length > 0) {
        connectionContext = `\n\nConnected agents context:\n${contextParts.join('\n\n')}`;
      }
    }

    let relevantContext: string[] = [];
    try {
      relevantContext = await queryRelevantContext(userInput, agent.id);
    } catch {
      // RAG not yet ready or unavailable; proceed without context
    }
    const contextBlock = relevantContext.length > 0
      ? `\n\nRelevant context:\n${relevantContext.join('\n---\n')}`
      : '';

    const telegramHint = agent.config.telegramChatId
      ? `\n\nWhen sending Telegram messages, use chat ID ${agent.config.telegramChatId} unless explicitly told otherwise.`
      : '';
    const fullSystemPrompt = (agent.systemPrompt || 'You are a helpful AI assistant.') + contextBlock + connectionContext + telegramHint;

    const destructiveFailRef = { value: false };
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
        controller.signal,
        depth,
        destructiveFailRef,
      );
    } else {
      const client = getClient(agent.provider, apiKey);
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: fullSystemPrompt },
        { role: 'user', content: userInput },
      ];
      output = await runOpenAIAgenticLoop(client, model, messages, agent, taskId, controller.signal, depth, destructiveFailRef);
    }

    activeTaskControllers.delete(taskId);

    if (destructiveFailRef.value) {
      const errorMessage = 'A required action could not be completed — a destructive tool call failed.';
      persistLog(makeLog(taskId, agent.id, `Task failed: ${errorMessage}`, 'error'));
      updateTaskStatus(taskId, 'failed', undefined, errorMessage);
      updateAgentStatus(agent.id, 'error');
      const failedTask = { ...task, status: 'failed' as const, error: errorMessage };
      agentEvents.emit('task:failed', failedTask);
      return failedTask;
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
    activeTaskControllers.delete(taskId);
    const errorMessage = err instanceof Error ? err.message : String(err);
    persistLog(makeLog(taskId, agent.id, `Task failed: ${errorMessage}`, 'error'));
    updateTaskStatus(taskId, 'failed', undefined, errorMessage);
    updateAgentStatus(agent.id, 'error');

    const failedTask = { ...task, status: 'failed' as const, error: errorMessage };
    agentEvents.emit('task:failed', failedTask);
    return failedTask;
  }
}

export async function parseAgentFromChat(userMessage: string): Promise<Partial<Agent>[] | null> {
  const providerPriority = ['openai', 'anthropic', 'groq', 'gemini', 'mistral', 'together', 'fireworks', 'ollama', 'custom'];

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

  const systemPrompt = `You are an AI agent configuration parser. When given a natural language description of one or more AI agents, extract structured configuration for each agent.

ALWAYS return a JSON array, even when only one agent is described. Each element has this shape:
{
  "name": "Agent Name",
  "description": "What this agent does",
  "model": "${model}",
  "systemPrompt": "You are a helpful assistant that...",
  "schedule": "0 * * * *" or null,
  "toolPermissions": [],
  "connectsTo": ["Other Agent Name"]
}

"connectsTo" is an array of OTHER agent names (from the same batch) that this agent should delegate tasks to. Only include it when the user explicitly describes delegation, orchestration, or one agent handing off work to another. Omit the field (or use an empty array) otherwise.

description must be one short sentence, max 80 characters.
For schedule, use cron expressions if time-based tasks are mentioned (e.g., "every hour" = "0 * * * *", "daily at 9am" = "0 9 * * *"). Otherwise null.
Model should default to "${model}" unless the user specifies otherwise.
Return ONLY the JSON array with no additional text or markdown.`;

  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Create agent configuration(s) for: ${userMessage}` },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return null;

    const clean = content.replace(/```json|```/g, '').trim();
    const parsed: unknown = JSON.parse(clean);
    if (Array.isArray(parsed)) return parsed as Partial<Agent>[];
    return [parsed as Partial<Agent>];
  } catch {
    return null;
  }
}