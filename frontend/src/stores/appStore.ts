import { create } from 'zustand';
import type { Agent, Task, TaskLog, Credential, ChatMessage } from '@shared/types';

export interface ToolApprovalRequest {
  taskId: string;
  agentId: string;
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
}

type ActiveTab = 'dashboard' | 'graph' | 'templates' | 'vault' | 'integrations' | 'analytics';

interface AppState {
  agents: Agent[];
  tasks: Task[];
  logs: TaskLog[];
  credentials: Credential[];
  chatMessages: ChatMessage[];
  availableModels: Record<string, string[]>;

  activeTab: ActiveTab;
  selectedAgentId: string | null;
  logsFilterAgentId: string | null;
  pendingApprovals: ToolApprovalRequest[];

  setAvailableModels: (models: Record<string, string[]>) => void;

  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;

  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (task: Task) => void;

  setLogs: (logs: TaskLog[]) => void;
  addLog: (log: TaskLog) => void;

  setCredentials: (creds: Credential[]) => void;
  addCredential: (cred: Credential) => void;
  removeCredential: (id: string) => void;

  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;

  setActiveTab: (tab: ActiveTab) => void;
  setSelectedAgent: (id: string | null) => void;
  setLogsFilterAgentId: (id: string | null) => void;
  addPendingApproval: (req: ToolApprovalRequest) => void;
  removePendingApproval: (approvalId: string) => void;
}

export const useStore = create<AppState>((set) => ({
  agents: [],
  tasks: [],
  logs: [],
  credentials: [],
  chatMessages: [],
  availableModels: {},
  activeTab: 'dashboard',
  selectedAgentId: null,
  logsFilterAgentId: null,
  pendingApprovals: [],

  setAvailableModels: (availableModels) => set({ availableModels }),
  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((s) => ({ agents: [agent, ...s.agents] })),
  updateAgent: (agent) =>
    set((s) => ({ agents: s.agents.map((a) => (a.id === agent.id ? agent : a)) })),
  removeAgent: (id) => set((s) => ({ agents: s.agents.filter((a) => a.id !== id) })),

  setTasks: (tasks) => set({ tasks }),
  addTask: (task) => set((s) => ({ tasks: [task, ...s.tasks.filter((t) => t.id !== task.id)] })),
  updateTask: (task) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === task.id ? task : t)) })),

  setLogs: (logs) => set({ logs }),
  addLog: (log) => set((s) => ({ logs: [...s.logs.slice(-499), log] })),

  setCredentials: (credentials) => set({ credentials }),
  addCredential: (cred) => set((s) => ({ credentials: [cred, ...s.credentials] })),
  removeCredential: (id) => set((s) => ({ credentials: s.credentials.filter((c) => c.id !== id) })),

  setChatMessages: (chatMessages) => set({ chatMessages }),
  addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),

  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),
  setLogsFilterAgentId: (logsFilterAgentId) => set({ logsFilterAgentId }),
  addPendingApproval: (req) => set((s) => ({ pendingApprovals: [...s.pendingApprovals, req] })),
  removePendingApproval: (approvalId) => set((s) => ({ pendingApprovals: s.pendingApprovals.filter((r) => r.approvalId !== approvalId) })),
}));