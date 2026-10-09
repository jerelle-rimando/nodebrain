// Shared types between frontend and backend

export type AgentStatus = 'idle' | 'running' | 'error' | 'stopped';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ModelProvider = 'openai' | 'anthropic' | 'groq' | 'gemini' | 'ollama' | 'mistral' | 'together' | 'fireworks' | 'custom';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface Agent {
  id: string;
  name: string;
  description: string;
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
  schedule?: string; // cron expression
  emoji?: string; // visual identity, derived deterministically from name/description
  toolPermissions: string[];
  status: AgentStatus;
  createdAt: string;
  updatedAt: string;
  config: AgentConfig;
}

export interface AgentConfig {
  temperature?: number;
  maxTokens?: number;
  credentialIds?: string[];
  approvalMode?: boolean;
  approvedToolTypes?: string[];
  dryRun?: boolean;
  telegramChatId?: string;
  // Model turns per run before the run is stopped as failed. Each turn resends
  // the whole conversation, so cost grows faster than linearly with this.
  maxToolIterations?: number;
}

export const DEFAULT_MAX_TOOL_ITERATIONS = 30;
export const MAX_TOOL_ITERATIONS_LIMIT = 100;

// PATCH isn't schema-validated, so anything stored in config can be any shape;
// every reader goes through this.
export function resolveMaxToolIterations(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_ITERATIONS;
  return Math.min(MAX_TOOL_ITERATIONS_LIMIT, Math.max(1, Math.floor(value)));
}

export interface Task {
  id: string;
  agentId: string;
  name: string;
  description: string;
  input?: string;
  output?: string;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface TaskLog {
  id: string;
  taskId: string;
  agentId: string;
  level: LogLevel;
  message: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface Credential {
  id: string;
  name: string;
  provider: string;
  description?: string;
  createdAt: string;
  baseUrl?: string;
  // raw value never sent to frontend
}

export interface CredentialWithValue extends Credential {
  value: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentId?: string;
}

export interface GraphNode {
  id: string;
  type: 'agent' | 'task';
  label: string;
  status: AgentStatus | TaskStatus;
  data: Agent | Task;
  position: { x: number; y: number };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AgentConnection {
  id: string;
  sourceAgentId: string;
  targetAgentId: string;
  createdAt: string;
}
// Broad-access assessment for a custom MCP server, derived from its command,
// args, and env vars by backend/src/utils/mcpAccessRisk.ts. Tiers are ordered
// most to least broad; `tier` on the warning is the broadest finding.
export type McpAccessTier = 'system' | 'profile' | 'unscoped';

export interface McpAccessFinding {
  tier: McpAccessTier;
  path?: string;
  description: string;
}

export interface McpAccessWarning {
  tier: McpAccessTier;
  findings: McpAccessFinding[];
}
