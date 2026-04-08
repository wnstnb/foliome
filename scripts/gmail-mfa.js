const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const readline = require('readline');

const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'gmail-token.json');
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

async function getAuth() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`credentials.json not found at ${CREDENTIALS_PATH}. See docs/plan.md for Gmail API setup.`);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  throw new Error(`gmail-token.json not found. Run "node scripts/gmail-mfa.js --setup" to authorize.`);
}

async function runSetup() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`credentials.json not found at ${CREDENTIALS_PATH}`);
    console.error('Download it from Google Cloud Console → APIs & Services → Credentials');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('Authorize this app by visiting this URL:\n');
  console.log(authUrl);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise(resolve => rl.question('Enter the authorization code: ', resolve));
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token saved to', TOKEN_PATH);
}

async function pollForMfaCode({ sender, subjectKeyword, timeoutMs = 60000, pollIntervalMs = 10000 }) {
  const auth = await getAuth();
  const gmail = google.gmail({ version: 'v1', auth });

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      const query = buildQuery(sender, subjectKeyword);
      const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 1,
      });

      if (res.data.messages && res.data.messages.length > 0) {
        const msgId = res.data.messages[0].id;
        const msg = await gmail.users.messages.get({
          userId: 'me',
          id: msgId,
          format: 'full',
        });

        const body = extractBody(msg.data);
        const code = extractCode(body);
        if (code) return code;
      }
    } catch (err) {
      console.error('[gmail-mfa] Poll error:', err.message);
    }

    await sleep(pollIntervalMs);
  }

  return null;
}

function buildQuery(sender, subjectKeyword) {
  const parts = ['newer_than:5m'];
  if (sender) parts.push(`from:${sender}`);
  if (subjectKeyword) parts.push(`subject:${subjectKeyword}`);
  return parts.join(' ');
}

function extractBody(message) {
  const parts = message.payload.parts || [message.payload];
  for (const part of parts) {
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.mimeType === 'text/html' && part.body && part.body.data) {
      return Buffer.from(part.body.data, 'base64url').toString('utf-8');
    }
    if (part.parts) {
      const nested = extractBody({ payload: { parts: part.parts } });
      if (nested) return nested;
    }
  }
  // Fallback: body directly on payload
  if (message.payload.body && message.payload.body.data) {
    return Buffer.from(message.payload.body.data, 'base64url').toString('utf-8');
  }
  return '';
}

function extractCode(text) {
  // Match 6-8 digit codes (most common MFA code lengths)
  const match = text.match(/\b(\d{6,8})\b/);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { pollForMfaCode, getAuth, extractCode };

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--setup')) {
    runSetup().catch(err => {
      console.error('Setup failed:', err.message);
      process.exit(1);
    });
  } else if (args.includes('--test')) {
    (async () => {
      console.log('Testing Gmail API connection...');
      try {
        const auth = await getAuth();
        const gmail = google.gmail({ version: 'v1', auth });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log('Connected as:', profile.data.emailAddress);
        console.log('Gmail MFA poller is ready.');
      } catch (err) {
        console.error('Test failed:', err.message);
        process.exit(1);
      }
    })();
  } else {
    console.log('Usage:');
    console.log('  node scripts/gmail-mfa.js --setup    Run initial OAuth authorization');
    console.log('  node scripts/gmail-mfa.js --test     Test Gmail API connection');
  }
}
