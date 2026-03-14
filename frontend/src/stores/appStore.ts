import { create } from 'zustand';
import type { Agent, Task, TaskLog, Credential, ChatMessage } from '@shared/types';

type ActiveTab = 'dashboard' | 'graph' | 'vault' | 'integrations';

interface AppState {
  agents: Agent[];
  tasks: Task[];
  logs: TaskLog[];
  credentials: Credential[];
  chatMessages: ChatMessage[];

  activeTab: ActiveTab;
  selectedAgentId: string | null;

  setAgents: (agents: Agent[]) => void;
  addAgent: (agent: Agent) => void;
  updateAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;

  setTasks: (tasks: Task[]) => void;

  setLogs: (logs: TaskLog[]) => void;
  addLog: (log: TaskLog) => void;

  setCredentials: (creds: Credential[]) => void;
  addCredential: (cred: Credential) => void;
  removeCredential: (id: string) => void;

  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;

  setActiveTab: (tab: ActiveTab) => void;
  setSelectedAgent: (id: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  agents: [],
  tasks: [],
  logs: [],
  credentials: [],
  chatMessages: [],
  activeTab: 'dashboard',
  selectedAgentId: null,

  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((s) => ({ agents: [agent, ...s.agents] })),
  updateAgent: (agent) =>
    set((s) => ({ agents: s.agents.map((a) => (a.id === agent.id ? agent : a)) })),
  removeAgent: (id) => set((s) => ({ agents: s.agents.filter((a) => a.id !== id) })),

  setTasks: (tasks) => set({ tasks }),

  setLogs: (logs) => set({ logs }),
  addLog: (log) => set((s) => ({ logs: [...s.logs.slice(-499), log] })),

  setCredentials: (credentials) => set({ credentials }),
  addCredential: (cred) => set((s) => ({ credentials: [cred, ...s.credentials] })),
  removeCredential: (id) => set((s) => ({ credentials: s.credentials.filter((c) => c.id !== id) })),

  setChatMessages: (chatMessages) => set({ chatMessages }),
  addChatMessage: (msg) => set((s) => ({ chatMessages: [...s.chatMessages, msg] })),

  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),
}));