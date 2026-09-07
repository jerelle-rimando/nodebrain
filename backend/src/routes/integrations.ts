import { Router } from 'express';
import { getCredentialForProvider } from '../vault/credentialVault';
import { getConnectedServers } from '../mcp/mcpClient';
import { providerRequiresCredential, reloadToolRegistry } from '../mcp/toolRegistry';

const router = Router();

router.get('/:provider/status', (req, res) => {
  const { provider } = req.params;
  res.json({ success: true, data: { connected: getConnectedServers().includes(provider) } });
});

router.post('/:provider/enable', async (req, res) => {
  const { provider } = req.params;
  try {
    await reloadToolRegistry();
    res.json({ success: true, data: { connected: getConnectedServers().includes(provider) } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ success: true, data: { connected: false, message } });
  }
});

// A test result always carries a `reason` so the UI can tell "the service rejected
// your credential" apart from "we couldn't reach the service" without parsing strings.
type TestReason = 'invalid_credential' | 'not_configured' | 'network' | 'unknown';

function isNetworkError(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() throws TypeError on DNS/connection failures
  if (err instanceof Error) {
    return /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(err.message);
  }
  return false;
}

router.get('/:provider/test', async (req, res) => {
  const { provider } = req.params;

  try {
    const credential = getCredentialForProvider(provider);

    if (!credential && providerRequiresCredential(provider)) {
      res.json({
        success: true,
        data: {
          success: false,
          message: `No credential saved for "${provider}" yet.`,
          reason: 'not_configured' as TestReason,
        },
      });
      return;
    }

    // Provider-specific test logic
    if (provider === 'telegram') {
      const response = await fetch(
        `https://api.telegram.org/bot${credential}/getMe`,
      );
      const data = await response.json() as { ok: boolean; result?: { username?: string } };
      if (data.ok) {
        res.json({
          success: true,
          data: { success: true, message: `Connected as @${data.result?.username ?? 'unknown'}` },
        });
      } else {
        res.json({
          success: true,
          data: { success: false, message: 'Telegram rejected that bot token.', reason: 'invalid_credential' as TestReason },
        });
      }
      return;
    }

    if (provider === 'github') {
      const response = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${credential}` },
      });
      const data = await response.json() as { login?: string };
      if (response.ok) {
        res.json({
          success: true,
          data: { success: true, message: `Connected as ${data.login}` },
        });
      } else {
        res.json({
          success: true,
          data: { success: false, message: 'GitHub rejected that token.', reason: 'invalid_credential' as TestReason },
        });
      }
      return;
    }

    if (provider === 'notion') {
      const response = await fetch('https://api.notion.com/v1/users/me', {
        headers: {
          Authorization: `Bearer ${credential}`,
          'Notion-Version': '2022-06-28',
        },
      });
      if (response.ok) {
        res.json({
          success: true,
          data: { success: true, message: 'Notion connection verified' },
        });
      } else {
        res.json({
          success: true,
          data: { success: false, message: 'Notion rejected that token.', reason: 'invalid_credential' as TestReason },
        });
      }
      return;
    }

    if (provider === 'open-websearch') {
      const connected = getConnectedServers().includes('open-websearch');
      res.json({
        success: true,
        data: {
          success: connected,
          message: connected ? 'Web Search is running and connected' : 'Web Search server is not connected',
          reason: connected ? undefined : ('unknown' as TestReason),
        },
      });
      return;
    }

    if (provider === 'slack') {
      const response = await fetch('https://slack.com/api/auth.test', {
        headers: { Authorization: `Bearer ${credential}` },
      });
      const data = await response.json() as { ok: boolean; user?: string };
      if (data.ok) {
        res.json({
          success: true,
          data: { success: true, message: `Connected as ${data.user ?? 'unknown'}` },
        });
      } else {
        res.json({
          success: true,
          data: { success: false, message: 'Slack rejected that token.', reason: 'invalid_credential' as TestReason },
        });
      }
      return;
    }

    if (provider === 'filesystem') {
      const fs = await import('fs');
      const exists = fs.existsSync(credential ?? '');
      res.json({
        success: true,
        data: {
          success: exists,
          message: exists ? `Path "${credential}" is accessible` : `That folder doesn't exist. Check the path and try again.`,
          reason: exists ? undefined : ('invalid_credential' as TestReason),
        },
      });
      return;
    }

    // Unknown provider — just confirm credential exists
    res.json({
      success: true,
      data: { success: true, message: `Credential found for "${provider}"` },
    });

  } catch (err) {
    if (isNetworkError(err)) {
      res.json({
        success: true,
        data: {
          success: false,
          message: `Couldn't reach the service. Check your internet connection and try again.`,
          reason: 'network' as TestReason,
        },
      });
      return;
    }
    res.json({
      success: true,
      data: {
        success: false,
        message: `Something went wrong while testing this connection. Try again in a moment.`,
        reason: 'unknown' as TestReason,
      },
    });
  }
});

export default router;