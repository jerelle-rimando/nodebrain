import { Router } from 'express';
import { google } from 'googleapis';
import { createCredential, getCredentialForProvider } from '../vault/credentialVault';
import { reloadToolRegistry } from '../mcp/toolRegistry';

const router = Router();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/calendar',
];

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:3001/api/auth/google/callback',
  );
}

router.get('/google', (_req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(500).send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff">
        <h2>Google OAuth not configured</h2>
        <p>Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.</p>
        <p>See docs/google-oauth-setup.md for instructions.</p>
        <a href="http://localhost:5173" style="color:#7c3aed">Back to NodeBrain</a>
      </body></html>
    `);
    return;
  }

  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  res.redirect(url);
});

router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query as { code?: string; error?: string };

  if (error || !code) {
    res.redirect('http://localhost:5173?auth=error&provider=google');
    return;
  }

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      throw new Error('No access token received');
    }

    const tokenData = JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      expiry_date: tokens.expiry_date ?? null,
    });

    const existing = getCredentialForProvider('google');
    if (!existing) {
      createCredential('Google Workspace', 'google', tokenData);
    }

    reloadToolRegistry().catch(console.error);

    res.redirect('http://localhost:5173?auth=success&provider=google');
  } catch (err) {
    console.error('[Auth] Google OAuth callback error:', err);
    res.redirect('http://localhost:5173?auth=error&provider=google');
  }
});

export default router;