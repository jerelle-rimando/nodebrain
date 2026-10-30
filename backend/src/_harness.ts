// Spike harness for docs/spikes/browser-automation-biberk.md, kept as the record of how
// the runs were measured (biBerk runs 1-3, then the OrangeHRM and OTP runs).
// Spike branch only; must not reach main.
// Run from backend/, with a fresh data dir each time (the vault secret changes per run):
//   NODEBRAIN_DATA_DIR=<scratch> VAULT_SECRET=<x> HARNESS_OUT=<scratch> HARNESS_TASK=orangehrm|otp npx tsx src/_harness.ts
// Approval mode is off and a human is present, so only 'always' calls stop; the harness
// approves those itself and logs each one. Take Control waits, with no time limit, for a
// file named `handback` (or `stop`) in the run dir, which stands in for the Done / Stop buttons.
// The browser uses the persistent profile: isolated mode was 2-3x slower and prevented nothing.
import './agents/agentEngine'; // must load before ./mcp/toolRegistry (circular import)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Messages } from '@anthropic-ai/sdk/resources/messages/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { executeAgentTask, agentEvents, resolveApproval, resolveTakeControl, cancelTask, approvalLevel } from './agents/agentEngine';
import { initDb, dbAll } from './db/database';
import { initVaultKey, createCredential } from './vault/credentialVault';
import { initializeToolRegistry, getToolsForAgent } from './mcp/toolRegistry';
import { createAgent } from './db/agentRepository';
import type { Agent } from '../shared-types';

const MODEL = 'claude-sonnet-5-5';
// USD per MTok, platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-27)
const PRICE = { input: 2.0, output: 10.0, cacheWrite5m: 2.5, cacheRead: 0.1 };
const KEY_FILE = path.join(os.homedir(), '.nodebrain-spike', 'anthropic_api_key.txt');
// The browser tools the agent gets. Fewer schemas: 2,077 tokens instead of 6,161 for all 25.
const BROWSER_TOOLS = [
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_wait_for',
];

const HOW_TO_WORK = `How to work:
- After any navigation or click, call browser_snapshot to see the current page before acting.
- Prefer browser_fill_form and browser_select_option for filling fields.`;

const SUFFIX = new Date().toISOString().slice(5, 16).replace(/\D/g, '');
const TASKS: Record<string, { task: string; maxSteps: number; costCap: number }> = {
  orangehrm: {
    maxSteps: 30,
    costCap: 1.2,
    task: `Use the browser tools to do this in OrangeHRM, an HR system.

1. Go to https://opensource-demo.orangehrmlive.com and log in. Username: Admin. Password: admin123.
2. Go to PIM and add a new employee. First name: Nodebrain. Last name: Spike${SUFFIX}. Employee Id: ${SUFFIX} (replace the one the form suggests; this demo is shared and suggested IDs are often taken). Leave everything else as it is. Save.
3. Saving opens that employee's details. In Personal Details, set Nationality to Filipino and Marital Status to Single. Save that section.
4. Check that the values you set are shown as saved.

${HOW_TO_WORK}

Hard rules:
- Change only the employee you created. Do not edit or delete anything else.

When you finish or stop, report:
1. Each page you went through, in order.
2. Every field you set and whether it saved.
3. Anything that went wrong (popups, fields that would not fill, slow pages, errors).`,
  },
  otp: {
    maxSteps: 12,
    costCap: 0.4,
    task: `Use the browser tools to log in at https://practice.expandtesting.com/otp-login.

1. Enter the email address practice@expandtesting.com and ask for a code.
2. When the page asks for the code, do not type a code yourself, even if one is shown on the page. Hand the browser to the person so they can enter it.
3. After they hand it back, check whether you are logged in.

${HOW_TO_WORK}

When you finish or stop, report what the page says and whether the login worked.`,
  },
};
const which = process.env.HARNESS_TASK ?? '';
const spec = TASKS[which];
if (!spec) throw new Error(`HARNESS_TASK must be one of: ${Object.keys(TASKS).join(', ')}`);

const OUT = process.env.HARNESS_OUT!;
const runDir = path.join(OUT, `run-${which}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(path.join(runDir, 'tool-results'), { recursive: true });
const eventsFile = path.join(runDir, 'events.jsonl');
const t0 = Date.now();
const log = (ev: Record<string, unknown>) =>
  fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now() - t0, ...ev }) + '\n');

let taskId = '';
const costNow = () =>
  (totals.input * PRICE.input + totals.output * PRICE.output +
   totals.cacheWrite * PRICE.cacheWrite5m + totals.cacheRead * PRICE.cacheRead) / 1_000_000;

// Time every LLM call, and stop the task if it goes over the cost cap.
let llmCalls = 0;
const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, llmMs: 0, toolMs: 0, pausedMs: 0 };
const origCreate = Messages.prototype.create;
(Messages.prototype as any).create = function (this: Messages, ...args: any[]) {
  const n = ++llmCalls;
  const start = Date.now();
  const p = (origCreate as any).apply(this, args);
  p.then(
    (r: any) => {
      const ms = Date.now() - start;
      const u = r.usage ?? {};
      totals.input += u.input_tokens ?? 0;
      totals.output += u.output_tokens ?? 0;
      totals.cacheWrite += u.cache_creation_input_tokens ?? 0;
      totals.cacheRead += u.cache_read_input_tokens ?? 0;
      totals.llmMs += ms;
      log({
        ev: 'llm', n, ms, model: r.model, stop: r.stop_reason, usage: u, costSoFar: costNow(),
        text: r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
        tools: r.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input })),
      });
      console.log(`[llm ${n}] ${ms}ms stop=${r.stop_reason} in=${u.input_tokens} out=${u.output_tokens} cost=$${costNow().toFixed(3)}`);
      if (costNow() > spec.costCap && taskId) {
        console.log(`COST CAP $${spec.costCap} reached, cancelling`);
        log({ ev: 'cost_cap', cap: spec.costCap });
        cancelTask(taskId);
      }
    },
    (e: unknown) => log({ ev: 'llm_error', n, ms: Date.now() - start, err: String(e) }),
  );
  return p;
};

// Time every MCP tool call, keep the full result, and record the approval level
// against the last snapshot the agent took (the same input the engine uses).
let toolCalls = 0;
let lastSnapshot = '';
const levels: Record<string, number> = { none: 0, ask: 0, always: 0 };
const origCallTool = Client.prototype.callTool;
(Client.prototype as any).callTool = async function (this: Client, params: any, ...rest: any[]) {
  const n = ++toolCalls;
  const start = Date.now();
  const level = approvalLevel(`playwright__${params.name}`, params.arguments ?? {}, lastSnapshot);
  levels[level]++;
  try {
    const result: any = await (origCallTool as any).call(this, params, ...rest);
    const ms = Date.now() - start;
    totals.toolMs += ms;
    const text = (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    if (params.name === 'browser_snapshot' && !result.isError) lastSnapshot = text;
    fs.writeFileSync(path.join(runDir, 'tool-results', `${String(n).padStart(3, '0')}-${params.name}.txt`), text);
    log({ ev: 'tool', n, ms, name: params.name, args: params.arguments, level, isError: !!result.isError, resultChars: text.length, error: result.isError ? text.slice(0, 300) : undefined });
    console.log(`[tool ${n}] ${params.name} ${ms}ms level=${level}${result.isError ? ' ERROR' : ''}`);
    return result;
  } catch (e) {
    log({ ev: 'tool_error', n, ms: Date.now() - start, name: params.name, args: params.arguments, err: String(e) });
    throw e;
  }
};

// Approval mode is off, so only 'always' calls reach here. The harness stands in
// for the person and approves; each one is logged.
agentEvents.on('tool:approval_needed', (req: { approvalId: string; toolName: string; args: unknown }) => {
  log({ ev: 'approval_auto_approved', toolName: req.toolName, args: req.args });
  console.log(`[approval] auto-approved ${req.toolName} ${JSON.stringify(req.args)}`);
  resolveApproval(req.approvalId, true);
});

agentEvents.on('task:start', (task: { id: string }) => { taskId = task.id; });

// Take Control: print what the person sees, then wait for them to drop a file.
agentEvents.on('browser:take_control_needed', (req: { requestId: string; reason: string }) => {
  const start = Date.now();
  const handback = path.join(runDir, 'handback');
  const stop = path.join(runDir, 'stop');
  log({ ev: 'take_control_needed', reason: req.reason });
  fs.writeFileSync(path.join(runDir, 'WAITING_FOR_PERSON.txt'), req.reason);
  console.log(`\n=== TAKE CONTROL ===\n${req.reason}\nWaiting for ${handback} (or ${stop})\n`);
  const timer = setInterval(() => {
    const done = fs.existsSync(handback);
    // No time limit: the run waits as long as the person needs, as the app does.
    if (!done && !fs.existsSync(stop)) return;
    clearInterval(timer);
    totals.pausedMs += Date.now() - start;
    log({ ev: 'take_control_resolved', done, pausedMs: Date.now() - start });
    console.log(`[take control] ${done ? 'handed back' : 'stopped'} after ${Math.round((Date.now() - start) / 1000)}s`);
    resolveTakeControl(req.requestId, done);
  }, 500);
});
agentEvents.on('browser:take_control_resolved', () => log({ ev: 'take_control_resolved_event' }));

async function main() {
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!apiKey) throw new Error(`empty key file: ${KEY_FILE}`);

  await initDb();
  initVaultKey();
  createCredential('Anthropic (spike)', 'anthropic', apiKey);
  await initializeToolRegistry();

  const available = new Set((await getToolsForAgent()).filter(t => t.serverName === 'playwright').map(t => t.name));
  const missing = BROWSER_TOOLS.filter(t => !available.has(t));
  if (missing.length) throw new Error(`playwright server is missing: ${missing.join(', ')}`);

  const now = new Date().toISOString();
  const agent: Agent = createAgent({
    id: uuidv4(),
    name: 'Browser spike',
    description: 'Browser automation spike',
    provider: 'anthropic',
    model: MODEL,
    systemPrompt: 'You are a careful assistant that operates a web browser through tools.',
    toolPermissions: BROWSER_TOOLS.map(t => `playwright__${t}`),
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    config: { maxTokens: 16000, maxToolIterations: spec.maxSteps, approvalMode: false, dryRun: false },
  });
  // createAgent swaps unknown models for the default; refuse to run on the wrong one.
  if (agent.model !== MODEL) throw new Error(`model was rewritten to ${agent.model}`);
  const agentTools = (await getToolsForAgent(agent.id)).map(t => `${t.serverName}__${t.name}`);

  console.log(`run dir: ${runDir}`);
  console.log(`task ${which}, model ${MODEL}, tools: ${agentTools.join(', ')}, max ${spec.maxSteps} steps, cap $${spec.costCap}`);
  log({ ev: 'start', task: which, model: MODEL, maxSteps: spec.maxSteps, costCap: spec.costCap, tools: agentTools });

  const task = await executeAgentTask(agent, spec.task, true);
  const wallMs = Date.now() - t0;

  const usage = dbAll<{ prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number }>(
    'SELECT prompt_tokens, completion_tokens, estimated_cost_usd FROM usage_records WHERE task_id = ?', [task.id]);
  const nbCost = usage.reduce((s, r) => s + r.estimated_cost_usd, 0);
  const logs = dbAll<{ level: string; message: string }>('SELECT level, message FROM task_logs WHERE task_id = ? ORDER BY timestamp', [task.id]);

  const summary = {
    status: task.status, error: task.error ?? null,
    llmCalls, toolCalls, levels, wallMs, llmMs: totals.llmMs, toolMs: totals.toolMs, pausedMs: totals.pausedMs,
    tokens: { input: totals.input, output: totals.output, cacheWrite: totals.cacheWrite, cacheRead: totals.cacheRead },
    costUsd: Number(costNow().toFixed(4)),
    nodebrainRecorded: { rows: usage.length, costUsd: Number(nbCost.toFixed(4)) },
  };
  log({ ev: 'end', ...summary });
  fs.writeFileSync(path.join(runDir, 'output.md'), task.output ?? `(no output) ${task.error ?? ''}`);
  fs.writeFileSync(path.join(runDir, 'task-logs.txt'), logs.map(l => `[${l.level}] ${l.message}`).join('\n'));
  console.log('\n=== SUMMARY ===\n' + JSON.stringify(summary, null, 2));
}

main()
  .catch(e => { console.error('HARNESS FAILED:', e); log({ ev: 'harness_error', err: String(e) }); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 500));
