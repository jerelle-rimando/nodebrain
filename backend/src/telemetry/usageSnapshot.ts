import { getAllAgents } from '../db/agentRepository';
import { getTasksPerDay, getRunCountsByProvider } from '../db/usageRepository';
import { getSuccessRate, getAgentsNeverRunCount } from '../routes/analytics';
import { getAllCredentials } from '../vault/credentialVault';
import { FREE_PROVIDERS, BUILTIN_SERVERS } from '../agents/agentEngine';
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

// A credential's provider is free text and custom MCP servers can be named
// anything (often after an employer or client), so only names NodeBrain ships
// are sent as-is. Everything else collapses to 'custom'.
function connectedIntegrations(): string[] {
  const providers = new Set(
    getAllCredentials().map(c => (BUILTIN_SERVERS.has(c.provider) ? c.provider : 'custom')),
  );
  return Array.from(providers);
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
