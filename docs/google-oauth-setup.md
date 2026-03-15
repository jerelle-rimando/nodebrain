# Google OAuth Setup for NodeBrain

NodeBrain requires each user to create their own Google Cloud project.
This keeps your data private and under your own Google account.

## Steps

1. Go to https://console.cloud.google.com
2. Create a new project called "NodeBrain"
3. Enable these APIs:
   - Gmail API
   - Google Drive API
   - Google Docs API
   - Google Sheets API
   - Google Calendar API
4. Go to APIs & Services → OAuth consent screen
   - Set User Type to External
   - Add your own Gmail as a test user
5. Go to APIs & Services → Credentials
   - Click Create Credentials → OAuth client ID
   - Application type: Web application
   - Add redirect URI: http://localhost:3001/api/auth/google/callback
6. Copy the Client ID and Client Secret
7. Add to your .env file:
   GOOGLE_CLIENT_ID=your_client_id
   GOOGLE_CLIENT_SECRET=your_client_secret
8. Restart NodeBrain and click Connect Google in the Integrations page