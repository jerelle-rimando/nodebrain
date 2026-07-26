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

router.get('/:provider/test', async (req, res) => {
  const { provider } = req.params;

  try {
    const credential = getCredentialForProvider(provider);

    if (!credential && providerRequiresCredential(provider)) {
      res.json({
        success: true,
        data: { success: false, message: `No credential found for "${provider}"` },
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
          data: { success: false, message: 'Invalid bot token' },
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
          data: { success: false, message: 'Invalid GitHub token' },
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
          data: { success: false, message: 'Invalid Notion token' },
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
          data: { success: false, message: 'Invalid Slack token' },
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
          message: exists ? `Path "${credential}" is accessible` : `Path "${credential}" does not exist`,
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
    const message = err instanceof Error ? err.message : String(err);
    res.json({
      success: true,
      data: { success: false, message: `Test failed: ${message}` },
    });
  }
});

export default router;