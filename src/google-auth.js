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

async function authorize() {
  const creds = loadCredentials();
  const { client_id, client_secret } = creds.installed || creds.web;

  if (fs.existsSync(TOKEN_PATH)) {
    const oauth2 = getOAuth2Client();
    return oauth2;
  }

  // Start local server first to get the actual port
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}`;

  // Create OAuth2 client with the actual redirect URI
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

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
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log('Token saved to', TOKEN_PATH);

  return oauth2;
}

module.exports = { getOAuth2Client, authorize, SCOPES };
