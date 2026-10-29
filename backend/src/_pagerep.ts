// Spike measurement for docs/spikes/browser-automation-biberk.md (second attempt):
// how many tokens each page representation costs on real OrangeHRM pages, and how
// many the Playwright tool schemas cost. No model calls; count_tokens is free.
// Spike branch only; must not reach main.
//   KEY via ~/.nodebrain-spike/anthropic_api_key.txt; OUT=<dir> npx tsx src/_pagerep.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const OUT = process.env.OUT!;
const MODEL = 'claude-sonnet-5-5';
const anthropic = new Anthropic({ apiKey: fs.readFileSync(path.join(os.homedir(), '.nodebrain-spike', 'anthropic_api_key.txt'), 'utf8').trim() });
const BASE = 'https://opensource-demo.orangehrmlive.com/web/index.php';

const INTERACTIVE = /^(button|link|textbox|searchbox|combobox|checkbox|radio|option|menuitem|tab|switch|slider|spinbutton|listbox|row|cell|columnheader|heading)$/;

async function countText(text: string): Promise<number> {
  const base = await anthropic.messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
  const r = await anthropic.messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'x\n' + text }] });
  return r.input_tokens - base.input_tokens;
}

async function countTools(tools: Array<{ name: string; description?: string; inputSchema: any }>): Promise<number> {
  const base = await anthropic.messages.countTokens({ model: MODEL, messages: [{ role: 'user', content: 'x' }] });
  const r = await anthropic.messages.countTokens({
    model: MODEL, messages: [{ role: 'user', content: 'x' }],
    tools: tools.map(t => ({ name: `playwright__${t.name}`, description: `[playwright] ${t.description ?? ''}`, input_schema: { type: 'object' as const, properties: t.inputSchema.properties ?? {}, required: t.inputSchema.required ?? [] } })),
  });
  return r.input_tokens - base.input_tokens;
}

const text = (r: any) => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

// Keep only lines for elements an agent can act on (plus headings and table cells for
// orientation), drop decorative wrappers and the /url and cursor annotations.
function filterSnapshot(snap: string): string {
  const out: string[] = [];
  for (const line of snap.split('\n')) {
    const m = line.match(/^\s*- (\w+)/);
    if (!m || !INTERACTIVE.test(m[1])) continue;
    out.push(line.trim().replace(/ \[cursor=pointer\]/g, '').replace(/:$/, ''));
  }
  return out.join('\n');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const c = new Client({ name: 'pagerep', version: '0' });
  await c.connect(new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.83', '--browser', 'msedge', '--headless', '--isolated', '--output-dir', path.join(os.tmpdir(), 'nodebrain-playwright')],
  }));
  const { tools } = await c.listTools();
  const MINIMAL = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_fill_form', 'browser_select_option', 'browser_press_key', 'browser_wait_for'];
  const schemaAll = await countTools(tools as any);
  const schemaMin = await countTools(tools.filter(t => MINIMAL.includes(t.name)) as any);
  const results: any = { tools: { all: { count: tools.length, tokens: schemaAll }, minimal: { names: MINIMAL, tokens: schemaMin } }, pages: [] };

  const call = async (name: string, args: any = {}) => text(await c.callTool({ name, arguments: args }));
  const measure = async (label: string) => {
    const snap = await call('browser_snapshot');
    const html = await call('browser_evaluate', { function: '() => document.documentElement.outerHTML' });
    const inner = await call('browser_evaluate', { function: '() => document.body.innerText' });
    const filtered = filterSnapshot(snap);
    const reps = { aria_full: snap, aria_filtered: filtered, inner_text: inner, raw_html: html };
    const row: any = { label };
    for (const [k, v] of Object.entries(reps)) {
      fs.writeFileSync(path.join(OUT, `${label}.${k}.txt`), v);
      row[k] = { chars: v.length, tokens: await countText(v) };
    }
    results.pages.push(row);
    console.log(label, JSON.stringify(row));
    return snap;
  };
  const ref = (snap: string, re: RegExp) => {
    const m = snap.split('\n').find(l => re.test(l))?.match(/\[ref=([^\]]+)\]/);
    if (!m) throw new Error(`no ref for ${re}`);
    return m[1];
  };

  await call('browser_navigate', { url: `${BASE}/auth/login` });
  await call('browser_wait_for', { text: 'Username' });
  const login = await measure('01-login');
  await call('browser_type', { target: ref(login, /textbox "Username"/), text: 'Admin' });
  await call('browser_type', { target: ref(login, /textbox "Password"/), text: 'admin123', submit: true });
  await call('browser_wait_for', { text: 'Dashboard' });
  await call('browser_wait_for', { time: 3 });
  await measure('02-dashboard');
  await call('browser_navigate', { url: `${BASE}/pim/viewEmployeeList` });
  await call('browser_wait_for', { text: 'Employee Information' });
  await call('browser_wait_for', { time: 3 });
  await measure('03-pim-employee-list');
  await call('browser_navigate', { url: `${BASE}/pim/addEmployee` });
  await call('browser_wait_for', { text: 'Add Employee' });
  await call('browser_wait_for', { time: 2 });
  await measure('04-pim-add-employee');

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results.tools));
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 500));
