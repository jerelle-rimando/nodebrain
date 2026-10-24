import { getAllAgents } from '../db/agentRepository';
import { getTasksPerDay, getRunCountsByProvider } from '../db/usageRepository';
import { getSuccessRate, getAgentsNeverRunCount } from '../routes/analytics';
import { getAllCredentials } from '../vault/credentialVault';
import { getAllCustomMCPServers } from '../db/mcpServerRepository';
import { FREE_PROVIDERS, LLM_PROVIDERS } from '../agents/agentEngine';
import { SERVER_CONFIGS } from '../mcp/toolRegistry';
import { telemetry } from '../utils/telemetry';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function runsLast7Days(): number {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  return getTasksPerDay()
    .filter(d => new Date(d.date).getTime() >= cutoff)
    .reduce((sum, d) => sum + d.count, 0);
}

function localVsHostedRuns(): { localRuns: number; hostedRuns: number } {
  let localRuns = 0;
  let hostedRuns = 0;
  for (const { provider, runs } of getRunCountsByProvider()) {
    if (FREE_PROVIDERS.has(provider)) localRuns += runs;
    else hostedRuns += runs;
  }
  return { localRuns, hostedRuns };
}

const BUILTIN_INTEGRATIONS: ReadonlySet<string> = new Set(SERVER_CONFIGS.map(c => c.credentialProvider));

// A credential's provider is free text and custom MCP servers can be named
// anything (often after an employer or client), so only names NodeBrain ships
// are sent as-is. Everything else collapses to 'custom'. Model provider keys
// are left out: they're model choice, which localRuns/hostedRuns already covers,
// and counting them would make 'custom' mean "has an API key".
// The telemetry Worker applies the same rules to clients that predate this.
function connectedIntegrations(): string[] {
  const integrations = new Set<string>();
  for (const { provider } of getAllCredentials()) {
    if (LLM_PROVIDERS.has(provider)) continue;
    integrations.add(BUILTIN_INTEGRATIONS.has(provider) ? provider : 'custom');
  }
  if (getAllCustomMCPServers().length > 0) integrations.add('custom');
  return Array.from(integrations);
}

// A single aggregate-counts event, emitted once per app launch. Every value
// here is a count, a built-in provider name, or 'custom' — never a
// user-chosen name, task/agent identifier, prompt, or credential value.
export async function emitUsageSnapshot(): Promise<void> {
  const agents = getAllAgents();
  const { localRuns, hostedRuns } = localVsHostedRuns();

  telemetry('usage_snapshot', {
    agentCount: agents.length,
    agentsNeverRun: getAgentsNeverRunCount(),
    runsLast7Days: runsLast7Days(),
    successRatePct: Math.round(getSuccessRate() * 100),
    connectedIntegrations: connectedIntegrations(),
    localRuns,
    hostedRuns,
  });
}
