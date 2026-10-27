// Spike harness for docs/spikes/browser-automation-biberk.md, kept as the record of how
// runs 1-3 were measured. Spike branch only; must not reach main.
// Run from backend/, with a fresh data dir each time (the vault secret changes per run):
//   NODEBRAIN_DATA_DIR=<scratch> VAULT_SECRET=<x> HARNESS_OUT=<scratch> npx tsx src/_harness.ts
import './agents/agentEngine'; // must load before ./mcp/toolRegistry (circular import)
import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Messages } from '@anthropic-ai/sdk/resources/messages/messages';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { executeAgentTask } from './agents/agentEngine';
import { initDb, dbAll } from './db/database';
import { initVaultKey, createCredential } from './vault/credentialVault';
import { initializeToolRegistry, getToolsForAgent } from './mcp/toolRegistry';
import { createAgent } from './db/agentRepository';
import type { Agent } from '../shared-types';

const MODEL = 'claude-sonnet-5-5';
// USD per MTok, platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-27)
const PRICE = { input: 2.0, output: 10.0, cacheWrite5m: 2.5, cacheRead: 0.1 };
const MAX_STEPS = 20;
const KEY_FILE = path.join(os.homedir(), '.nodebrain-spike', 'anthropic_api_key.txt');
// Approval classification from the spike doc: tools the gate would have stopped.
const GATED = new Set([
  'browser_click', 'browser_press_key', 'browser_type', 'browser_handle_dialog',
  'browser_evaluate', 'browser_run_code_unsafe', 'browser_file_upload', 'browser_drag', 'browser_drop',
]);

const OUT = process.env.HARNESS_OUT!;
const runDir = path.join(OUT, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(path.join(runDir, 'tool-results'), { recursive: true });
const eventsFile = path.join(runDir, 'events.jsonl');
const t0 = Date.now();
const log = (ev: Record<string, unknown>) =>
  fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now() - t0, ...ev }) + '\n');

// Time every LLM call.
let llmCalls = 0;
const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, llmMs: 0, toolMs: 0 };
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
        ev: 'llm', n, ms, model: r.model, stop: r.stop_reason, usage: u,
        text: r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'),
        tools: r.content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ name: b.name, input: b.input })),
      });
      console.log(`[llm ${n}] ${ms}ms stop=${r.stop_reason} in=${u.input_tokens} out=${u.output_tokens}`);
    },
    (e: unknown) => log({ ev: 'llm_error', n, ms: Date.now() - start, err: String(e) }),
  );
  return p;
};

// Time every MCP tool call and keep the full result for the field inventory.
let toolCalls = 0;
const origCallTool = Client.prototype.callTool;
(Client.prototype as any).callTool = async function (this: Client, params: any, ...rest: any[]) {
  const n = ++toolCalls;
  const start = Date.now();
  try {
    const result: any = await (origCallTool as any).call(this, params, ...rest);
    const ms = Date.now() - start;
    totals.toolMs += ms;
    const text = (result.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    fs.writeFileSync(path.join(runDir, 'tool-results', `${String(n).padStart(3, '0')}-${params.name}.txt`), text);
    log({ ev: 'tool', n, ms, name: params.name, args: params.arguments, wouldGate: GATED.has(params.name), isError: !!result.isError, resultChars: text.length });
    console.log(`[tool ${n}] ${params.name} ${ms}ms${GATED.has(params.name) ? ' (gate would stop)' : ''}${result.isError ? ' ERROR' : ''}`);
    return result;
  } catch (e) {
    log({ ev: 'tool_error', n, ms: Date.now() - start, name: params.name, args: params.arguments, err: String(e) });
    throw e;
  }
};

const TASK = `Use the browser tools to get a General Liability insurance quote from biBerk. Start at https://www.biberk.com.

Business information (use only this):
- Business name: ABC Roofing LLC
- Address: 123 Main St, Dallas, TX 75201
- FEIN: 12-3456789
- Legal entity: LLC, established 2019
- Industry: roofing contractor (NAICS 238160)
- 3 trucks, 3 drivers
- No prior insurance coverage, no claims

How to work:
- After any navigation or click, call browser_snapshot to see the current page before acting.
- Prefer browser_fill_form and browser_select_option for filling fields.
- The cookie banner is accepted automatically. Ignore it if you see it.

Hard rules:
- This is a quote only. Never purchase, bind, pay, or enter payment details.
- Do not create an account. Do not enter any email address, phone number, or person's name. If the form requires one to continue, stop there.
- If a required field asks for something not covered above (other than a plain yes/no about prior coverage or claims), stop and report it. Do not invent answers.

When you stop or finish, report:
1. Every form field you saw, in order: label, input type, required or not, and the value you entered (or "not filled").
2. The last page you reached, and whether a quote price was shown.
3. Anything that went wrong (unexpected popups, fields that would not fill, validation errors, slow pages).`;

async function main() {
  const apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
  if (!apiKey) throw new Error(`empty key file: ${KEY_FILE}`);

  await initDb();
  initVaultKey();
  createCredential('Anthropic (spike)', 'anthropic', apiKey);
  // The playwright server inherits this env: accept the cookie banner at page load,
  // and start from an in-memory profile so no earlier run's cookies carry over.
  process.env.PLAYWRIGHT_MCP_INIT_SCRIPT = path.resolve(__dirname, '../../docs/spikes/biberk-accept-cookies.js');
  process.env.PLAYWRIGHT_MCP_ISOLATED = 'true';
  await initializeToolRegistry();

  const playwrightTools = (await getToolsForAgent())
    .filter(t => t.serverName === 'playwright')
    .map(t => `${t.serverName}__${t.name}`);
  if (playwrightTools.length === 0) throw new Error('playwright server exposed no tools');

  const now = new Date().toISOString();
  const agent: Agent = createAgent({
    id: uuidv4(),
    name: 'biBerk spike',
    description: 'Browser automation spike',
    provider: 'anthropic',
    model: MODEL,
    systemPrompt: 'You are a careful assistant that operates a web browser through tools.',
    toolPermissions: playwrightTools,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    config: { maxTokens: 16000, maxToolIterations: MAX_STEPS, approvalMode: false, dryRun: false },
  });
  // createAgent swaps unknown models for the default; refuse to run on the wrong one.
  if (agent.model !== MODEL) throw new Error(`model was rewritten to ${agent.model}`);

  console.log(`run dir: ${runDir}`);
  console.log(`model ${MODEL}, ${playwrightTools.length} tools, max ${MAX_STEPS} steps, approval off, human present`);
  log({ ev: 'start', model: MODEL, maxSteps: MAX_STEPS, tools: playwrightTools.length });

  const task = await executeAgentTask(agent, TASK, true);
  const wallMs = Date.now() - t0;

  const usage = dbAll<{ prompt_tokens: number; completion_tokens: number; estimated_cost_usd: number }>(
    'SELECT prompt_tokens, completion_tokens, estimated_cost_usd FROM usage_records WHERE task_id = ?', [task.id]);
  const nbCost = usage.reduce((s, r) => s + r.estimated_cost_usd, 0);
  const cost =
    (totals.input * PRICE.input + totals.output * PRICE.output +
     totals.cacheWrite * PRICE.cacheWrite5m + totals.cacheRead * PRICE.cacheRead) / 1_000_000;

  const summary = {
    status: task.status, error: task.error ?? null,
    llmCalls, toolCalls, wallMs, llmMs: totals.llmMs, toolMs: totals.toolMs,
    tokens: { input: totals.input, output: totals.output, cacheWrite: totals.cacheWrite, cacheRead: totals.cacheRead },
    costUsd: Number(cost.toFixed(4)),
    nodebrainRecorded: { rows: usage.length, costUsd: Number(nbCost.toFixed(4)) },
  };
  log({ ev: 'end', ...summary });
  fs.writeFileSync(path.join(runDir, 'output.md'), task.output ?? `(no output) ${task.error ?? ''}`);
  console.log('\n=== SUMMARY ===\n' + JSON.stringify(summary, null, 2));
}

main()
  .catch(e => { console.error('HARNESS FAILED:', e); log({ ev: 'harness_error', err: String(e) }); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 500));
