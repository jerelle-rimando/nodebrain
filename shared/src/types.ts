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

// ── Recorded browser workflows ────────────────────────────────────────────
// A site agent owns workflows for one site; a workflow is a chain of
// immutable versions; a run executes one version with one set of inputs.
// Secret values are never part of these objects: secret literals and secret
// recorded field values expose only a flag, and are read through
// getStepLiteralValue / getFieldRecordedValue in workflowRepository.ts.

export interface SiteAgent {
  id: string;
  siteKey: string; // registrable domain, e.g. "jimcor.com"; the identity
  name: string; // derived display name, e.g. "Jimcor"; not unique
  emoji?: string;
  startUrl: string;
  credentialId?: string; // credentials.id holding the site login
  profileDir?: string; // per-site persistent browser profile
  createdAt: string;
  updatedAt: string;
}

export interface Workflow {
  id: string;
  siteAgentId: string;
  name: string;
  description: string;
  currentVersionId?: string; // unset only between createWorkflow and the first version
  createdAt: string;
  updatedAt: string;
}

// 'optional': the person said a step that couldn't be found doesn't always
// appear (repairedStepKey is that step, fromRunId the run it stopped).
export type WorkflowVersionReason = 'recorded' | 'repair' | 'optional' | 'edit' | 'rollback';

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  number: number;
  parentVersionId?: string;
  reason: WorkflowVersionReason;
  repairedStepKey?: string;
  fromRunId?: string;
  createdAt: string;
}

export type WorkflowStepAction =
  | 'navigate' | 'click' | 'fill' | 'press' | 'select'
  | 'check' | 'uncheck' | 'upload' | 'hover' | 'handoff';

// Where a step's value comes from.
export type WorkflowValueSource = 'none' | 'literal' | 'field' | 'credential';

// Where the value goes when the step runs:
//   text    → the typed text (fill)
//   option  → the option(s) chosen in a native <select>
//   locator → substituted for WORKFLOW_VALUE_PLACEHOLDER in `locator` (and in
//             fingerprint strings), e.g. a click on role=option[name="{{value}}"]
//   file    → a file path for upload
export type WorkflowValueTarget = 'text' | 'option' | 'locator' | 'file';

export const WORKFLOW_VALUE_PLACEHOLDER = '{{value}}';

// What NodeBrain captured about the element at record time; the fallback when
// `locator` stops matching. All optional: capture what the element has.
export interface WorkflowStepFingerprint {
  role?: string;
  name?: string; // accessible name
  label?: string;
  placeholder?: string;
  nameAttr?: string;
  testId?: string;
  tag?: string;
  inputType?: string;
  heading?: string; // nearest heading or landmark text
  urlPath?: string;
  ordinal?: number; // index among elements matching role+name
  framePath?: string[];
  landmark?: string; // nearest enclosing landmark or dialog, e.g. 'form "Login"'
  container?: string; // name of the list or group an option sits in, e.g. 'State'
  autocomplete?: string;
  fieldIndex?: number; // position among the page's visible fill-in fields, from 1
}

export type WorkflowSignal =
  | { name: 'navigation'; url?: string }
  | { name: 'popup'; popupAlias?: string }
  | { name: 'download'; downloadAlias?: string }
  | { name: 'dialog'; dialogAlias?: string };

export interface WorkflowStep {
  id: string;
  versionId: string;
  stepKey: string; // stable across versions
  position: number;
  action: WorkflowStepAction;
  locator?: string;
  fingerprint: WorkflowStepFingerprint;
  pageAlias: string;
  origin?: string;
  args: Record<string, unknown>; // key, modifiers, button, clickCount, option labels+values
  valueSource: WorkflowValueSource;
  valueTarget?: WorkflowValueTarget;
  literalValue?: string; // only for non-secret literals
  literalSecret: boolean;
  fieldId?: string;
  credentialPart?: 'username' | 'password';
  signals: WorkflowSignal[];
  requiresConfirmation: boolean;
  // Only happens sometimes (a consent dialog, a cookie banner): when its
  // element isn't on the page the run skips it; when it is, the step runs.
  // Set only by the person, from the Fix screen.
  optional: boolean;
  snapshotPath?: string;
}

export type WorkflowFieldKind = 'text' | 'option' | 'file';

export interface WorkflowField {
  id: string;
  workflowId: string;
  key: string;
  label: string;
  kind: WorkflowFieldKind;
  secret: boolean;
  recordedValue?: string; // only for non-secret fields
  required: boolean;
  position: number;
  createdAt: string;
}

export type WorkflowRunTrigger = 'manual' | 'schedule' | 'chat';
export type WorkflowRunStatus =
  | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'needs_attention';

export interface WorkflowRun {
  id: string;
  workflowId: string;
  versionId: string;
  siteAgentId: string;
  trigger: WorkflowRunTrigger;
  status: WorkflowRunStatus;
  inputs: Record<string, string>; // non-secret field values only, by field key
  failedStepKey?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  browserShown?: boolean; // run:finished only: its window came forward during the run
}

// A run that stopped because a step's element couldn't be found, and what
// can be done about it. Plain words only: never a locator or step key.
export interface WorkflowRunRepair {
  live: boolean; // the run's window is still open, waiting at the stopped step
  fixed: boolean; // a repair from this run has been saved
  fixedBy?: 'pointing' | 'optional'; // how: shown where it is, or marked as not always appearing
  canFix: boolean; // "Show me where it is"
  whyNot?: string; // when it can't be fixed from here
  canMarkOptional: boolean; // "This doesn't always appear"
  // Said before marking a step that looks like it sends the form: a run
  // where it's missing would finish without sending.
  optionalCaution?: string;
  // Where "Show me where it is" has got to; unset when nothing is happening.
  phase?: 'opening' | 'browsing' | 'picking' | 'checking' | 'saving' | 'failed';
  problem?: string; // the last thing that went wrong while pointing
  explanation: string; // what it got as far as, what it couldn't find, what didn't happen
  askText: string; // what "Ask the agent" puts in the chat
  hasScreenshot: boolean;
  // No picture yet, but the run's window is still open: "Show the page" can
  // take one (a run in its minimized window can't take it when it stops).
  canTakePicture: boolean;
}

export type WorkflowRunStepStatus = 'ok' | 'failed' | 'skipped' | 'repaired';
export type WorkflowStepResolvedBy = 'primary' | 'fallback' | 'human';

export interface WorkflowRunStep {
  id: string;
  runId: string;
  stepKey: string;
  position: number;
  status: WorkflowRunStepStatus;
  resolvedBy?: WorkflowStepResolvedBy;
  durationMs?: number;
  url?: string;
  error?: string;
  screenshotPath?: string;
  createdAt: string;
}

// ── Workflow recorder ─────────────────────────────────────────────────────

// Credentials of this provider hold a site sign-in captured while recording:
// encrypted JSON { username?: string, password: string }.
export const SITE_LOGIN_PROVIDER = 'site_login';

// recording → (Done) → review → (Save) → saved, or → discarded at any point
// before saving. 'empty' is a Done with no steps; nothing is shown or saved.
export type RecordingState =
  | 'recording' | 'browser_closed' | 'finishing' | 'review' | 'saving' | 'saved' | 'empty' | 'discarded' | 'failed';

export interface RecordingStatus {
  id: string;
  siteKey: string;
  siteName: string;
  siteIcon?: string; // the site's favicon, once the recording has read it
  startUrl: string;
  state: RecordingState;
  stepCount: number; // steps the user took; the opening page load isn't counted
  error?: string;
  draft?: RecordingDraft; // set while state is 'review'
  result?: RecordingResult; // set once saved
}

// What the review screen shows before anything is saved.
export interface RecordingDraft {
  siteKey: string;
  stepCount: number;
  suggestedName: string; // from the page's heading or title; a dated fallback otherwise
  values: RecordedValue[]; // steps carrying a value the person chose; never sign-in steps
  steps: RecordedStepSummary[]; // every step, including the opening page load
  usesSavedLogin: boolean; // a sign-in was typed; it's saved to the Vault, not listed
}

export type RecordedValueKind = 'text' | 'option' | 'option-click';
export type RecordedValueMode = 'changes' | 'fixed';

export interface RecordedValue {
  stepKey: string;
  kind: RecordedValueKind; // typed text, a dropdown choice, or a clicked option in a list
  value: string;
  label: string; // the field's label from the page
  defaultMode: RecordedValueMode; // typed text: changes; choices: fixed
  canChange: boolean; // false when the step can't take a different value at run time
}

export interface RecordedValueChoice {
  stepKey: string;
  mode: RecordedValueMode;
  secret: boolean;
}

export interface SaveRecordingRequest {
  name: string;
  values: RecordedValueChoice[]; // rows left out keep their default, not secret
}

// One captured step, as the review screen shows it.
export interface RecordedStepSummary {
  stepKey: string;
  position: number;
  action: WorkflowStepAction;
  description: string; // plain words, e.g. 'Typed "ABC Roofing" into Insured name'
  value?: string; // the recorded value; never set for passwords or saved usernames
  usesSavedLogin?: 'username' | 'password';
}

export interface RecordingResult {
  siteAgent: SiteAgent;
  workflow: Workflow;
  version: WorkflowVersion;
  steps: RecordedStepSummary[];
  savedLogin: boolean; // a password was typed and stored in the vault
  fieldCount: number; // inputs created from the values marked "Changes"
}

// ── Run form ──────────────────────────────────────────────────────────────
// What the run form shows: the inputs to fill and the steps in plain words,
// grouped into phases. Built from the saved steps (no model). Field keys and
// step keys are here only to connect things; the screen never shows them.

// The Workflows list: one row per workflow, each with one line of state and
// the one thing to do next.
//   paused  → a run is waiting for the person (a code, a check)  → Continue
//   running → a run is going                                      → Open
//   stopped → the last run couldn't find something on the page   → Fix
//   idle    → nothing going on                                    → Run
export type WorkflowRowState = 'paused' | 'running' | 'stopped' | 'idle';

export interface WorkflowRow {
  id: string;
  siteAgentId: string;
  name: string; // without the site's name in front: the list's header carries it
  // No icon of its own: a row shows its site's favicon (SiteSummary.favicon).
  state: WorkflowRowState;
  stateText: string; // "Running now, step 4 of 9"
  runId?: string; // the run Continue / Open / Fix goes to
}

// A site in the picker. attention replaces the domain when something there
// needs the person ("Needs you: type the code from your email").
export interface SiteSummary {
  id: string;
  siteKey: string; // the domain shown under the name
  name: string;
  icon: string; // emoji, shown when there's no favicon
  favicon?: string; // URL of the site's own icon, stored locally
  startUrl: string;
  workflowCount: number;
  attention?: string;
  lastActivity?: string; // newest run or workflow change, ISO
}

export interface WorkflowsOverview {
  sites: SiteSummary[];
  workflows: WorkflowRow[];
}

export interface RunFormField {
  key: string;
  label: string;
  kind: WorkflowFieldKind;
  secret: boolean;
  required: boolean;
  // The previous run's value, else the value used while recording. Never
  // set for secret fields: those are never stored or sent back.
  previousValue?: string;
}

// A step sentence: plain text, with the run's value dropped in where a
// field's value lands.
export type PlanSegment = { text: string } | { field: string };

export interface PlanStep {
  stepKey: string;
  segments: PlanSegment[];
  pause?: 'handoff' | 'confirm'; // stops and waits for the person
  optional?: boolean; // skipped when it isn't on the page
}

export interface PlanPhase {
  title: string;
  note?: string; // e.g. "Skipped when you're already signed in"
  steps: PlanStep[];
}

export interface RunForm {
  workflow: { id: string; name: string; siteName: string; siteKey: string };
  lastRun?: { startedAt: string; finishedAt?: string; status: WorkflowRunStatus };
  fields: RunFormField[];
  phases: PlanPhase[];
}
