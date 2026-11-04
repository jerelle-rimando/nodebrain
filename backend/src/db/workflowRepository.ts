import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbGet, dbAll, dbTransaction } from './database';
import { encryptValue, decryptValue } from '../vault/credentialVault';
import {
  WORKFLOW_VALUE_PLACEHOLDER,
  type SiteAgent, type Workflow, type WorkflowVersion, type WorkflowVersionReason,
  type WorkflowStep, type WorkflowStepAction, type WorkflowValueSource, type WorkflowValueTarget,
  type WorkflowStepFingerprint, type WorkflowSignal, type WorkflowField, type WorkflowFieldKind,
  type WorkflowRun, type WorkflowRunTrigger, type WorkflowRunStatus,
  type WorkflowRunStep, type WorkflowRunStepStatus, type WorkflowStepResolvedBy,
} from '../../shared-types';

// Repository for recorded browser workflows (tables in workflowSchema.ts).
//
// Integrity lives here because the schema has no FOREIGN KEY or CHECK
// clauses: enum values are validated on write, references are checked on
// write, and deletes cascade in code inside a transaction.
//
// Secrets: a secret step literal or secret field value is encrypted with the
// credential vault's encryptValue() into a `*_enc` column and its plaintext
// column stays NULL. Read models expose only the flag; plaintext comes out
// solely through getStepLiteralValue / getFieldRecordedValue.

const STEP_ACTIONS: readonly WorkflowStepAction[] = [
  'navigate', 'click', 'fill', 'press', 'select', 'check', 'uncheck', 'upload', 'hover', 'handoff',
];
const VALUE_SOURCES: readonly WorkflowValueSource[] = ['none', 'literal', 'field', 'credential'];
const VALUE_TARGETS: readonly WorkflowValueTarget[] = ['text', 'option', 'locator', 'file'];
const VERSION_REASONS: readonly WorkflowVersionReason[] = ['recorded', 'repair', 'edit', 'rollback'];
const FIELD_KINDS: readonly WorkflowFieldKind[] = ['text', 'option', 'file'];
const RUN_TRIGGERS: readonly WorkflowRunTrigger[] = ['manual', 'schedule', 'chat'];
const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'pending', 'running', 'completed', 'failed', 'cancelled', 'needs_attention',
];
const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'completed', 'failed', 'cancelled', 'needs_attention',
];
const RUN_STEP_STATUSES: readonly WorkflowRunStepStatus[] = ['ok', 'failed', 'skipped', 'repaired'];
const RESOLVED_BY: readonly WorkflowStepResolvedBy[] = ['primary', 'fallback', 'human'];
const CREDENTIAL_PARTS = ['username', 'password'] as const;

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${what}: ${String(value)}`);
  }
}

const now = () => new Date().toISOString();

// ── Rows ────────────────────────────────────────────────────────────────────

interface SiteAgentRow {
  id: string; site_key: string; name: string; emoji: string | null; start_url: string;
  credential_id: string | null; profile_dir: string | null; created_at: string; updated_at: string;
}

interface WorkflowRow {
  id: string; site_agent_id: string; name: string; description: string;
  current_version_id: string | null; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; workflow_id: string; number: number; parent_version_id: string | null;
  reason: string; repaired_step_key: string | null; from_run_id: string | null; created_at: string;
}

interface StepRow {
  id: string; version_id: string; step_key: string; position: number; action: string;
  locator: string | null; fingerprint: string; page_alias: string; origin: string | null;
  args: string; value_source: string; value_target: string | null;
  literal_value: string | null; literal_value_enc: string | null; literal_secret: number;
  field_id: string | null; credential_part: string | null; signals: string;
  requires_confirmation: number; snapshot_path: string | null;
}

interface FieldRow {
  id: string; workflow_id: string; key: string; label: string; kind: string; secret: number;
  recorded_value: string | null; recorded_value_enc: string | null; required: number;
  position: number; created_at: string;
}

interface RunRow {
  id: string; workflow_id: string; version_id: string; site_agent_id: string; trigger: string;
  status: string; inputs: string; failed_step_key: string | null; error: string | null;
  started_at: string; finished_at: string | null;
}

interface RunStepRow {
  id: string; run_id: string; step_key: string; position: number; status: string;
  resolved_by: string | null; duration_ms: number | null; url: string | null; error: string | null;
  screenshot_path: string | null; created_at: string;
}

function rowToSiteAgent(row: SiteAgentRow): SiteAgent {
  return {
    id: row.id, siteKey: row.site_key, name: row.name, emoji: row.emoji ?? undefined,
    startUrl: row.start_url, credentialId: row.credential_id ?? undefined,
    profileDir: row.profile_dir ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function rowToWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id, siteAgentId: row.site_agent_id, name: row.name, description: row.description,
    currentVersionId: row.current_version_id ?? undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): WorkflowVersion {
  return {
    id: row.id, workflowId: row.workflow_id, number: row.number,
    parentVersionId: row.parent_version_id ?? undefined,
    reason: row.reason as WorkflowVersionReason,
    repairedStepKey: row.repaired_step_key ?? undefined,
    fromRunId: row.from_run_id ?? undefined, createdAt: row.created_at,
  };
}

function rowToStep(row: StepRow): WorkflowStep {
  return {
    id: row.id, versionId: row.version_id, stepKey: row.step_key, position: row.position,
    action: row.action as WorkflowStepAction, locator: row.locator ?? undefined,
    fingerprint: JSON.parse(row.fingerprint) as WorkflowStepFingerprint,
    pageAlias: row.page_alias, origin: row.origin ?? undefined,
    args: JSON.parse(row.args) as Record<string, unknown>,
    valueSource: row.value_source as WorkflowValueSource,
    valueTarget: (row.value_target ?? undefined) as WorkflowValueTarget | undefined,
    // literal_value is NULL for secret literals, so this never carries a secret.
    literalValue: row.literal_value ?? undefined,
    literalSecret: row.literal_secret === 1,
    fieldId: row.field_id ?? undefined,
    credentialPart: (row.credential_part ?? undefined) as WorkflowStep['credentialPart'],
    signals: JSON.parse(row.signals) as WorkflowSignal[],
    requiresConfirmation: row.requires_confirmation === 1,
    snapshotPath: row.snapshot_path ?? undefined,
  };
}

function rowToField(row: FieldRow): WorkflowField {
  return {
    id: row.id, workflowId: row.workflow_id, key: row.key, label: row.label,
    kind: row.kind as WorkflowFieldKind, secret: row.secret === 1,
    // recorded_value is NULL for secret fields.
    recordedValue: row.recorded_value ?? undefined,
    required: row.required === 1, position: row.position, createdAt: row.created_at,
  };
}

function rowToRun(row: RunRow): WorkflowRun {
  return {
    id: row.id, workflowId: row.workflow_id, versionId: row.version_id,
    siteAgentId: row.site_agent_id, trigger: row.trigger as WorkflowRunTrigger,
    status: row.status as WorkflowRunStatus,
    inputs: JSON.parse(row.inputs) as Record<string, string>,
    failedStepKey: row.failed_step_key ?? undefined, error: row.error ?? undefined,
    startedAt: row.started_at, finishedAt: row.finished_at ?? undefined,
  };
}

function rowToRunStep(row: RunStepRow): WorkflowRunStep {
  return {
    id: row.id, runId: row.run_id, stepKey: row.step_key, position: row.position,
    status: row.status as WorkflowRunStepStatus,
    resolvedBy: (row.resolved_by ?? undefined) as WorkflowStepResolvedBy | undefined,
    durationMs: row.duration_ms ?? undefined, url: row.url ?? undefined,
    error: row.error ?? undefined, screenshotPath: row.screenshot_path ?? undefined,
    createdAt: row.created_at,
  };
}

// ── Secret routing ──────────────────────────────────────────────────────────

// Splits a value into its (plaintext, ciphertext) column pair.
function splitSecret(value: string | undefined, secret: boolean): [string | null, string | null] {
  if (value === undefined) return [null, null];
  return secret ? [null, encryptValue(value)] : [value, null];
}

// ── Site agents ─────────────────────────────────────────────────────────────

export interface SiteAgentInput {
  siteKey: string;
  name: string;
  emoji?: string;
  startUrl: string;
  credentialId?: string;
  profileDir?: string;
}

export function getAllSiteAgents(): SiteAgent[] {
  return dbAll<SiteAgentRow>('SELECT * FROM site_agents ORDER BY created_at DESC').map(rowToSiteAgent);
}

export function getSiteAgentById(id: string): SiteAgent | null {
  const row = dbGet<SiteAgentRow>('SELECT * FROM site_agents WHERE id = ?', [id]);
  return row ? rowToSiteAgent(row) : null;
}

export function getSiteAgentBySiteKey(siteKey: string): SiteAgent | null {
  const row = dbGet<SiteAgentRow>('SELECT * FROM site_agents WHERE site_key = ?', [siteKey]);
  return row ? rowToSiteAgent(row) : null;
}

export function createSiteAgent(input: SiteAgentInput): SiteAgent {
  const ts = now();
  const agent: SiteAgent = { id: uuidv4(), ...input, createdAt: ts, updatedAt: ts };
  dbRun(
    `INSERT INTO site_agents (id, site_key, name, emoji, start_url, credential_id, profile_dir, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [agent.id, agent.siteKey, agent.name, agent.emoji ?? null, agent.startUrl,
     agent.credentialId ?? null, agent.profileDir ?? null, agent.createdAt, agent.updatedAt],
  );
  return agent;
}

// siteKey is the identity and isn't updatable: a different site is a different agent.
export function updateSiteAgent(
  id: string, updates: Partial<Omit<SiteAgentInput, 'siteKey'>>,
): SiteAgent | null {
  const existing = getSiteAgentById(id);
  if (!existing) return null;
  const updated: SiteAgent = { ...existing, ...updates, id, siteKey: existing.siteKey, updatedAt: now() };
  dbRun(
    `UPDATE site_agents SET name=?, emoji=?, start_url=?, credential_id=?, profile_dir=?, updated_at=? WHERE id=?`,
    [updated.name, updated.emoji ?? null, updated.startUrl, updated.credentialId ?? null,
     updated.profileDir ?? null, updated.updatedAt, id],
  );
  return updated;
}

// Cascades to the agent's workflows (and their versions, steps, fields, runs).
// The login credential is left in the vault: it is the user's, and the vault
// page is where credentials are deleted. The browser profile folder on disk
// is not touched either; the caller owns files.
export function deleteSiteAgent(id: string): boolean {
  if (!getSiteAgentById(id)) return false;
  dbTransaction(() => {
    const workflows = dbAll<{ id: string }>('SELECT id FROM workflows WHERE site_agent_id = ?', [id]);
    for (const wf of workflows) deleteWorkflowRows(wf.id);
    dbRun('DELETE FROM site_agents WHERE id = ?', [id]);
  });
  return true;
}

// ── Workflows ───────────────────────────────────────────────────────────────

export function getWorkflowsBySiteAgent(siteAgentId: string): Workflow[] {
  return dbAll<WorkflowRow>(
    'SELECT * FROM workflows WHERE site_agent_id = ? ORDER BY created_at DESC', [siteAgentId],
  ).map(rowToWorkflow);
}

export function getAllWorkflows(): Workflow[] {
  return dbAll<WorkflowRow>('SELECT * FROM workflows ORDER BY created_at DESC').map(rowToWorkflow);
}

export function getWorkflowById(id: string): Workflow | null {
  const row = dbGet<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [id]);
  return row ? rowToWorkflow(row) : null;
}

// Creates the workflow with no version. Recording then adds fields
// (createField) and the first version (createVersion, reason 'recorded'),
// usually inside one dbTransaction.
export function createWorkflow(input: { siteAgentId: string; name: string; description?: string }): Workflow {
  if (!getSiteAgentById(input.siteAgentId)) {
    throw new Error(`Site agent not found: ${input.siteAgentId}`);
  }
  const ts = now();
  const wf: Workflow = {
    id: uuidv4(), siteAgentId: input.siteAgentId, name: input.name,
    description: input.description ?? '', createdAt: ts, updatedAt: ts,
  };
  dbRun(
    `INSERT INTO workflows (id, site_agent_id, name, description, current_version_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    [wf.id, wf.siteAgentId, wf.name, wf.description, wf.createdAt, wf.updatedAt],
  );
  return wf;
}

export function updateWorkflow(id: string, updates: { name?: string; description?: string }): Workflow | null {
  const existing = getWorkflowById(id);
  if (!existing) return null;
  const updated: Workflow = { ...existing, ...updates, id, updatedAt: now() };
  dbRun('UPDATE workflows SET name=?, description=?, updated_at=? WHERE id=?',
    [updated.name, updated.description, updated.updatedAt, id]);
  return updated;
}

// Cascades to versions, steps, fields, runs and run steps.
export function deleteWorkflow(id: string): boolean {
  if (!getWorkflowById(id)) return false;
  dbTransaction(() => deleteWorkflowRows(id));
  return true;
}

function deleteWorkflowRows(workflowId: string): void {
  dbRun('DELETE FROM workflow_run_steps WHERE run_id IN (SELECT id FROM workflow_runs WHERE workflow_id = ?)', [workflowId]);
  dbRun('DELETE FROM workflow_runs WHERE workflow_id = ?', [workflowId]);
  dbRun('DELETE FROM workflow_steps WHERE version_id IN (SELECT id FROM workflow_versions WHERE workflow_id = ?)', [workflowId]);
  dbRun('DELETE FROM workflow_versions WHERE workflow_id = ?', [workflowId]);
  dbRun('DELETE FROM workflow_fields WHERE workflow_id = ?', [workflowId]);
  dbRun('DELETE FROM workflows WHERE id = ?', [workflowId]);
}

// ── Fields ──────────────────────────────────────────────────────────────────

export interface FieldInput {
  key: string;
  label: string;
  kind?: WorkflowFieldKind;
  secret?: boolean;
  recordedValue?: string; // plaintext in; encrypted on write when secret
  required?: boolean;
  position: number;
}

export function getFieldsByWorkflow(workflowId: string): WorkflowField[] {
  return dbAll<FieldRow>(
    'SELECT * FROM workflow_fields WHERE workflow_id = ? ORDER BY position ASC', [workflowId],
  ).map(rowToField);
}

export function getFieldById(id: string): WorkflowField | null {
  const row = dbGet<FieldRow>('SELECT * FROM workflow_fields WHERE id = ?', [id]);
  return row ? rowToField(row) : null;
}

// The recorded value in plaintext, decrypted if the field is secret.
export function getFieldRecordedValue(id: string): string | null {
  const row = dbGet<Pick<FieldRow, 'recorded_value' | 'recorded_value_enc'>>(
    'SELECT recorded_value, recorded_value_enc FROM workflow_fields WHERE id = ?', [id],
  );
  if (!row) return null;
  if (row.recorded_value_enc !== null) return decryptValue(row.recorded_value_enc);
  return row.recorded_value;
}

export function createField(workflowId: string, input: FieldInput): WorkflowField {
  if (!getWorkflowById(workflowId)) throw new Error(`Workflow not found: ${workflowId}`);
  const kind = input.kind ?? 'text';
  assertOneOf(kind, FIELD_KINDS, 'field kind');
  const secret = input.secret ?? false;
  const [plain, enc] = splitSecret(input.recordedValue, secret);
  const id = uuidv4();
  const createdAt = now();
  dbRun(
    `INSERT INTO workflow_fields (id, workflow_id, key, label, kind, secret, recorded_value, recorded_value_enc, required, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workflowId, input.key, input.label, kind, secret ? 1 : 0, plain, enc,
     (input.required ?? true) ? 1 : 0, input.position, createdAt],
  );
  return getFieldById(id)!;
}

// Changing `secret` moves the recorded value between the plaintext and
// ciphertext columns. It does not touch steps or past runs.
export function updateField(id: string, updates: Partial<FieldInput>): WorkflowField | null {
  const existing = getFieldById(id);
  if (!existing) return null;
  const kind = updates.kind ?? existing.kind;
  assertOneOf(kind, FIELD_KINDS, 'field kind');
  const secret = updates.secret ?? existing.secret;
  const value = 'recordedValue' in updates ? updates.recordedValue : (getFieldRecordedValue(id) ?? undefined);
  const [plain, enc] = splitSecret(value, secret);
  dbRun(
    `UPDATE workflow_fields SET key=?, label=?, kind=?, secret=?, recorded_value=?, recorded_value_enc=?, required=?, position=? WHERE id=?`,
    [updates.key ?? existing.key, updates.label ?? existing.label, kind, secret ? 1 : 0, plain, enc,
     (updates.required ?? existing.required) ? 1 : 0, updates.position ?? existing.position, id],
  );
  return getFieldById(id);
}

// Refused while any version's step uses the field: deleting it would make
// those versions unrunnable, including ones a rollback could return to.
export function deleteField(id: string): boolean {
  if (!getFieldById(id)) return false;
  const used = dbGet<{ n: number }>('SELECT COUNT(*) AS n FROM workflow_steps WHERE field_id = ?', [id]);
  if (used && used.n > 0) {
    throw new Error(`Field ${id} is used by ${used.n} step(s) and can't be deleted`);
  }
  dbRun('DELETE FROM workflow_fields WHERE id = ?', [id]);
  return true;
}

// ── Steps ───────────────────────────────────────────────────────────────────

// A step as written by the recorder or the marking UI. literalValue is
// plaintext in; when literalSecret is set it is encrypted on write.
export interface StepInput {
  stepKey: string;
  position: number;
  action: WorkflowStepAction;
  locator?: string;
  fingerprint?: WorkflowStepFingerprint;
  pageAlias?: string;
  origin?: string;
  args?: Record<string, unknown>;
  valueSource?: WorkflowValueSource;
  valueTarget?: WorkflowValueTarget;
  literalValue?: string;
  literalSecret?: boolean;
  fieldId?: string;
  credentialPart?: 'username' | 'password';
  signals?: WorkflowSignal[];
  requiresConfirmation?: boolean;
  snapshotPath?: string;
}

// Changes to a step when deriving a new version. Omitted keys keep the old
// value; a key present with `undefined` clears it.
export type StepPatch = Partial<Omit<StepInput, 'stepKey'>>;

type StepColumns = Omit<StepRow, 'id' | 'version_id'>;

function inputToColumns(input: StepInput): StepColumns {
  const secret = input.literalSecret ?? false;
  const [plain, enc] = splitSecret(input.literalValue, secret);
  return {
    step_key: input.stepKey,
    position: input.position,
    action: input.action,
    locator: input.locator ?? null,
    fingerprint: JSON.stringify(input.fingerprint ?? {}),
    page_alias: input.pageAlias ?? 'page',
    origin: input.origin ?? null,
    args: JSON.stringify(input.args ?? {}),
    value_source: input.valueSource ?? 'none',
    value_target: input.valueTarget ?? null,
    literal_value: plain,
    literal_value_enc: enc,
    literal_secret: secret ? 1 : 0,
    field_id: input.fieldId ?? null,
    credential_part: input.credentialPart ?? null,
    signals: JSON.stringify(input.signals ?? []),
    requires_confirmation: input.requiresConfirmation ? 1 : 0,
    snapshot_path: input.snapshotPath ?? null,
  };
}

// Applies a patch to stored columns. Untouched secret literals are carried
// over as ciphertext, without decrypting.
function patchColumns(cols: StepColumns, patch: StepPatch): StepColumns {
  const out: StepColumns = { ...cols };
  const has = (k: keyof StepPatch) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has('position')) out.position = patch.position!;
  if (has('action')) out.action = patch.action!;
  if (has('locator')) out.locator = patch.locator ?? null;
  if (has('fingerprint')) out.fingerprint = JSON.stringify(patch.fingerprint ?? {});
  if (has('pageAlias')) out.page_alias = patch.pageAlias ?? 'page';
  if (has('origin')) out.origin = patch.origin ?? null;
  if (has('args')) out.args = JSON.stringify(patch.args ?? {});
  if (has('valueSource')) out.value_source = patch.valueSource ?? 'none';
  if (has('valueTarget')) out.value_target = patch.valueTarget ?? null;
  if (has('fieldId')) out.field_id = patch.fieldId ?? null;
  if (has('credentialPart')) out.credential_part = patch.credentialPart ?? null;
  if (has('signals')) out.signals = JSON.stringify(patch.signals ?? []);
  if (has('requiresConfirmation')) out.requires_confirmation = patch.requiresConfirmation ? 1 : 0;
  if (has('snapshotPath')) out.snapshot_path = patch.snapshotPath ?? null;
  if (has('literalValue') || has('literalSecret')) {
    const secret = has('literalSecret') ? !!patch.literalSecret : cols.literal_secret === 1;
    const value = has('literalValue') ? patch.literalValue : literalPlaintext(cols);
    const [plain, enc] = splitSecret(value, secret);
    out.literal_value = plain;
    out.literal_value_enc = enc;
    out.literal_secret = secret ? 1 : 0;
  }
  return out;
}

function literalPlaintext(cols: Pick<StepColumns, 'literal_value' | 'literal_value_enc'>): string | undefined {
  if (cols.literal_value_enc !== null) return decryptValue(cols.literal_value_enc);
  return cols.literal_value ?? undefined;
}

// Validates one step against the workflow's fields. Throws on the first problem.
function validateStep(cols: StepColumns, fieldsById: Map<string, FieldRow>): void {
  const where = `step ${cols.step_key}`;
  assertOneOf(cols.action, STEP_ACTIONS, `action on ${where}`);
  assertOneOf(cols.value_source, VALUE_SOURCES, `value source on ${where}`);
  if (cols.value_target !== null) assertOneOf(cols.value_target, VALUE_TARGETS, `value target on ${where}`);

  const hasLiteral = cols.literal_value !== null || cols.literal_value_enc !== null;
  if (cols.literal_secret === 1 && cols.literal_value !== null) {
    throw new Error(`${where}: secret literal has a plaintext value`);
  }
  if (cols.value_source !== 'literal' && hasLiteral) {
    throw new Error(`${where}: literal value set but value source is ${cols.value_source}`);
  }
  if (cols.value_source !== 'field' && cols.field_id !== null) {
    throw new Error(`${where}: field set but value source is ${cols.value_source}`);
  }
  if (cols.value_source !== 'credential' && cols.credential_part !== null) {
    throw new Error(`${where}: credential part set but value source is ${cols.value_source}`);
  }

  switch (cols.value_source) {
    case 'none':
      if (cols.value_target !== null) throw new Error(`${where}: value target set with no value`);
      break;
    case 'literal':
      if (!hasLiteral) throw new Error(`${where}: literal value source with no value`);
      break;
    case 'field':
      if (cols.field_id === null || !fieldsById.has(cols.field_id)) {
        throw new Error(`${where}: field ${cols.field_id} doesn't belong to this workflow`);
      }
      break;
    case 'credential':
      assertOneOf(cols.credential_part, CREDENTIAL_PARTS, `credential part on ${where}`);
      if (cols.value_target !== 'text') throw new Error(`${where}: credentials can only be typed`);
      break;
  }
  if (cols.value_source !== 'none' && cols.value_target === null) {
    throw new Error(`${where}: value source ${cols.value_source} needs a value target`);
  }

  // A value bound into a click locator: the locator is stored as a template,
  // so the recorded value (possibly secret) isn't baked into it.
  if (cols.value_target === 'locator' && !(cols.locator ?? '').includes(WORKFLOW_VALUE_PLACEHOLDER)) {
    throw new Error(`${where}: locator-bound value needs ${WORKFLOW_VALUE_PLACEHOLDER} in the locator`);
  }

  // Catch a secret recorded into the locator or fingerprint in plaintext
  // (the recorder captures the option text verbatim).
  let secretValue: string | undefined;
  if (cols.literal_secret === 1) secretValue = literalPlaintext(cols);
  if (cols.value_source === 'field' && cols.field_id !== null) {
    const f = fieldsById.get(cols.field_id)!;
    if (f.secret === 1 && f.recorded_value_enc !== null) secretValue = decryptValue(f.recorded_value_enc);
  }
  if (secretValue) {
    if ((cols.locator ?? '').includes(secretValue) || cols.fingerprint.includes(secretValue)
        || cols.args.includes(secretValue)) {
      throw new Error(`${where}: secret value appears in plaintext in the locator, fingerprint or args`);
    }
  }
}

function insertSteps(versionId: string, workflowId: string, steps: StepColumns[]): void {
  const fields = dbAll<FieldRow>('SELECT * FROM workflow_fields WHERE workflow_id = ?', [workflowId]);
  const fieldsById = new Map(fields.map((f) => [f.id, f]));
  const keys = new Set<string>();
  for (const s of steps) {
    if (keys.has(s.step_key)) throw new Error(`Duplicate step key: ${s.step_key}`);
    keys.add(s.step_key);
    validateStep(s, fieldsById);
  }
  for (const s of steps) {
    dbRun(
      `INSERT INTO workflow_steps (id, version_id, step_key, position, action, locator, fingerprint, page_alias, origin, args,
         value_source, value_target, literal_value, literal_value_enc, literal_secret, field_id, credential_part, signals,
         requires_confirmation, snapshot_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), versionId, s.step_key, s.position, s.action, s.locator, s.fingerprint, s.page_alias, s.origin, s.args,
       s.value_source, s.value_target, s.literal_value, s.literal_value_enc, s.literal_secret, s.field_id,
       s.credential_part, s.signals, s.requires_confirmation, s.snapshot_path],
    );
  }
}

export function getStepsByVersion(versionId: string): WorkflowStep[] {
  return dbAll<StepRow>(
    'SELECT * FROM workflow_steps WHERE version_id = ? ORDER BY position ASC', [versionId],
  ).map(rowToStep);
}

export function getCurrentSteps(workflowId: string): WorkflowStep[] {
  const wf = getWorkflowById(workflowId);
  return wf?.currentVersionId ? getStepsByVersion(wf.currentVersionId) : [];
}

// One step across every version that has it, newest version first.
export function getStepHistory(workflowId: string, stepKey: string): Array<{ version: WorkflowVersion; step: WorkflowStep }> {
  const rows = dbAll<StepRow & { v_number: number }>(
    `SELECT s.*, v.number AS v_number FROM workflow_steps s
     JOIN workflow_versions v ON v.id = s.version_id
     WHERE v.workflow_id = ? AND s.step_key = ? ORDER BY v.number DESC`,
    [workflowId, stepKey],
  );
  return rows.map((row) => ({ version: getVersionById(row.version_id)!, step: rowToStep(row) }));
}

// The literal in plaintext, decrypted if secret. null when the step has none.
export function getStepLiteralValue(stepId: string): string | null {
  const row = dbGet<Pick<StepRow, 'literal_value' | 'literal_value_enc'>>(
    'SELECT literal_value, literal_value_enc FROM workflow_steps WHERE id = ?', [stepId],
  );
  if (!row) return null;
  return literalPlaintext(row) ?? null;
}

// ── Versions ────────────────────────────────────────────────────────────────

export function getVersionsByWorkflow(workflowId: string): WorkflowVersion[] {
  return dbAll<VersionRow>(
    'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY number DESC', [workflowId],
  ).map(rowToVersion);
}

export function getVersionById(id: string): WorkflowVersion | null {
  const row = dbGet<VersionRow>('SELECT * FROM workflow_versions WHERE id = ?', [id]);
  return row ? rowToVersion(row) : null;
}

export function getCurrentVersion(workflowId: string): WorkflowVersion | null {
  const wf = getWorkflowById(workflowId);
  return wf?.currentVersionId ? getVersionById(wf.currentVersionId) : null;
}

interface VersionMeta {
  reason: WorkflowVersionReason;
  repairedStepKey?: string;
  fromRunId?: string;
}

// Inserts a version row and its steps and makes it current. Parent is the
// previous current version. Caller holds the transaction.
function writeVersion(workflowId: string, meta: VersionMeta, steps: StepColumns[]): WorkflowVersion {
  assertOneOf(meta.reason, VERSION_REASONS, 'version reason');
  const wf = getWorkflowById(workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
  const last = dbGet<{ n: number | null }>(
    'SELECT MAX(number) AS n FROM workflow_versions WHERE workflow_id = ?', [workflowId],
  );
  const version: WorkflowVersion = {
    id: uuidv4(), workflowId, number: (last?.n ?? 0) + 1,
    parentVersionId: wf.currentVersionId, reason: meta.reason,
    repairedStepKey: meta.repairedStepKey, fromRunId: meta.fromRunId, createdAt: now(),
  };
  dbRun(
    `INSERT INTO workflow_versions (id, workflow_id, number, parent_version_id, reason, repaired_step_key, from_run_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [version.id, workflowId, version.number, version.parentVersionId ?? null, version.reason,
     version.repairedStepKey ?? null, version.fromRunId ?? null, version.createdAt],
  );
  insertSteps(version.id, workflowId, steps);
  dbRun('UPDATE workflows SET current_version_id=?, updated_at=? WHERE id=?', [version.id, version.createdAt, workflowId]);
  return version;
}

// A version from a full step list: the first recording, or a structural edit.
export function createVersion(workflowId: string, meta: VersionMeta, steps: StepInput[]): WorkflowVersion {
  return dbTransaction(() => writeVersion(workflowId, meta, steps.map(inputToColumns)));
}

// A new version from the current one with some steps changed: a repair
// (new locator/fingerprint for one step) or a marking edit (Changes /
// Always this). Every other step is copied as stored.
export function deriveVersion(
  workflowId: string, meta: VersionMeta, patches: Record<string, StepPatch>,
): WorkflowVersion {
  return dbTransaction(() => {
    const current = getCurrentVersion(workflowId);
    if (!current) throw new Error(`Workflow ${workflowId} has no version to derive from`);
    const rows = dbAll<StepRow>('SELECT * FROM workflow_steps WHERE version_id = ? ORDER BY position ASC', [current.id]);
    const known = new Set(rows.map((r) => r.step_key));
    for (const key of Object.keys(patches)) {
      if (!known.has(key)) throw new Error(`No step ${key} in version ${current.number}`);
    }
    const steps = rows.map(({ id: _id, version_id: _v, ...cols }) =>
      patches[cols.step_key] ? patchColumns(cols, patches[cols.step_key]) : cols);
    return writeVersion(workflowId, meta, steps);
  });
}

// Makes an older version current again, as a new 'rollback' version that
// copies its steps, so history stays linear and nothing is discarded.
export function rollbackToVersion(workflowId: string, versionId: string): WorkflowVersion {
  return dbTransaction(() => {
    const target = getVersionById(versionId);
    if (!target || target.workflowId !== workflowId) {
      throw new Error(`Version ${versionId} doesn't belong to workflow ${workflowId}`);
    }
    const rows = dbAll<StepRow>('SELECT * FROM workflow_steps WHERE version_id = ? ORDER BY position ASC', [versionId]);
    const steps = rows.map(({ id: _id, version_id: _v, ...cols }) => cols);
    return writeVersion(workflowId, { reason: 'rollback' }, steps);
  });
}

// ── Runs ────────────────────────────────────────────────────────────────────

// Starts a run against the workflow's current version. `inputs` is keyed by
// field key. Values for secret fields are dropped here and never stored: the
// caller passes them to the replayer in memory. Unknown keys are refused.
export function createRun(
  workflowId: string, trigger: WorkflowRunTrigger, inputs: Record<string, string>,
): WorkflowRun {
  assertOneOf(trigger, RUN_TRIGGERS, 'run trigger');
  const wf = getWorkflowById(workflowId);
  if (!wf) throw new Error(`Workflow not found: ${workflowId}`);
  if (!wf.currentVersionId) throw new Error(`Workflow ${workflowId} has no version to run`);
  const fields = new Map(getFieldsByWorkflow(workflowId).map((f) => [f.key, f]));
  const stored: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    const field = fields.get(key);
    if (!field) throw new Error(`Unknown input for workflow ${workflowId}: ${key}`);
    if (!field.secret) stored[key] = value;
  }
  const run: WorkflowRun = {
    id: uuidv4(), workflowId, versionId: wf.currentVersionId, siteAgentId: wf.siteAgentId,
    trigger, status: 'pending', inputs: stored, startedAt: now(),
  };
  dbRun(
    `INSERT INTO workflow_runs (id, workflow_id, version_id, site_agent_id, trigger, status, inputs, failed_step_key, error, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
    [run.id, run.workflowId, run.versionId, run.siteAgentId, run.trigger, run.status,
     JSON.stringify(run.inputs), run.startedAt],
  );
  return run;
}

export function getRunById(id: string): WorkflowRun | null {
  const row = dbGet<RunRow>('SELECT * FROM workflow_runs WHERE id = ?', [id]);
  return row ? rowToRun(row) : null;
}

export function getRunsByWorkflow(workflowId: string, limit = 100): WorkflowRun[] {
  return dbAll<RunRow>(
    'SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?', [workflowId, limit],
  ).map(rowToRun);
}

export function getRunsBySiteAgent(siteAgentId: string, limit = 100): WorkflowRun[] {
  return dbAll<RunRow>(
    'SELECT * FROM workflow_runs WHERE site_agent_id = ? ORDER BY started_at DESC LIMIT ?', [siteAgentId, limit],
  ).map(rowToRun);
}

// Sets finished_at on terminal statuses, mirroring updateTaskStatus.
export function updateRunStatus(
  id: string, status: WorkflowRunStatus, details: { error?: string; failedStepKey?: string } = {},
): void {
  assertOneOf(status, RUN_STATUSES, 'run status');
  const finishedAt = TERMINAL_RUN_STATUSES.includes(status) ? now() : null;
  dbRun('UPDATE workflow_runs SET status=?, error=?, failed_step_key=?, finished_at=? WHERE id=?',
    [status, details.error ?? null, details.failedStepKey ?? null, finishedAt, id]);
}

export interface RunStepInput {
  stepKey: string;
  position: number;
  status: WorkflowRunStepStatus;
  resolvedBy?: WorkflowStepResolvedBy;
  durationMs?: number;
  url?: string;
  error?: string;
  screenshotPath?: string;
}

export function addRunStep(runId: string, input: RunStepInput): WorkflowRunStep {
  assertOneOf(input.status, RUN_STEP_STATUSES, 'run step status');
  if (input.resolvedBy !== undefined) assertOneOf(input.resolvedBy, RESOLVED_BY, 'resolved by');
  if (!getRunById(runId)) throw new Error(`Run not found: ${runId}`);
  const step: WorkflowRunStep = { id: uuidv4(), runId, ...input, createdAt: now() };
  dbRun(
    `INSERT INTO workflow_run_steps (id, run_id, step_key, position, status, resolved_by, duration_ms, url, error, screenshot_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [step.id, runId, step.stepKey, step.position, step.status, step.resolvedBy ?? null,
     step.durationMs ?? null, step.url ?? null, step.error ?? null, step.screenshotPath ?? null, step.createdAt],
  );
  return step;
}

export function getRunSteps(runId: string): WorkflowRunStep[] {
  return dbAll<RunStepRow>(
    'SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY position ASC, created_at ASC', [runId],
  ).map(rowToRunStep);
}

// Startup reconciliation, same reasoning as reconcileOrphanedTasks: a run
// still 'running' or 'pending' at startup can't be live. Not wired into
// index.ts yet; that belongs with the engine.
export function reconcileOrphanedRuns(): number {
  const stale = dbAll<{ id: string }>("SELECT id FROM workflow_runs WHERE status IN ('running', 'pending')");
  if (stale.length === 0) return 0;
  dbRun(
    "UPDATE workflow_runs SET status='failed', error=?, finished_at=? WHERE status IN ('running', 'pending')",
    ['Interrupted — NodeBrain stopped before this finished.', now()],
  );
  return stale.length;
}
