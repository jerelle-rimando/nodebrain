import { getCredentialForProvider, getBaseUrlForProvider } from '../vault/credentialVault';
import { BASE_URLS, DEFAULT_MODELS, resolveDefaultProvider } from '../agents/agentEngine';
import {
  getSiteAgentById, getWorkflowsBySiteAgent, getFieldsByWorkflow, getRunsByWorkflow, getVersionsByWorkflow,
} from '../db/workflowRepository';
import { buildRunForm } from './runPlan';
import { buildOverview } from './workflowList';

// The site chat on the Dashboard talks to one site. It gets what
// NodeBrain knows about that site's recorded workflows, in the same plain
// words the screens use: names, what each asks for, the steps, where each
// stands now, and how recent runs went. It can explain; it can't act (run,
// record, fix, or see the browser). Values typed into past runs and secret
// values are never sent to the model.

export interface SiteChatTurn { role: 'user' | 'assistant'; content: string }

export class SiteChatError extends Error {}

const MAX_TURNS = 20;

export function siteContext(siteAgentId: string): string | null {
  const site = getSiteAgentById(siteAgentId);
  if (!site) return null;
  const rows = new Map(buildOverview().workflows.map((w) => [w.id, w]));
  const lines: string[] = [`Site: ${site.name} (${site.siteKey}), starting at ${site.startUrl}.`];
  const workflows = getWorkflowsBySiteAgent(siteAgentId).filter((w) => w.currentVersionId);
  if (workflows.length === 0) lines.push('Nothing has been recorded on this site yet.');
  for (const wf of workflows) {
    const form = buildRunForm(wf.id);
    const row = rows.get(wf.id);
    lines.push('', `Workflow "${row?.name ?? wf.name}" — right now: ${row?.stateText ?? 'unknown'}.`);
    const fields = getFieldsByWorkflow(wf.id);
    lines.push(fields.length
      ? `It asks for: ${fields.map((f) => f.label + (f.secret ? ' (kept secret)' : '')).join(', ')}.`
      : 'It asks for nothing; every value is fixed.');
    const labels = new Map(fields.map((f) => [f.key, f.label]));
    for (const phase of form?.phases ?? []) {
      lines.push(`  ${phase.title}${phase.note ? ` (${phase.note})` : ''}:`);
      for (const step of phase.steps) {
        const text = step.segments.map((g) => ('field' in g ? `[${labels.get(g.field) ?? 'a detail'}]` : g.text)).join('');
        lines.push(`    - ${text}${step.pause === 'handoff' ? ' (the person does this themselves)' : step.pause === 'confirm' ? ' (waits for the person to check first)' : ''}`);
      }
    }
    const repairs = getVersionsByWorkflow(wf.id).filter((v) => v.reason === 'repair').length;
    if (repairs) lines.push(`  It has been fixed by pointing at a moved part of the page ${repairs === 1 ? 'once' : `${repairs} times`}.`);
    const runs = getRunsByWorkflow(wf.id, 5);
    if (runs.length) {
      lines.push('  Recent runs (newest first):');
      for (const r of runs) {
        lines.push(`    - ${r.startedAt.slice(0, 16).replace('T', ' ')}: ${RUN_WORDS[r.status]}${r.error ? ` — ${r.error}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

const RUN_WORDS: Record<string, string> = {
  pending: 'starting', running: 'running', completed: 'finished', failed: "didn't finish",
  cancelled: 'stopped by the person', needs_attention: 'stopped and needs the person',
};

function systemPrompt(context: string): string {
  return [
    "You're NodeBrain's assistant for one website the person automates with recorded workflows.",
    'A workflow is a task they did once in their browser while NodeBrain recorded it; NodeBrain repeats it with new details, with no AI involved in the repeating.',
    'Answer only from the facts below. If they don\'t cover the question, say you don\'t know rather than guess.',
    "You can't run, record, change or fix workflows, and you can't see the browser. When they want one of those, tell them which button to use in the list beside this chat: Run, Open, Continue or Fix on a workflow, or Record at the top.",
    'Use plain words: never mention selectors, locators, step keys or code.',
    'Answer concisely: a few sentences by default.',
    '',
    'Facts:',
    context,
  ].join('\n');
}

export async function askAboutSite(
  siteAgentId: string, turns: SiteChatTurn[], requested: { provider?: string; model?: string },
): Promise<string> {
  const context = siteContext(siteAgentId);
  if (!context) throw new SiteChatError("That site doesn't exist anymore.");
  const messages = turns.filter((t) => t.content.trim()).slice(-MAX_TURNS);
  if (!messages.length || messages[messages.length - 1].role !== 'user') throw new SiteChatError('Ask something first.');

  // Same choice of provider as the Dashboard's chat.
  let provider: string;
  let apiKey: string;
  let model: string;
  const requestedKey = requested.provider ? getCredentialForProvider(requested.provider) : null;
  if (requested.provider && (requestedKey || requested.provider === 'ollama')) {
    provider = requested.provider;
    apiKey = requestedKey ?? '';
    model = requested.model || DEFAULT_MODELS[provider] || 'gpt-4o-mini';
  } else {
    ({ provider, apiKey } = await resolveDefaultProvider(['openai', 'groq', 'mistral', 'together', 'fireworks', 'ollama']));
    model = DEFAULT_MODELS[provider] || 'gpt-4o-mini';
  }

  const system = systemPrompt(context);
  if (provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const response = await new Anthropic({ apiKey }).messages.create({ model, max_tokens: 800, system, messages });
    const text = response.content.find((b) => b.type === 'text');
    return text && text.type === 'text' ? text.text : 'No answer came back.';
  }
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: apiKey || 'ollama',
    baseURL: getBaseUrlForProvider(provider) || (BASE_URLS[provider] ?? BASE_URLS.openai),
  });
  const completion = await client.chat.completions.create({
    model, temperature: 0.3, max_tokens: 800,
    messages: [{ role: 'system', content: system }, ...messages],
  });
  return completion.choices[0]?.message?.content ?? 'No answer came back.';
}
