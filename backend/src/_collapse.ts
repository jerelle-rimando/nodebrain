// Spike: token cost of a grid-collapsed page view (one line per table row). count_tokens only.
import fs from 'fs';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
const dir = process.argv[2];
const a = new Anthropic({ apiKey: fs.readFileSync(path.join(os.homedir(), '.nodebrain-spike', 'anthropic_api_key.txt'), 'utf8').trim() });
const count = async (t: string) => (await a.messages.countTokens({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x\n' + t }] })).input_tokens - (await a.messages.countTokens({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] })).input_tokens;
function collapse(f: string): string {
  const out: string[] = [];
  let row: string[] | null = null;
  const flush = () => { if (row) out.push(row.join(' | ')); row = null; };
  for (const line of f.split('\n')) {
    const m = line.match(/^- (\w+)(?: "([^"]*)")?.*?\[ref=([^\]]+)\](?:: "?(.*?)"?)?$/);
    if (!m) continue;
    const [, role, name = '', ref, val = ''] = m;
    const label = /[\p{L}\p{N}]/u.test(name) ? name : '';
    if (role === 'row') { flush(); row = [`row ${ref}`]; continue; }
    if (role === 'cell' || role === 'columnheader') { if (row && (label || val)) row.push(label || val); else if (!row && label) out.push(`${role} "${label}"`); continue; }
    if (role === 'link' && !label) continue;
    const item = `${role}${label ? ` "${label}"` : ''} ${ref}${val ? `: ${val}` : ''}`;
    if (row) row.push(item); else out.push(item);
  }
  flush();
  return out.join('\n');
}
(async () => {
  for (const p of ['01-login', '02-dashboard', '03-pim-employee-list', '04-pim-add-employee']) {
    const c = collapse(fs.readFileSync(`${dir}/${p}.aria_filtered.txt`, 'utf8'));
    fs.writeFileSync(`${dir}/${p}.collapsed.txt`, c);
    console.log(p, c.length, 'chars', await count(c), 'tokens');
  }
})();
