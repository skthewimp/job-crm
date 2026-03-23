const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const http = require('http');
const url = require('url');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/spreadsheets'
];

// Extra accounts only need read-only Gmail access
const EXTRA_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly'
];

const TOKEN_PATH = path.join(__dirname, '..', 'auth', 'google-token.json');
const CREDENTIALS_PATH = path.join(__dirname, '..', 'auth', 'google-credentials.json');

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing ${CREDENTIALS_PATH}. Download OAuth2 credentials from Google Cloud Console.`
    );
  }
  return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
}

function getOAuth2Client() {
  const creds = loadCredentials();
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oauth2.setCredentials(token);

    oauth2.on('tokens', (tokens) => {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
      const updated = { ...current, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
    });
  }

  return oauth2;
}

/**
 * Returns OAuth2 clients for extra Gmail accounts configured in GMAIL_EXTRA_ACCOUNTS.
 * Each account gets its own token file: auth/google-token-{sanitized-email}.json
 */
function getExtraGmailClients() {
  const extraEmails = (process.env.GMAIL_EXTRA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (extraEmails.length === 0) return [];

  const creds = loadCredentials();
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  const clients = [];

  for (const email of extraEmails) {
    const tokenPath = getExtraTokenPath(email);
    if (!fs.existsSync(tokenPath)) {
      console.warn(`  No token found for ${email}. Run: npm run auth:gmail-extra -- ${email}`);
      continue;
    }

    const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oauth2.setCredentials(token);

    oauth2.on('tokens', (tokens) => {
      const current = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const updated = { ...current, ...tokens };
      fs.writeFileSync(tokenPath, JSON.stringify(updated, null, 2));
    });

    clients.push({ auth: oauth2, email });
  }

  return clients;
}

function getExtraTokenPath(email) {
  const sanitized = email.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(__dirname, '..', 'auth', `google-token-${sanitized}.json`);
}

async function authorize() {
  const creds = loadCredentials();
  const { client_id, client_secret } = creds.installed || creds.web;

  if (fs.existsSync(TOKEN_PATH)) {
    const oauth2 = getOAuth2Client();
    return oauth2;
  }

  return authorizeWithBrowser(client_id, client_secret, SCOPES, TOKEN_PATH);
}

async function authorizeExtra(email) {
  const creds = loadCredentials();
  const { client_id, client_secret } = creds.installed || creds.web;
  const tokenPath = getExtraTokenPath(email);

  if (fs.existsSync(tokenPath)) {
    console.log(`Token already exists for ${email} at ${tokenPath}`);
    return;
  }

  console.log(`\nAuthorizing extra Gmail account: ${email}`);
  console.log('Make sure to log in with this Google account in the browser.\n');
  return authorizeWithBrowser(client_id, client_secret, EXTRA_SCOPES, tokenPath, email);
}

async function authorizeWithBrowser(clientId, clientSecret, scopes, tokenPath, loginHint) {
  // Start local server first to get the actual port
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;

  // Create OAuth2 client with the actual redirect URI
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authParams = {
    access_type: 'offline',
    scope: scopes,
    prompt: 'consent'
  };
  if (loginHint) authParams.login_hint = loginHint;

  const authUrl = oauth2.generateAuthUrl(authParams);

  console.log('Authorize this app by visiting:\n', authUrl);
  console.log(`\nWaiting for authorization on ${redirectUri} ...`);

  const code = await new Promise((resolve) => {
    server.on('request', (req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        res.end('Authorization successful! You can close this tab.');
        server.close();
        resolve(query.code);
      }
    });
  });

  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log('Token saved to', tokenPath);

  return oauth2;
}

module.exports = { getOAuth2Client, getExtraGmailClients, authorize, authorizeExtra, SCOPES, EXTRA_SCOPES };
