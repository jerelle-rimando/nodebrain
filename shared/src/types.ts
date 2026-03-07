// Shared types between frontend and backend

export type AgentStatus = 'idle' | 'running' | 'error' | 'stopped';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';
export type ModelProvider = 'openai' | 'anthropic' | 'custom';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface Agent {
  id: string;
  name: string;
  description: string;
  provider: ModelProvider;
  model: string;
  systemPrompt: string;
  schedule?: string; // cron expression
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
