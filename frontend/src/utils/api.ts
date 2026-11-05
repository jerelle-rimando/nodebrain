import { useStore } from '../stores/appStore';
import type { RecordingStatus, SaveRecordingRequest } from '@shared/types';

const BASE_URL = '/api';

// Live state of an MCP server, as the backend's getServerStatus derives it.
export type ServerState = 'running' | 'failed' | 'starting' | 'stopped';

export interface IntegrationServerStatus {
  connected: boolean;
  state: ServerState;
  message?: string;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
  } catch {
    // Network-level failure — the Electron proxy itself is unreachable.
    useStore.getState().setBackendConnected(false);
    throw new Error('backend unreachable');
  }

  if (res.status === 502) {
    // Electron's proxy responds 502 while the backend is mid-restart.
    useStore.getState().setBackendConnected(false);
    throw new Error('backend unreachable');
  }

  const json = await res.json();
  if (!json.success) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export const api = {
  getAgents: () => request<import('@shared/types').Agent[]>('/agents'),
  getAgent: (id: string) => request<import('@shared/types').Agent>(`/agents/${id}`),
  createAgent: (data: Partial<import('@shared/types').Agent>) =>
    request<import('@shared/types').Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<import('@shared/types').Agent>) =>
    request<import('@shared/types').Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) =>
    request<{ id: string }>(`/agents/${id}`, { method: 'DELETE' }),
  executeAgent: (id: string, input: string) =>
    request<{ message: string }>(`/agents/${id}/execute`, { method: 'POST', body: JSON.stringify({ input }) }),
  getAgentMemory: (id: string) =>
    request<{ id: string; text: string; source: string; timestamp: string }[]>(`/agents/${id}/memory`),
  deleteAgentMemory: (agentId: string, memoryId: string) =>
    request<{ id: string }>(`/agents/${agentId}/memory/${memoryId}`, { method: 'DELETE' }),
  clearAgentMemory: (id: string) =>
    request<{ deleted: number }>(`/agents/${id}/memory`, { method: 'DELETE' }),

  getAgentConnections: () => request<import('@shared/types').AgentConnection[]>('/agent-connections'),
  createAgentConnection: (sourceAgentId: string, targetAgentId: string) =>
    request<import('@shared/types').AgentConnection>('/agent-connections', {
      method: 'POST',
      body: JSON.stringify({ sourceAgentId, targetAgentId }),
    }),
  deleteAgentConnection: (id: string) =>
    request<{ id: string }>(`/agent-connections/${id}`, { method: 'DELETE' }),
  deleteAgentConnectionBetween: (sourceId: string, targetId: string) =>
    request<{ deleted: boolean }>(`/agent-connections/between/${sourceId}/${targetId}`, { method: 'DELETE' }),

  getTasks: () => request<import('@shared/types').Task[]>('/tasks'),
  getAgentTasks: (agentId: string) => request<import('@shared/types').Task[]>(`/tasks/agent/${agentId}`),
  stopTask: (id: string) => request<import('@shared/types').Task>(`/tasks/${id}/stop`, { method: 'POST' }),
  // Workflow recorder
  getRecordings: () => request<RecordingStatus[]>('/recordings'),
  startRecording: (url: string) =>
    request<RecordingStatus>('/recordings', { method: 'POST', body: JSON.stringify({ url }) }),
  finishRecording: (id: string) => request<RecordingStatus>(`/recordings/${id}/done`, { method: 'POST' }),
  saveRecording: (id: string, body: SaveRecordingRequest) =>
    request<RecordingStatus>(`/recordings/${id}/save`, { method: 'POST', body: JSON.stringify(body) }),
  discardRecording: (id: string) => request<RecordingStatus>(`/recordings/${id}/discard`, { method: 'POST' }),

  // Saved workflows and their runs
  getWorkflows: () => request<import('@shared/types').WorkflowsOverview>('/workflows'),
  setWorkflowIcon: (workflowId: string, emoji: string | null) =>
    request<{ id: string; emoji: string | null }>(`/workflows/${workflowId}/icon`, {
      method: 'PUT',
      body: JSON.stringify({ emoji }),
    }),
  getRunForm: (workflowId: string) => request<import('@shared/types').RunForm>(`/workflows/${workflowId}/run-form`),
  startWorkflowRun: (workflowId: string, inputs: Record<string, string>) =>
    request<import('@shared/types').WorkflowRun>(`/workflows/${workflowId}/runs`, {
      method: 'POST',
      body: JSON.stringify({ inputs }),
    }),
  getWorkflowRun: (runId: string) =>
    request<{
      run: import('@shared/types').WorkflowRun;
      steps: import('@shared/types').WorkflowRunStep[];
      active: boolean;
      repair?: import('@shared/types').WorkflowRunRepair;
    }>(`/workflow-runs/${runId}`),
  cancelWorkflowRun: (runId: string) => request<{ runId: string }>(`/workflow-runs/${runId}/cancel`, { method: 'POST' }),
  // Fixing a run that stopped because the site changed
  startRepair: (runId: string) => request<import('@shared/types').WorkflowRunRepair | null>(`/workflow-runs/${runId}/repair`, { method: 'POST' }),
  cancelRepair: (runId: string) => request<{ runId: string }>(`/workflow-runs/${runId}/repair/cancel`, { method: 'POST' }),
  releaseWorkflowRun: (runId: string) => request<{ runId: string }>(`/workflow-runs/${runId}/release`, { method: 'POST' }),
  runScreenshotUrl: (runId: string) => `${BASE_URL}/workflow-runs/${runId}/screenshot`,
  raiseRunBrowser: (runId: string) => request<{ runId: string }>(`/workflow-runs/${runId}/raise`, { method: 'POST' }),
  // The Workflows tab's chat panel: questions about one site's workflows
  askAboutSite: (siteId: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>, provider: string, model: string) =>
    request<{ reply: string }>(`/sites/${siteId}/chat`, {
      method: 'POST',
      body: JSON.stringify({ messages, provider, model }),
    }),

  // Take Control (workflow runs; agent tasks once they use the shared pause)
  getTakeControls: () => request<import('../stores/appStore').TakeControlRequest[]>('/take-control'),
  respondToTakeControl: (requestId: string, done: boolean) =>
    request<{ requestId: string; done: boolean }>(`/take-control/${requestId}`, {
      method: 'POST',
      body: JSON.stringify({ done }),
    }),

  respondToApproval: (taskId: string, approvalId: string, approved: boolean) =>
    request<{ approvalId: string; approved: boolean }>(`/tasks/${taskId}/approve/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    }),

  getLogs: () => request<import('@shared/types').TaskLog[]>('/logs'),
  getAgentLogs: (agentId: string) => request<import('@shared/types').TaskLog[]>(`/logs/agent/${agentId}`),

  getCredentials: () => request<import('@shared/types').Credential[]>('/credentials'),
  createCredential: (data: { name: string; provider: string; value: string; description?: string; baseUrl?: string }) =>
    request<import('@shared/types').Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (id: string, value: string) =>
    request<{ id: string; updated: boolean }>(`/credentials/${id}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteCredential: (id: string) =>
    request<{ id: string }>(`/credentials/${id}`, { method: 'DELETE' }),

  getMcpServers: () => request<any[]>('/mcp-servers'),
  createMcpServer: (data: {
    name: string;
    installCommand: string;
    envVars?: Record<string, string>;
  }) =>
    request<any>('/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  assessMcpServer: (data: { installCommand: string; envVars?: Record<string, string> }) =>
    request<{ accessWarning: import('@shared/types').McpAccessWarning | null }>('/mcp-servers/assess', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  deleteMcpServer: (id: string) =>
    request<{ id: string }>(`/mcp-servers/${id}`, { method: 'DELETE' }),

  getChatHistory: () => request<import('@shared/types').ChatMessage[]>('/chat/history'),
  sendChatMessage: (
    content: string,
    requestId?: string,
    opts?: { mode?: 'chat' | 'agent'; provider?: string; model?: string },
  ) =>
    request<{
      userMessage: import('@shared/types').ChatMessage;
      assistantMessage: import('@shared/types').ChatMessage;
      suggestAgentMode?: boolean;
    }>(
      '/chat/message',
      { method: 'POST', body: JSON.stringify({ content, requestId, ...opts }) }
    ),

    saveMessages: (messages: import('@shared/types').ChatMessage[]) =>
      request<{ saved: number }>('/chat/save', { method: 'POST', body: JSON.stringify({ messages }) }),

  testIntegration: (provider: string) =>
    request<{
      success: boolean;
      message: string;
      reason?: 'invalid_credential' | 'not_configured' | 'network' | 'unknown' | 'server_failed' | 'server_starting';
      connected: boolean;
      serverState?: ServerState;
    }>(
      `/integrations/${provider}/test`
    ),
  getIntegrationStatus: (provider: string) =>
    request<IntegrationServerStatus>(`/integrations/${provider}/status`),
  enableIntegration: (provider: string) =>
    request<IntegrationServerStatus>(`/integrations/${provider}/enable`, { method: 'POST' }),

  parseSchedule: (input: string) =>
    request<{ cron: string | null; human: string | null }>(`/schedule/parse?input=${encodeURIComponent(input)}`),

  getModels: () => request<Record<string, string[]>>('/models'),

  getDefaultModel: () => request<{ provider: string; model: string }>('/models/default'),

  getLocalEngineStatus: () =>
    request<{
      available: boolean;
      engineInstalled: boolean;
      modelPresent: boolean;
      provider: string;
      model: string;
    }>('/models/local'),

  getAnalytics: () =>
    request<{
      totalCost: number;
      totalCostThisMonth: number;
      totalTokens: number;
      totalTasks: number;
      successRate: number;
      costByProvider: { provider: string; totalCostUsd: number; totalTokens: number }[];
      costByAgent: { agentId: string; totalCostUsd: number; totalTokens: number }[];
      tasksPerDay: { date: string; count: number }[];
      topExpensiveTasks: {
        taskId: string;
        input: string | null;
        status: string | null;
        createdAt: string | null;
        cost: number;
        tokens: number;
        agentId: string | null;
        model: string | null;
      }[];
      pricingLastVerified: string;
    }>('/analytics'),
};
