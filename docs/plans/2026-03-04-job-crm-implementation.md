# Job Hunt CRM Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a daily-running CRM that scans Gmail, Google Calendar, and WhatsApp for job-hunt follow-ups, updates a Google Sheet, and emails a daily summary.

**Architecture:** Monolith Node.js project with two entry points - a persistent WhatsApp collector daemon and a daily scanner cron job. Both share a local SQLite database. Claude API (Haiku for classification, Sonnet for extraction) processes messages to identify commitments.

**Tech Stack:** Node.js 18+, whatsapp-web.js, googleapis, @anthropic-ai/sdk, better-sqlite3, node-cron (for testing), macOS launchd

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `src/index.js` (placeholder)
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Initialize the project**

```bash
cd "/Users/Karthik/Documents/work/vibes/job-crm"
npm init -y
```

**Step 2: Install all dependencies**

```bash
npm install whatsapp-web.js qrcode-terminal better-sqlite3 googleapis @anthropic-ai/sdk dotenv
```

**Step 3: Create .gitignore**

```
node_modules/
.env
.wwebjs_auth/
.wwebjs_cache/
data/
auth/
```

**Step 4: Create .env.example**

```
ANTHROPIC_API_KEY=sk-ant-...
GOOGLE_SHEET_ID=your-google-sheet-id
GMAIL_SELF_EMAIL=your-email@gmail.com
DAILY_SUMMARY_TIME=07:00
```

**Step 5: Create src directory structure**

```bash
mkdir -p src/{whatsapp,gmail,calendar,sheets,llm,summary}
mkdir -p data
mkdir -p auth
```

**Step 6: Commit**

```bash
git init
git add package.json package-lock.json .gitignore .env.example
git commit -m "chore: initial project scaffolding"
```

---

### Task 2: SQLite Database Layer

**Files:**
- Create: `src/db.js`
- Create: `tests/db.test.js`

**Step 1: Write the test**

```javascript
// tests/db.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { initDb, insertMessage, getMessagesSince, upsertContact, getContacts, getContactByNameAndCompany } = require('../src/db');

const TEST_DB = './data/test.sqlite';

describe('Database', () => {
  let db;

  before(() => {
    db = initDb(TEST_DB);
  });

  after(() => {
    db.close();
    fs.unlinkSync(TEST_DB);
  });

  it('should insert and retrieve WhatsApp messages', () => {
    insertMessage(db, {
      chatId: 'chat123',
      contactName: 'Jane Doe',
      phone: '+1234567890',
      body: 'Let me follow up next Tuesday',
      timestamp: Date.now(),
      direction: 'incoming',
      source: 'whatsapp'
    });

    const msgs = getMessagesSince(db, 'whatsapp', Date.now() - 86400000);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].contact_name, 'Jane Doe');
  });

  it('should insert and retrieve email messages', () => {
    insertMessage(db, {
      chatId: 'thread_abc',
      contactName: 'John Smith',
      phone: null,
      body: 'I will send you the JD by Friday',
      timestamp: Date.now(),
      direction: 'incoming',
      source: 'gmail'
    });

    const msgs = getMessagesSince(db, 'gmail', Date.now() - 86400000);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].source, 'gmail');
  });

  it('should upsert contacts without duplicates', () => {
    upsertContact(db, {
      name: 'Jane Doe',
      company: 'Acme Corp',
      role: 'Recruiter',
      relationshipType: 'Recruiter',
      source: 'LinkedIn',
      channel: 'WhatsApp',
      firstContactDate: '2026-03-01',
      lastInteractionDate: '2026-03-04',
      lastInteractionSummary: 'Discussed senior role',
      nextFollowUpDate: '2026-03-10',
      followUpAction: 'Send resume',
      status: 'Active',
      roleDiscussed: 'Senior Engineer'
    });

    // Upsert same contact - should update, not duplicate
    upsertContact(db, {
      name: 'Jane Doe',
      company: 'Acme Corp',
      lastInteractionDate: '2026-03-05',
      lastInteractionSummary: 'Sent resume',
      status: 'Waiting'
    });

    const contact = getContactByNameAndCompany(db, 'Jane Doe', 'Acme Corp');
    assert.strictEqual(contact.status, 'Waiting');
    assert.strictEqual(contact.last_interaction_date, '2026-03-05');
    // Original fields preserved
    assert.strictEqual(contact.role, 'Recruiter');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
node --test tests/db.test.js
```
Expected: FAIL - module not found

**Step 3: Implement the database module**

```javascript
// src/db.js
const Database = require('better-sqlite3');
const path = require('path');

function initDb(dbPath = './data/crm.sqlite') {
  const dir = path.dirname(dbPath);
  require('fs').mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      contact_name TEXT,
      phone TEXT,
      body TEXT,
      timestamp INTEGER,
      direction TEXT,
      source TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_source_ts ON messages(source, timestamp);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT,
      role TEXT,
      relationship_type TEXT,
      source TEXT,
      channel TEXT,
      first_contact_date TEXT,
      last_interaction_date TEXT,
      last_interaction_summary TEXT,
      next_follow_up_date TEXT,
      follow_up_action TEXT,
      status TEXT DEFAULT 'Active',
      notes TEXT,
      role_discussed TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      UNIQUE(name, company)
    );
  `);

  return db;
}

function insertMessage(db, { chatId, contactName, phone, body, timestamp, direction, source }) {
  const stmt = db.prepare(`
    INSERT INTO messages (chat_id, contact_name, phone, body, timestamp, direction, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(chatId, contactName, phone, body, timestamp, direction, source);
}

function getMessagesSince(db, source, sinceTimestamp) {
  return db.prepare(`
    SELECT * FROM messages WHERE source = ? AND timestamp >= ? ORDER BY timestamp ASC
  `).all(source, sinceTimestamp);
}

function upsertContact(db, contact) {
  const existing = getContactByNameAndCompany(db, contact.name, contact.company);

  if (existing) {
    const fields = [];
    const values = [];
    const updatable = [
      'role', 'relationship_type', 'source', 'channel',
      'last_interaction_date', 'last_interaction_summary',
      'next_follow_up_date', 'follow_up_action', 'status',
      'notes', 'role_discussed'
    ];
    const keyMap = {
      relationshipType: 'relationship_type',
      lastInteractionDate: 'last_interaction_date',
      lastInteractionSummary: 'last_interaction_summary',
      nextFollowUpDate: 'next_follow_up_date',
      followUpAction: 'follow_up_action',
      roleDiscussed: 'role_discussed',
      firstContactDate: 'first_contact_date'
    };

    for (const [jsKey, dbKey] of Object.entries(keyMap)) {
      if (contact[jsKey] !== undefined) {
        contact[dbKey] = contact[jsKey];
      }
    }

    for (const field of updatable) {
      if (contact[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(contact[field]);
      }
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(existing.id);
      db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
    return existing.id;
  } else {
    const keyMap = {
      relationshipType: 'relationship_type',
      lastInteractionDate: 'last_interaction_date',
      lastInteractionSummary: 'last_interaction_summary',
      nextFollowUpDate: 'next_follow_up_date',
      followUpAction: 'follow_up_action',
      roleDiscussed: 'role_discussed',
      firstContactDate: 'first_contact_date'
    };
    for (const [jsKey, dbKey] of Object.entries(keyMap)) {
      if (contact[jsKey] !== undefined) {
        contact[dbKey] = contact[jsKey];
      }
    }

    const stmt = db.prepare(`
      INSERT INTO contacts (name, company, role, relationship_type, source, channel,
        first_contact_date, last_interaction_date, last_interaction_summary,
        next_follow_up_date, follow_up_action, status, notes, role_discussed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      contact.name, contact.company || null, contact.role || null,
      contact.relationship_type || null, contact.source || null, contact.channel || null,
      contact.first_contact_date || null, contact.last_interaction_date || null,
      contact.last_interaction_summary || null, contact.next_follow_up_date || null,
      contact.follow_up_action || null, contact.status || 'Active',
      contact.notes || null, contact.role_discussed || null
    );
    return result.lastInsertRowid;
  }
}

function getContactByNameAndCompany(db, name, company) {
  return db.prepare('SELECT * FROM contacts WHERE name = ? AND company = ?').get(name, company || null);
}

function getContacts(db) {
  return db.prepare('SELECT * FROM contacts ORDER BY last_interaction_date DESC').all();
}

function getContactsDueForFollowUp(db, date) {
  return db.prepare(`
    SELECT * FROM contacts
    WHERE next_follow_up_date IS NOT NULL
      AND next_follow_up_date <= ?
      AND status NOT IN ('Closed', 'Offer')
    ORDER BY next_follow_up_date ASC
  `).all(date);
}

module.exports = {
  initDb, insertMessage, getMessagesSince,
  upsertContact, getContactByNameAndCompany, getContacts, getContactsDueForFollowUp
};
```

**Step 4: Run tests**

```bash
node --test tests/db.test.js
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/db.js tests/db.test.js
git commit -m "feat: add SQLite database layer for messages and contacts"
```

---

### Task 3: Google OAuth2 Authentication

**Files:**
- Create: `src/google-auth.js`
- Create: `scripts/google-auth-setup.js`

This task sets up a reusable Google OAuth2 client used by Gmail, Calendar, and Sheets APIs.

**Step 1: Create the auth module**

```javascript
// src/google-auth.js
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
  const oauth2 = getOAuth2Client();
  if (fs.existsSync(TOKEN_PATH)) {
    return oauth2;
  }

  // Interactive auth flow
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('Authorize this app by visiting:\n', authUrl);

  const code = await new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const query = url.parse(req.url, true).query;
      if (query.code) {
        res.end('Authorization successful! You can close this tab.');
        server.close();
        resolve(query.code);
      }
    });
    server.listen(3000, () => {
      console.log('Waiting for authorization on http://localhost:3000 ...');
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
```

**Step 2: Create the one-time auth setup script**

```javascript
// scripts/google-auth-setup.js
const { authorize } = require('../src/google-auth');

(async () => {
  try {
    await authorize();
    console.log('Google OAuth2 setup complete!');
  } catch (err) {
    console.error('Auth failed:', err.message);
    process.exit(1);
  }
})();
```

**Step 3: Commit**

```bash
git add src/google-auth.js scripts/google-auth-setup.js
git commit -m "feat: add Google OAuth2 authentication module"
```

---

### Task 4: WhatsApp Collector Daemon

**Files:**
- Create: `src/whatsapp/collector.js`

**Step 1: Implement the collector**

```javascript
// src/whatsapp/collector.js
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initDb, insertMessage } = require('../db');

const db = initDb();

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('qr', (qr) => {
  console.log('Scan QR code to authenticate:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('WhatsApp client ready and listening for messages.');
});

client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    const contact = await msg.getContact();
    const isFromMe = msg.fromMe;

    insertMessage(db, {
      chatId: chat.id._serialized,
      contactName: isFromMe ? chat.name : contact.pushname || contact.name || 'Unknown',
      phone: contact.number || null,
      body: msg.body,
      timestamp: msg.timestamp * 1000,
      direction: isFromMe ? 'outgoing' : 'incoming',
      source: 'whatsapp'
    });
  } catch (err) {
    console.error('Error storing message:', err.message);
  }
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
  // Attempt reconnect after 30 seconds
  setTimeout(() => {
    console.log('Attempting reconnect...');
    client.initialize();
  }, 30000);
});

client.initialize();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down WhatsApp client...');
  await client.destroy();
  db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Shutting down WhatsApp client...');
  await client.destroy();
  db.close();
  process.exit(0);
});
```

**Step 2: Add npm scripts to package.json**

Add to `package.json` scripts:
```json
{
  "scripts": {
    "whatsapp": "node src/whatsapp/collector.js",
    "auth:google": "node scripts/google-auth-setup.js",
    "test": "node --test tests/**/*.test.js"
  }
}
```

**Step 3: Test manually**

```bash
npm run whatsapp
```
Expected: QR code appears in terminal. Scan with phone. Messages start getting stored.

**Step 4: Commit**

```bash
git add src/whatsapp/collector.js package.json
git commit -m "feat: add WhatsApp message collector daemon"
```

---

### Task 5: LLM Classification and Extraction

**Files:**
- Create: `src/llm/classifier.js`
- Create: `src/llm/extractor.js`
- Create: `tests/llm.test.js`

**Step 1: Write tests**

```javascript
// tests/llm.test.js
const { describe, it, mock } = require('node:test');
const assert = require('node:assert');

// These tests use mocked API responses to avoid real API calls
describe('LLM Classifier', () => {
  it('should classify job-hunt messages as relevant', async () => {
    const { classifyMessage } = require('../src/llm/classifier');
    // This test requires ANTHROPIC_API_KEY set - skip in CI
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await classifyMessage(
      'Hi, I saw your profile and we have a Senior Data Scientist role at Google. Would you be interested in chatting this week?'
    );
    assert.strictEqual(result, true);
  });

  it('should classify non-job messages as irrelevant', async () => {
    const { classifyMessage } = require('../src/llm/classifier');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await classifyMessage(
      'Hey want to grab dinner tonight? That new Thai place looks good.'
    );
    assert.strictEqual(result, false);
  });
});

describe('LLM Extractor', () => {
  it('should extract follow-up commitments', async () => {
    const { extractCommitments } = require('../src/llm/extractor');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await extractCommitments(
      'Great chatting with you! I will send over the job description by Friday March 7th. Let me know if you have questions.',
      'Jane Doe',
      '2026-03-04'
    );
    assert.ok(result.contactName);
    assert.ok(result.followUpDate || result.commitments?.length > 0);
  });
});
```

**Step 2: Implement classifier**

```javascript
// src/llm/classifier.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function classifyMessage(messageText) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Classify whether this message is related to a job search, career opportunity, recruiting, job application, professional networking for jobs, or interview scheduling. Reply with ONLY "yes" or "no".

Message: "${messageText}"`
    }]
  });

  const answer = response.content[0].text.trim().toLowerCase();
  return answer === 'yes';
}

async function classifyMessages(messages) {
  const results = [];
  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < messages.length; i += 5) {
    const batch = messages.slice(i, i + 5);
    const classified = await Promise.all(
      batch.map(async (msg) => ({
        ...msg,
        isJobRelated: await classifyMessage(msg.body)
      }))
    );
    results.push(...classified);
  }
  return results.filter(msg => msg.isJobRelated);
}

module.exports = { classifyMessage, classifyMessages };
```

**Step 3: Implement extractor**

```javascript
// src/llm/extractor.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function extractCommitments(messageText, contactName, todayDate) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this job-hunt related message and extract structured data. Today's date is ${todayDate}.

Message from/about: ${contactName}
Message: "${messageText}"

Return a JSON object with these fields (use null if not found):
{
  "contactName": "name of the person",
  "company": "their company",
  "roleTitle": "their job title/role",
  "relationshipType": "Recruiter | Hiring Manager | Referral | Network contact",
  "roleDiscussed": "specific job role being discussed",
  "interactionSummary": "one-line summary of this exchange",
  "followUpDate": "YYYY-MM-DD if a specific follow-up date is mentioned or implied",
  "followUpAction": "what needs to be done by the follow-up date",
  "status": "Active | Waiting | Interview Scheduled"
}

Return ONLY the JSON, no other text.`
    }]
  });

  try {
    const text = response.content[0].text.trim();
    // Handle potential markdown code blocks
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse LLM response:', response.content[0].text);
    return null;
  }
}

module.exports = { extractCommitments };
```

**Step 4: Run tests (with API key)**

```bash
ANTHROPIC_API_KEY=your-key node --test tests/llm.test.js
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/llm/classifier.js src/llm/extractor.js tests/llm.test.js
git commit -m "feat: add LLM classifier (Haiku) and commitment extractor (Sonnet)"
```

---

### Task 6: Gmail Scanner

**Files:**
- Create: `src/gmail/scanner.js`

**Step 1: Implement Gmail scanner**

```javascript
// src/gmail/scanner.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');
const { insertMessage } = require('../db');

async function scanEmails(db, daysBack = 7) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterEpoch = Math.floor(after.getTime() / 1000);

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${afterEpoch}`,
    maxResults: 100
  });

  const messages = res.data.messages || [];
  const results = [];

  for (const msgRef of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: msgRef.id,
      format: 'full'
    });

    const headers = msg.data.payload.headers;
    const from = headers.find(h => h.name === 'From')?.value || '';
    const to = headers.find(h => h.name === 'To')?.value || '';
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    const threadId = msg.data.threadId;

    const body = extractBody(msg.data.payload);
    const selfEmail = process.env.GMAIL_SELF_EMAIL;
    const isFromMe = from.includes(selfEmail);
    const contactEmail = isFromMe ? to : from;
    const contactName = extractName(contactEmail);

    // Store in local DB
    insertMessage(db, {
      chatId: threadId,
      contactName,
      phone: null,
      body: `Subject: ${subject}\n\n${body}`.substring(0, 5000),
      timestamp: new Date(date).getTime(),
      direction: isFromMe ? 'outgoing' : 'incoming',
      source: 'gmail'
    });

    results.push({
      threadId,
      contactName,
      contactEmail,
      subject,
      body: body.substring(0, 3000),
      timestamp: new Date(date).getTime(),
      direction: isFromMe ? 'outgoing' : 'incoming'
    });
  }

  return results;
}

function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    // Fallback to HTML
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

function extractName(emailStr) {
  // "Jane Doe <jane@example.com>" -> "Jane Doe"
  const match = emailStr.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  // Plain email
  return emailStr.replace(/<.*>/, '').trim() || emailStr;
}

module.exports = { scanEmails };
```

**Step 2: Commit**

```bash
git add src/gmail/scanner.js
git commit -m "feat: add Gmail scanner - fetches and stores recent emails"
```

---

### Task 7: Google Calendar Scanner

**Files:**
- Create: `src/calendar/scanner.js`

**Step 1: Implement Calendar scanner**

```javascript
// src/calendar/scanner.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');

async function scanCalendar(daysAhead = 3) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = res.data.items || [];

  return events.map(event => ({
    id: event.id,
    summary: event.summary || 'No title',
    description: event.description || '',
    start: event.start.dateTime || event.start.date,
    end: event.end.dateTime || event.end.date,
    attendees: (event.attendees || []).map(a => ({
      email: a.email,
      name: a.displayName || a.email,
      status: a.responseStatus
    })),
    location: event.location || '',
    htmlLink: event.htmlLink
  }));
}

module.exports = { scanCalendar };
```

**Step 2: Commit**

```bash
git add src/calendar/scanner.js
git commit -m "feat: add Google Calendar scanner"
```

---

### Task 8: Google Sheets CRM Updater

**Files:**
- Create: `src/sheets/updater.js`

**Step 1: Implement Sheets updater**

```javascript
// src/sheets/updater.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');

const SHEET_COLUMNS = [
  'Contact Name', 'Company', 'Role/Title', 'Relationship Type',
  'Source', 'Channel', 'First Contact Date', 'Last Interaction Date',
  'Last Interaction Summary', 'Next Follow-up Date', 'Follow-up Action',
  'Status', 'Notes', 'Role Discussed'
];

async function initSheet(sheetId) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  // Check if header row exists
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:N1'
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:N1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_COLUMNS] }
    });
  }
}

async function getAllRows(sheetId) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A:N'
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return []; // Only header or empty

  return rows.slice(1).map((row, idx) => ({
    rowIndex: idx + 2, // 1-indexed, skip header
    name: row[0] || '',
    company: row[1] || '',
    role: row[2] || '',
    relationshipType: row[3] || '',
    source: row[4] || '',
    channel: row[5] || '',
    firstContactDate: row[6] || '',
    lastInteractionDate: row[7] || '',
    lastInteractionSummary: row[8] || '',
    nextFollowUpDate: row[9] || '',
    followUpAction: row[10] || '',
    status: row[11] || '',
    notes: row[12] || '',
    roleDiscussed: row[13] || ''
  }));
}

async function upsertRow(sheetId, contact) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const existing = await getAllRows(sheetId);

  // Fuzzy match: exact name + company match
  const match = existing.find(r =>
    r.name.toLowerCase() === (contact.contactName || '').toLowerCase() &&
    r.company.toLowerCase() === (contact.company || '').toLowerCase()
  );

  const rowData = [
    contact.contactName || '',
    contact.company || '',
    contact.roleTitle || '',
    contact.relationshipType || '',
    contact.source || '',
    contact.channel || '',
    contact.firstContactDate || '',
    contact.lastInteractionDate || new Date().toISOString().split('T')[0],
    contact.interactionSummary || '',
    contact.followUpDate || '',
    contact.followUpAction || '',
    contact.status || 'Active',
    contact.notes || '',
    contact.roleDiscussed || ''
  ];

  if (match) {
    // Update existing row - only update non-empty fields
    const updatedRow = [
      rowData[0] || match.name,
      rowData[1] || match.company,
      rowData[2] || match.role,
      rowData[3] || match.relationshipType,
      rowData[4] || match.source,
      rowData[5] || match.channel,
      match.firstContactDate || rowData[6], // Preserve first contact date
      rowData[7] || match.lastInteractionDate,
      rowData[8] || match.lastInteractionSummary,
      rowData[9] || match.nextFollowUpDate,
      rowData[10] || match.followUpAction,
      rowData[11] || match.status,
      match.notes ? `${match.notes}\n${rowData[12]}`.trim() : rowData[12],
      rowData[13] || match.roleDiscussed
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Sheet1!A${match.rowIndex}:N${match.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updatedRow] }
    });
    return { action: 'updated', row: match.rowIndex };
  } else {
    // Append new row
    rowData[6] = rowData[6] || new Date().toISOString().split('T')[0]; // Set first contact date
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:N',
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] }
    });
    return { action: 'added', name: contact.contactName };
  }
}

module.exports = { initSheet, getAllRows, upsertRow, SHEET_COLUMNS };
```

**Step 2: Commit**

```bash
git add src/sheets/updater.js
git commit -m "feat: add Google Sheets CRM updater with upsert logic"
```

---

### Task 9: Daily Email Summary

**Files:**
- Create: `src/summary/emailer.js`

**Step 1: Implement the emailer**

```javascript
// src/summary/emailer.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');
const { getContactsDueForFollowUp } = require('../db');

async function sendDailySummary(db, calendarEvents) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const today = new Date().toISOString().split('T')[0];

  // Get follow-ups from local DB
  const overdue = getContactsDueForFollowUp(db, today);
  const todayFollowUps = overdue.filter(c => c.next_follow_up_date === today);
  const overdueFollowUps = overdue.filter(c => c.next_follow_up_date < today);

  // Build email HTML
  const html = buildEmailHtml(todayFollowUps, overdueFollowUps, calendarEvents, today);

  const message = [
    `To: ${selfEmail}`,
    'Content-Type: text/html; charset=utf-8',
    `Subject: Job Hunt CRM - Daily Summary for ${today}`,
    '',
    html
  ].join('\n');

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage }
  });

  console.log('Daily summary email sent.');
}

function buildEmailHtml(todayFollowUps, overdueFollowUps, calendarEvents, today) {
  let html = `<h2>Job Hunt CRM - ${today}</h2>`;

  // Overdue
  if (overdueFollowUps.length > 0) {
    html += '<h3 style="color: #cc0000;">Overdue Follow-ups</h3><ul>';
    for (const c of overdueFollowUps) {
      html += `<li><strong>${c.name}</strong> (${c.company || 'Unknown'}) - Due: ${c.next_follow_up_date}<br/>`;
      html += `Action: ${c.follow_up_action || 'Follow up'}</li>`;
    }
    html += '</ul>';
  }

  // Today
  if (todayFollowUps.length > 0) {
    html += '<h3 style="color: #0066cc;">Due Today</h3><ul>';
    for (const c of todayFollowUps) {
      html += `<li><strong>${c.name}</strong> (${c.company || 'Unknown'})<br/>`;
      html += `Action: ${c.follow_up_action || 'Follow up'}</li>`;
    }
    html += '</ul>';
  }

  // Calendar
  if (calendarEvents && calendarEvents.length > 0) {
    html += '<h3>Upcoming Calendar Events</h3><ul>';
    for (const e of calendarEvents) {
      const time = new Date(e.start).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      html += `<li><strong>${e.summary}</strong> - ${time}`;
      if (e.location) html += ` (${e.location})`;
      html += '</li>';
    }
    html += '</ul>';
  }

  if (overdueFollowUps.length === 0 && todayFollowUps.length === 0 &&
      (!calendarEvents || calendarEvents.length === 0)) {
    html += '<p>No follow-ups due and no upcoming events. Enjoy the day!</p>';
  }

  return html;
}

module.exports = { sendDailySummary };
```

**Step 2: Commit**

```bash
git add src/summary/emailer.js
git commit -m "feat: add daily email summary sender"
```

---

### Task 10: Daily Scanner - Main Orchestrator

**Files:**
- Create: `src/daily-scan.js`

**Step 1: Implement the orchestrator**

```javascript
// src/daily-scan.js
require('dotenv').config();
const { initDb, getMessagesSince, upsertContact } = require('./db');
const { scanEmails } = require('./gmail/scanner');
const { scanCalendar } = require('./calendar/scanner');
const { classifyMessages } = require('./llm/classifier');
const { extractCommitments } = require('./llm/extractor');
const { initSheet, upsertRow } = require('./sheets/updater');
const { sendDailySummary } = require('./summary/emailer');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function dailyScan() {
  console.log(`[${new Date().toISOString()}] Starting daily scan...`);
  const db = initDb();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const today = new Date().toISOString().split('T')[0];

  await initSheet(sheetId);

  // Step 1: Scan all sources in parallel
  console.log('Scanning Gmail, Calendar, and WhatsApp...');
  const [emailMessages, calendarEvents, whatsappMessages] = await Promise.all([
    scanEmails(db).catch(err => {
      console.error('Gmail scan failed:', err.message);
      return [];
    }),
    scanCalendar().catch(err => {
      console.error('Calendar scan failed:', err.message);
      return [];
    }),
    Promise.resolve(getMessagesSince(db, 'whatsapp', Date.now() - SEVEN_DAYS_MS))
  ]);

  console.log(`Found: ${emailMessages.length} emails, ${calendarEvents.length} calendar events, ${whatsappMessages.length} WhatsApp messages`);

  // Step 2: Classify all messages
  console.log('Classifying messages...');
  const allMessages = [
    ...emailMessages.map(m => ({ ...m, source: 'Email' })),
    ...whatsappMessages.map(m => ({
      body: m.body,
      contactName: m.contact_name,
      source: 'WhatsApp'
    }))
  ];

  const jobRelated = await classifyMessages(allMessages);
  console.log(`${jobRelated.length} job-related messages found.`);

  // Step 3: Extract commitments from job-related messages
  console.log('Extracting commitments...');
  const commitments = [];
  for (const msg of jobRelated) {
    const extracted = await extractCommitments(msg.body, msg.contactName, today);
    if (extracted) {
      extracted.channel = msg.source;
      commitments.push(extracted);
    }
  }

  // Step 4: Classify calendar events too
  const calendarClassified = await classifyMessages(
    calendarEvents.map(e => ({
      body: `${e.summary} ${e.description}`.trim(),
      contactName: e.attendees?.[0]?.name || e.summary,
      source: 'Calendar'
    }))
  );

  // Step 5: Update Google Sheet and local DB
  console.log('Updating CRM...');
  let added = 0, updated = 0;
  for (const commitment of commitments) {
    if (!commitment.contactName) continue;

    // Update local DB
    upsertContact(db, {
      name: commitment.contactName,
      company: commitment.company,
      role: commitment.roleTitle,
      relationshipType: commitment.relationshipType,
      channel: commitment.channel,
      lastInteractionDate: today,
      lastInteractionSummary: commitment.interactionSummary,
      nextFollowUpDate: commitment.followUpDate,
      followUpAction: commitment.followUpAction,
      status: commitment.status,
      roleDiscussed: commitment.roleDiscussed
    });

    // Update Google Sheet
    const result = await upsertRow(sheetId, {
      ...commitment,
      lastInteractionDate: today
    });
    if (result.action === 'added') added++;
    else updated++;
  }

  console.log(`CRM updated: ${added} new contacts, ${updated} updated.`);

  // Step 6: Send daily summary email
  console.log('Sending daily summary...');
  const jobCalendarEvents = calendarClassified.length > 0
    ? calendarEvents.filter((_, i) =>
        calendarClassified.some(c => c.body?.includes(calendarEvents[i]?.summary))
      )
    : calendarEvents; // If classification fails, include all

  await sendDailySummary(db, jobCalendarEvents);

  db.close();
  console.log(`[${new Date().toISOString()}] Daily scan complete.`);
}

dailyScan().catch(err => {
  console.error('Daily scan failed:', err);
  process.exit(1);
});
```

**Step 2: Add npm script**

Add to `package.json` scripts:
```json
{
  "scan": "node src/daily-scan.js"
}
```

**Step 3: Test manually**

```bash
npm run scan
```
Expected: Scans emails, classifies, extracts, updates sheet, sends summary email.

**Step 4: Commit**

```bash
git add src/daily-scan.js package.json
git commit -m "feat: add daily scanner orchestrator"
```

---

### Task 11: macOS launchd Configuration

**Files:**
- Create: `launchd/com.jobcrm.whatsapp.plist`
- Create: `launchd/com.jobcrm.daily-scan.plist`
- Create: `scripts/install-launchd.sh`

**Step 1: Create WhatsApp daemon plist**

```xml
<!-- launchd/com.jobcrm.whatsapp.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jobcrm.whatsapp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/Karthik/Documents/work/vibes/job-crm/src/whatsapp/collector.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm/data/whatsapp.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm/data/whatsapp-error.log</string>
</dict>
</plist>
```

**Step 2: Create daily scan plist**

```xml
<!-- launchd/com.jobcrm.daily-scan.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jobcrm.daily-scan</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/Karthik/Documents/work/vibes/job-crm/src/daily-scan.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm/data/daily-scan.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/Karthik/Documents/work/vibes/job-crm/data/daily-scan-error.log</string>
</dict>
</plist>
```

**Step 3: Create install script**

```bash
#!/bin/bash
# scripts/install-launchd.sh
set -e

# Get the actual node path
NODE_PATH=$(which node)
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Project dir: $PROJECT_DIR"
echo "Node path: $NODE_PATH"

# Update plists with correct node path
for plist in "$PROJECT_DIR"/launchd/*.plist; do
    sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$plist"
    sed -i '' "s|/Users/Karthik/Documents/work/vibes/job-crm|$PROJECT_DIR|g" "$plist"
done

# Copy to LaunchAgents
cp "$PROJECT_DIR/launchd/com.jobcrm.whatsapp.plist" ~/Library/LaunchAgents/
cp "$PROJECT_DIR/launchd/com.jobcrm.daily-scan.plist" ~/Library/LaunchAgents/

# Load them
launchctl load ~/Library/LaunchAgents/com.jobcrm.whatsapp.plist
launchctl load ~/Library/LaunchAgents/com.jobcrm.daily-scan.plist

echo "LaunchAgents installed and loaded."
echo "WhatsApp collector will run immediately and stay alive."
echo "Daily scan will run at 7:00 AM every day."
```

**Step 4: Commit**

```bash
chmod +x scripts/install-launchd.sh
git add launchd/ scripts/install-launchd.sh
git commit -m "feat: add macOS launchd configs for daemon and daily cron"
```

---

### Task 12: README and Setup Documentation

**Files:**
- Create: `README.md`

**Step 1: Write README**

```markdown
# Job Hunt CRM

Automated CRM for job hunting. Scans Gmail, Google Calendar, and WhatsApp daily to track contacts, extract follow-up commitments, and send a morning summary email.

## How It Works

1. **WhatsApp Collector** runs as a background daemon, storing all messages in a local SQLite database
2. **Daily Scanner** (7 AM) scans Gmail (7-day window), Calendar (3 days ahead), and WhatsApp messages
3. **Claude AI** classifies messages as job-related, then extracts contacts, companies, and follow-up commitments
4. **Google Sheet** is updated with new/updated contacts
5. **Summary email** is sent with today's follow-ups, overdue items, and upcoming events

## Prerequisites

- Node.js 18+
- Google Cloud project with Gmail, Calendar, and Sheets APIs enabled
- Anthropic API key
- WhatsApp account

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd job-crm
npm install
```

### 2. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project, enable Gmail API, Calendar API, and Sheets API
3. Create OAuth2 credentials (Desktop app)
4. Download as `auth/google-credentials.json`

### 3. Environment variables

```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Authenticate with Google

```bash
npm run auth:google
```

### 5. Create Google Sheet

Create a new Google Sheet. Copy its ID from the URL and add to `.env` as `GOOGLE_SHEET_ID`.

### 6. Start WhatsApp collector

```bash
npm run whatsapp
# Scan QR code with your phone
```

### 7. Run daily scan manually (to test)

```bash
npm run scan
```

### 8. Install as background services

```bash
bash scripts/install-launchd.sh
```

## Scripts

- `npm run whatsapp` - Start WhatsApp collector
- `npm run scan` - Run daily scan manually
- `npm run auth:google` - Set up Google OAuth
- `npm test` - Run tests
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup instructions"
```
