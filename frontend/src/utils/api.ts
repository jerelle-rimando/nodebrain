const BASE_URL = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });

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

  getTasks: () => request<import('@shared/types').Task[]>('/tasks'),
  getAgentTasks: (agentId: string) => request<import('@shared/types').Task[]>(`/tasks/agent/${agentId}`),

  getLogs: () => request<import('@shared/types').TaskLog[]>('/logs'),
  getAgentLogs: (agentId: string) => request<import('@shared/types').TaskLog[]>(`/logs/agent/${agentId}`),

  getCredentials: () => request<import('@shared/types').Credential[]>('/credentials'),
  createCredential: (data: { name: string; provider: string; value: string; description?: string }) =>
    request<import('@shared/types').Credential>('/credentials', { method: 'POST', body: JSON.stringify(data) }),
  updateCredential: (id: string, value: string) =>
    request<{ id: string; updated: boolean }>(`/credentials/${id}`, { method: 'PUT', body: JSON.stringify({ value }) }),
  deleteCredential: (id: string) =>
    request<{ id: string }>(`/credentials/${id}`, { method: 'DELETE' }),

  getChatHistory: () => request<import('@shared/types').ChatMessage[]>('/chat/history'),
  sendChatMessage: (content: string) =>
    request<{ userMessage: import('@shared/types').ChatMessage; assistantMessage: import('@shared/types').ChatMessage }>(
      '/chat/message',
      { method: 'POST', body: JSON.stringify({ content }) }
    ),

    saveMessages: (messages: import('@shared/types').ChatMessage[]) =>
      request<{ saved: number }>('/chat/save', { method: 'POST', body: JSON.stringify({ messages }) }),

  testIntegration: (provider: string) =>
    request<{ success: boolean; message: string }>(`/integrations/${provider}/test`),
  
  parseSchedule: (input: string) =>
    request<{ cron: string | null; human: string | null }>(`/schedule/parse?input=${encodeURIComponent(input)}`),
};
