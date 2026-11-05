import { create } from 'zustand';
import type { Agent, Task, TaskLog, Credential, ChatMessage, RecordingStatus } from '@shared/types';

export interface ToolApprovalRequest {
  taskId: string;
  agentId: string;
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
}

// NodeBrain handed the browser window to the person (Take Control) and is
// waiting: a workflow run at a step that needs them, or an agent task.
export interface TakeControlRequest {
  requestId: string;
  reason: string;
  title: string;
  runId?: string;
  taskId?: string;
  agentId?: string;
}

type ActiveTab = 'dashboard' | 'graph' | 'workflows' | 'templates' | 'vault' | 'integrations' | 'analytics' | 'settings';

interface AppState {
  agents: Agent[];
  tasks: Task[];
  logs: TaskLog[];
  credentials: Credential[];
  chatMessages: ChatMessage[];
  availableModels: Record<string, string[]>;
  // Backend-signalled routing phase for the in-flight chat request, keyed by
  // requestId. Drives the streaming placeholder label (e.g. "Creating…").
  chatPhase: { requestId: string; phase: string } | null;

  activeTab: ActiveTab;
  selectedAgentId: string | null;
  logsFilterAgentId: string | null;
  pendingApprovals: ToolApprovalRequest[];
  pendingTakeControls: TakeControlRequest[];
  // Whether the Electron-proxied backend is currently reachable. Driven by
  // useLiveSync's SSE connection (primary) and api.ts's request() (secondary).
  backendConnected: boolean;
  // A finished recording waiting on the review screen. Nothing is saved
  // until the person presses Save workflow there.
  recordingReview: RecordingStatus | null;
  // Text handed to the chat composer from elsewhere in the app (a stopped
  // workflow's "Ask the agent"). The composer takes it once and clears it;
  // the person reads it and sends it themselves.
  chatDraft: string | null;

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
  setChatPhase: (phase: { requestId: string; phase: string } | null) => void;

  setActiveTab: (tab: ActiveTab) => void;
  setSelectedAgent: (id: string | null) => void;
  setLogsFilterAgentId: (id: string | null) => void;
  addPendingApproval: (req: ToolApprovalRequest) => void;
  removePendingApproval: (approvalId: string) => void;
  addPendingTakeControl: (req: TakeControlRequest) => void;
  removePendingTakeControl: (requestId: string) => void;
  setBackendConnected: (connected: boolean) => void;
  setRecordingReview: (status: RecordingStatus | null) => void;
  setChatDraft: (draft: string | null) => void;
}

export const useStore = create<AppState>((set) => ({
  agents: [],
  tasks: [],
  logs: [],
  credentials: [],
  chatMessages: [],
  availableModels: {},
  chatPhase: null,
  activeTab: 'dashboard',
  selectedAgentId: null,
  logsFilterAgentId: null,
  pendingApprovals: [],
  pendingTakeControls: [],
  backendConnected: true,
  recordingReview: null,
  chatDraft: null,

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
  setChatPhase: (chatPhase) => set({ chatPhase }),

  setActiveTab: (activeTab) => set({ activeTab }),
  setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),
  setLogsFilterAgentId: (logsFilterAgentId) => set({ logsFilterAgentId }),
  addPendingApproval: (req) => set((s) => ({ pendingApprovals: [...s.pendingApprovals, req] })),
  removePendingApproval: (approvalId) => set((s) => ({ pendingApprovals: s.pendingApprovals.filter((r) => r.approvalId !== approvalId) })),
  setBackendConnected: (backendConnected) => set({ backendConnected }),
  addPendingTakeControl: (req) => set((s) => (s.pendingTakeControls.some((r) => r.requestId === req.requestId)
    ? s : { pendingTakeControls: [...s.pendingTakeControls, req] })),
  removePendingTakeControl: (requestId) => set((s) => ({ pendingTakeControls: s.pendingTakeControls.filter((r) => r.requestId !== requestId) })),
  setRecordingReview: (recordingReview) => set({ recordingReview }),
  setChatDraft: (chatDraft) => set({ chatDraft }),
}));