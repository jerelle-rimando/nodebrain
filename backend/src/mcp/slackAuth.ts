// The Slack MCP server won't start without SLACK_TEAM_ID next to the bot token.
// The token alone is enough to look it up: auth.test returns the workspace it
// belongs to, so the user never has to find and paste a team ID themselves.

export interface SlackAuthResult {
  ok: boolean;
  error?: string;   // Slack's error code, e.g. "invalid_auth"
  user?: string;
  team_id?: string;
}

// Startup connects servers one after another, so a hung request here would hold
// up every integration after Slack.
const AUTH_TEST_TIMEOUT_MS = 10_000;

export async function slackAuthTest(token: string): Promise<SlackAuthResult> {
  const response = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(AUTH_TEST_TIMEOUT_MS),
  });
  return await response.json() as SlackAuthResult;
}

// A token always belongs to the same workspace, so a lookup is only ever needed
// once per token. Failures aren't cached: the next reconnect tries again.
const teamIdByToken = new Map<string, string>();

export async function getSlackTeamId(token: string): Promise<string> {
  const cached = teamIdByToken.get(token);
  if (cached) return cached;

  const data = await slackAuthTest(token);
  if (!data.ok || !data.team_id) {
    throw new Error(`Slack auth.test failed: ${data.error ?? 'no team_id in response'}`);
  }
  teamIdByToken.set(token, data.team_id);
  return data.team_id;
}
