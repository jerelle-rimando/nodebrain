import { Router, Response } from 'express';
import { getCredentialForProvider } from '../vault/credentialVault';
import {
  SERVER_CONFIGS,
  getServerStatus,
  providerRequiresCredential,
  reloadToolRegistry,
  waitForRegistryIdle,
  type ServerStatus,
} from '../mcp/toolRegistry';
import { slackAuthTest } from '../mcp/slackAuth';
import { telemetry } from '../utils/telemetry';

const router = Router();

// How long a Test or Enable waits for a connect pass that's already underway
// (e.g. the reload a credential save just kicked off) before reporting
// "still starting" rather than guessing.
const SERVER_SETTLE_TIMEOUT_MS = 20_000;

// The built-in MCP server behind an integration, or undefined for a provider
// that isn't backed by one.
function serverNameFor(provider: string): string | undefined {
  return SERVER_CONFIGS.find(c => c.credentialProvider === provider)?.name;
}

function serverStatusFor(provider: string): ServerStatus | undefined {
  const name = serverNameFor(provider);
  return name ? getServerStatus(name) : undefined;
}

function statusPayload(status: ServerStatus | undefined) {
  return {
    connected: status?.state === 'running',
    state: status?.state ?? 'stopped',
    message: status?.message,
  };
}

router.get('/:provider/status', (req, res) => {
  res.json({ success: true, data: statusPayload(serverStatusFor(req.params.provider)) });
});

router.post('/:provider/enable', async (req, res) => {
  const { provider } = req.params;
  try {
    await reloadToolRegistry();
    await waitForRegistryIdle(SERVER_SETTLE_TIMEOUT_MS);
    res.json({ success: true, data: statusPayload(serverStatusFor(provider)) });
  } catch {
    res.json({
      success: true,
      data: { connected: false, state: 'failed', message: "NodeBrain couldn't start this integration. Try again in a moment." },
    });
  }
});

// A test result always carries a `reason` so the UI can tell "the service rejected
// your credential" apart from "we couldn't reach the service" without parsing strings.
// The credential and the MCP server are separate facts: a valid token says nothing
// about whether the server that uses it actually started, so both are checked.
type CredentialReason = 'invalid_credential' | 'not_configured' | 'network' | 'unknown';
type TestReason = CredentialReason | 'server_failed' | 'server_starting';

const CREDENTIAL_REASONS = new Set<TestReason>(['invalid_credential', 'not_configured', 'network', 'unknown']);

interface CredentialResult {
  ok: boolean;
  message: string;
  reason?: CredentialReason;
}

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() throws TypeError on DNS/connection failures
  if (err instanceof Error) {
    return err.name === 'TimeoutError' || /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(err.message);
  }
  return false;
}

// Every /test response funnels through here so a failed test with a known
// credential reason also reports setup_failed — reusing the same typed reason
// the UI gets, never the free-text message. Server failures are already
// reported once, at connect time, by mcpClient.
function sendTestResult(
  res: Response,
  result: { success: boolean; message: string; reason?: TestReason; connected: boolean; serverState?: ServerStatus['state'] },
): void {
  if (!result.success && result.reason && CREDENTIAL_REASONS.has(result.reason)) {
    telemetry('setup_failed', { stage: 'credential', reasonCode: result.reason });
  }
  res.json({ success: true, data: result });
}

// Checks only whether the service accepts the credential — not whether the MCP
// server that uses it is running.
async function checkCredential(provider: string, credential: string | null | undefined): Promise<CredentialResult> {
  try {
    if (provider === 'telegram') {
      const response = await fetch(
        `https://api.telegram.org/bot${credential}/getMe`,
      );
      const data = await response.json() as { ok: boolean; result?: { username?: string } };
      return data.ok
        ? { ok: true, message: `Connected as @${data.result?.username ?? 'unknown'}` }
        : { ok: false, message: 'Telegram rejected that bot token.', reason: 'invalid_credential' };
    }

    if (provider === 'github') {
      const response = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${credential}` },
      });
      const data = await response.json() as { login?: string };
      return response.ok
        ? { ok: true, message: `Connected as ${data.login}` }
        : { ok: false, message: 'GitHub rejected that token.', reason: 'invalid_credential' };
    }

    if (provider === 'notion') {
      const response = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${credential}`,
          'Notion-Version': '2022-06-28',
        },
      });
      return response.ok
        ? { ok: true, message: 'Notion connection verified' }
        : { ok: false, message: 'Notion rejected that token.', reason: 'invalid_credential' };
    }

    if (provider === 'open-websearch') {
      // No credential — the server state below is the whole test.
      return { ok: true, message: 'Web Search is running and connected' };
    }

    if (provider === 'slack') {
      const data = await slackAuthTest(credential ?? '');
      return data.ok
        ? { ok: true, message: `Connected as ${data.user ?? 'unknown'}` }
        : { ok: false, message: 'Slack rejected that token.', reason: 'invalid_credential' };
    }

    if (provider === 'filesystem') {
      const fs = await import('fs');
      const exists = fs.existsSync(credential ?? '');
      return exists
        ? { ok: true, message: `Path "${credential}" is accessible` }
        : { ok: false, message: `That folder doesn't exist. Check the path and try again.`, reason: 'invalid_credential' };
    }

    // Unknown provider — just confirm credential exists
    return { ok: true, message: `Credential found for "${provider}"` };
  } catch (err) {
    if (isNetworkError(err)) {
      return {
        ok: false,
        message: `Couldn't reach the service. Check your internet connection and try again.`,
        reason: 'network',
      };
    }
    return {
      ok: false,
      message: `Something went wrong while testing this connection. Try again in a moment.`,
      reason: 'unknown',
    };
  }
}

router.get('/:provider/test', async (req, res) => {
  const { provider } = req.params;

  let credential: string | null | undefined;
  try {
    credential = getCredentialForProvider(provider);
  } catch {
    sendTestResult(res, {
      success: false,
      message: `Something went wrong while testing this connection. Try again in a moment.`,
      reason: 'unknown',
      connected: false,
    });
    return;
  }

  if (!credential && providerRequiresCredential(provider)) {
    sendTestResult(res, {
      success: false,
      message: `No credential saved for "${provider}" yet.`,
      reason: 'not_configured',
      connected: false,
    });
    return;
  }

  const credentialResult = await checkCredential(provider, credential);

  // Only worth waiting out a connect pass when the credential is good — a
  // rejected token is the answer either way, and the user shouldn't sit through
  // a first-run download to hear it.
  if (credentialResult.ok && serverNameFor(provider)) {
    await waitForRegistryIdle(SERVER_SETTLE_TIMEOUT_MS);
  }
  const server = serverStatusFor(provider);
  const connected = !server || server.state === 'running';

  if (!credentialResult.ok) {
    const alsoFailed = server?.state === 'failed' ? ` Separately, ${lowerFirst(server.message ?? '')}` : '';
    sendTestResult(res, {
      success: false,
      message: credentialResult.message + alsoFailed,
      reason: credentialResult.reason,
      connected,
      serverState: server?.state,
    });
    return;
  }

  if (connected) {
    sendTestResult(res, { success: true, message: credentialResult.message, connected, serverState: server?.state });
    return;
  }

  // Credential accepted, server not up. Lead with the fact that the credential
  // is fine so this never reads like "that token was rejected".
  const credentialFine =
    !providerRequiresCredential(provider) ? ''
    : provider === 'filesystem' ? 'That folder is fine, but '
    : 'Your token works, but ';

  if (server!.state === 'starting') {
    sendTestResult(res, {
      success: false,
      message: `${credentialFine}${credentialFine ? 'this' : 'This'} integration is still starting. Check again in a moment.`,
      reason: 'server_starting',
      connected,
      serverState: server!.state,
    });
    return;
  }

  const serverMessage = server!.message ?? "This integration isn't running. Try again in a moment.";
  sendTestResult(res, {
    success: false,
    message: credentialFine ? credentialFine + lowerFirst(serverMessage) : serverMessage,
    reason: 'server_failed',
    connected,
    serverState: server!.state,
  });
});

// "NodeBrain couldn't…" stays capitalised mid-sentence; anything else is lowered.
function lowerFirst(text: string): string {
  if (text.startsWith('NodeBrain')) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export default router;
