# LinkedIn DM Integration - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add LinkedIn DMs/InMail to the daily CRM scan by using Puppeteer to intercept LinkedIn's internal messaging API via cookie-based auth from the user's Chrome profile.

**Architecture:** A new `src/linkedin/scanner.js` module copies LinkedIn session cookies from Chrome's SQLite cookie store, launches a headless Puppeteer browser, intercepts network responses from LinkedIn's messaging API, and returns normalized messages. `daily-scan.js` calls this scanner in parallel with Gmail/WhatsApp/Calendar.

**Tech Stack:** Puppeteer, better-sqlite3 (to read Chrome's cookie DB)

---

### Task 1: Install Puppeteer

**Files:**
- Modify: `package.json`

**Step 1: Install puppeteer**

Run: `npm install puppeteer`

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add puppeteer dependency for LinkedIn scanner"
```

---

### Task 2: Build the cookie extractor

**Files:**
- Create: `src/linkedin/cookies.js`

**Step 1: Write the cookie extractor**

This module reads Chrome's Cookies SQLite database and extracts LinkedIn session cookies. On macOS, Chrome encrypts cookie values using the Keychain. We use the `chrome-cookies-secure` approach: decrypt via `security find-generic-password` for the Chrome Safe Storage key, then AES-128-CBC decrypt.

However, a simpler approach: use Puppeteer with `--user-data-dir` pointing to a **copy** of just the relevant Chrome profile data. But since we agreed on cookie extraction, here's the direct approach using `safeStorage` decryption:

```js
// src/linkedin/cookies.js
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_COOKIES_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

function getChromeDecryptionKey() {
  const rawKey = execSync(
    'security find-generic-password -s "Chrome Safe Storage" -w',
    { encoding: 'utf8' }
  ).trim();
  return crypto.pbkdf2Sync(rawKey, 'saltysalt', 1003, 16, 'sha1');
}

function decryptValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';
  // Chrome on macOS prefixes encrypted values with 'v10'
  const prefix = encryptedValue.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') {
    return encryptedValue.toString('utf8');
  }
  const iv = Buffer.alloc(16, ' ');
  const data = encryptedValue.slice(3);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(data);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

function getLinkedInCookies() {
  // Copy the cookies DB to a temp file to avoid locking issues with Chrome
  const tmpPath = path.join(os.tmpdir(), `chrome-cookies-${Date.now()}.sqlite`);
  fs.copyFileSync(CHROME_COOKIES_PATH, tmpPath);

  const key = getChromeDecryptionKey();
  const db = new Database(tmpPath, { readonly: true });

  const rows = db.prepare(
    `SELECT name, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly
     FROM cookies
     WHERE host_key LIKE '%linkedin.com%'
       AND name IN ('li_at', 'JSESSIONID', 'li_rm')`
  ).all();

  db.close();
  fs.unlinkSync(tmpPath);

  return rows.map(row => ({
    name: row.name,
    value: decryptValue(row.encrypted_value, key),
    domain: row.host_key.startsWith('.') ? row.host_key : `.${row.host_key}`,
    path: row.path,
    secure: Boolean(row.is_secure),
    httpOnly: Boolean(row.is_httponly),
  }));
}

module.exports = { getLinkedInCookies };
```

**Step 2: Test manually**

Run: `node -e "const {getLinkedInCookies} = require('./src/linkedin/cookies'); const c = getLinkedInCookies(); console.log(c.map(c => ({name: c.name, hasValue: !!c.value})))"`

Expected: Array showing `li_at` and `JSESSIONID` with `hasValue: true`.

**Step 3: Commit**

```bash
git add src/linkedin/cookies.js
git commit -m "feat: add Chrome cookie extractor for LinkedIn auth"
```

---

### Task 3: Build the LinkedIn scanner

**Files:**
- Create: `src/linkedin/scanner.js`

**Step 1: Write the scanner**

```js
// src/linkedin/scanner.js
const puppeteer = require('puppeteer');
const { getLinkedInCookies } = require('./cookies');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function scanLinkedIn() {
  console.log('  LinkedIn: extracting cookies from Chrome...');
  let cookies;
  try {
    cookies = getLinkedInCookies();
  } catch (err) {
    console.error('  LinkedIn: failed to extract cookies:', err.message);
    return [];
  }

  const liAt = cookies.find(c => c.name === 'li_at');
  if (!liAt || !liAt.value) {
    console.error('  LinkedIn: no valid session cookie found. Log into LinkedIn in Chrome.');
    return [];
  }

  console.log('  LinkedIn: launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Set cookies before navigating
    await page.setCookie(...cookies.map(c => ({
      ...c,
      domain: c.domain || '.linkedin.com'
    })));

    // Intercept messaging API responses
    const messages = [];
    const cutoff = Date.now() - SEVEN_DAYS_MS;

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/messaging/') || response.status() !== 200) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        const json = await response.json();
        extractMessagesFromResponse(json, messages, cutoff);
      } catch (e) {
        // Not all responses are parseable, that's fine
      }
    });

    // Navigate to messaging
    console.log('  LinkedIn: loading messages...');
    await page.goto('https://www.linkedin.com/messaging/', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    // Check if we're logged in
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
      console.error('  LinkedIn: session expired. Log into LinkedIn in Chrome to refresh.');
      return [];
    }

    // Scroll to load more conversations (last 7 days)
    await loadConversations(page);

    // Click into conversations to load message details
    await loadMessageDetails(page);

    console.log(`  LinkedIn: captured ${messages.length} messages from last 7 days`);
    return messages;
  } finally {
    await browser.close();
  }
}

function extractMessagesFromResponse(json, messages, cutoff) {
  // LinkedIn's messaging API returns data in various nested structures.
  // The key fields are in `elements` arrays within the response.
  const elements = findElements(json);

  for (const el of elements) {
    try {
      const timestamp = el.deliveredAt || el.createdAt || el.lastActivityAt;
      if (!timestamp || timestamp < cutoff) continue;

      const body = extractMessageBody(el);
      if (!body) continue;

      const sender = extractSenderName(el);
      if (!sender) continue;

      const isSelf = isSelfMessage(el);

      messages.push({
        body,
        contactName: sender,
        source: 'linkedin',
        direction: isSelf ? 'outgoing' : 'incoming',
        messageDate: new Date(timestamp).toISOString()
      });
    } catch (e) {
      // Skip unparseable elements
    }
  }
}

function findElements(obj) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findElements(item));
    }
  } else {
    // If this object looks like a message element, include it
    if (obj.deliveredAt || obj.createdAt || obj.body || obj.eventContent) {
      results.push(obj);
    }
    // Also recurse into known container fields
    for (const key of ['elements', 'events', 'results', 'included', 'data']) {
      if (obj[key]) {
        results.push(...findElements(obj[key]));
      }
    }
  }
  return results;
}

function extractMessageBody(el) {
  // Messages can be in various formats
  if (typeof el.body === 'string') return el.body;
  if (el.body?.text) return el.body.text;
  if (el.eventContent?.messageEvent?.body) return el.eventContent.messageEvent.body;
  if (el.eventContent?.messageEvent?.attributedBody?.text) {
    return el.eventContent.messageEvent.attributedBody.text;
  }
  return null;
}

function extractSenderName(el) {
  // Try various paths where the sender info might be
  const participant = el.from || el.sender || el.actor;
  if (!participant) {
    // Try nested in messaging member
    const member = el.from?.['com.linkedin.voyager.messaging.MessagingMember']
      || el.from?.messagingMember;
    if (member?.miniProfile) {
      const p = member.miniProfile;
      return [p.firstName, p.lastName].filter(Boolean).join(' ');
    }
    return null;
  }

  if (typeof participant === 'string') return null;

  // Direct name fields
  if (participant.firstName || participant.lastName) {
    return [participant.firstName, participant.lastName].filter(Boolean).join(' ');
  }

  // Nested miniProfile
  if (participant.miniProfile) {
    const p = participant.miniProfile;
    return [p.firstName, p.lastName].filter(Boolean).join(' ');
  }

  // MessagingMember structure
  if (participant.messagingMember?.miniProfile) {
    const p = participant.messagingMember.miniProfile;
    return [p.firstName, p.lastName].filter(Boolean).join(' ');
  }

  return participant.name || null;
}

function isSelfMessage(el) {
  const participant = el.from || el.sender || el.actor;
  if (!participant) return false;

  // LinkedIn marks self-sent messages with 'me' URN or similar
  const urn = participant.entityUrn || participant['*miniProfile'] || '';
  // We'll also check by looking at the from field structure
  // This may need adjustment based on actual API responses
  return false; // Conservative default - will be refined during testing
}

async function loadConversations(page) {
  // Scroll the conversation list to load older threads
  const scrollAttempts = 5;
  for (let i = 0; i < scrollAttempts; i++) {
    await page.evaluate(() => {
      const list = document.querySelector('.msg-conversations-container__conversations-list')
        || document.querySelector('[class*="conversations"]')
        || document.querySelector('.scaffold-layout__list');
      if (list) list.scrollTop = list.scrollHeight;
    });
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function loadMessageDetails(page) {
  // Click on conversation threads to trigger message loading
  const threadSelectors = [
    '.msg-conversation-listitem__link',
    '.msg-conversation-card__content--selectable',
    '[class*="conversation-list"] li a'
  ];

  for (const selector of threadSelectors) {
    const threads = await page.$$(selector);
    if (threads.length > 0) {
      // Click each thread, wait for messages to load
      for (const thread of threads.slice(0, 20)) { // cap at 20 conversations
        try {
          await thread.click();
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          // Thread may have gone stale
        }
      }
      break;
    }
  }
}

module.exports = { scanLinkedIn };
```

**Step 2: Test manually**

Run: `node -e "const {scanLinkedIn} = require('./src/linkedin/scanner'); scanLinkedIn().then(m => { console.log(JSON.stringify(m.slice(0, 3), null, 2)); console.log('Total:', m.length); })"`

Expected: Array of message objects with `body`, `contactName`, `source`, `direction`, `messageDate`.

**Step 3: Debug and refine**

The API response structure will need to be verified against actual LinkedIn responses. After the first test run:
1. Add `console.log(JSON.stringify(json, null, 2).slice(0, 2000))` inside the response handler to see actual response shapes
2. Adjust `extractMessagesFromResponse`, `extractSenderName`, and `isSelfMessage` based on what LinkedIn actually returns

**Step 4: Commit**

```bash
git add src/linkedin/scanner.js
git commit -m "feat: add LinkedIn DM scanner with Puppeteer and network interception"
```

---

### Task 4: Integrate into daily scan

**Files:**
- Modify: `src/daily-scan.js:1-10` (add import)
- Modify: `src/daily-scan.js:74-90` (add to Promise.all and message mapping)

**Step 1: Add import at top of daily-scan.js**

After line 4 (`const { scanCalendar, scanPastEvents } = require('./calendar/scanner');`), add:

```js
const { scanLinkedIn } = require('./linkedin/scanner');
```

**Step 2: Add LinkedIn to Promise.all**

Change the Promise.all block (lines 74-88) to include LinkedIn:

```js
  const [emailMessages, upcomingEvents, pastEvents, whatsappMessages, linkedinMessages] = await Promise.all([
    scanEmails(db).catch(err => {
      console.error('Gmail scan failed:', err.message);
      return [];
    }),
    scanCalendar().catch(err => {
      console.error('Calendar scan failed:', err.message);
      return [];
    }),
    scanPastEvents().catch(err => {
      console.error('Past calendar scan failed:', err.message);
      return [];
    }),
    Promise.resolve(getMessagesSince(db, 'whatsapp', Date.now() - SEVEN_DAYS_MS)),
    scanLinkedIn().catch(err => {
      console.error('LinkedIn scan failed:', err.message);
      return [];
    })
  ]);
```

**Step 3: Update the log line**

Change line 90 to include LinkedIn count:

```js
  console.log(`Found: ${emailMessages.length} emails, ${pastEvents.length} past events, ${upcomingEvents.length} upcoming events, ${whatsappMessages.length} WhatsApp messages, ${linkedinMessages.length} LinkedIn messages`);
```

**Step 4: Add LinkedIn messages to allMessages array**

After the WhatsApp mapping (line 106), add LinkedIn messages. Insert before the closing `];`:

```js
    ...linkedinMessages.map(m => ({
      body: m.body,
      contactName: m.contactName,
      source: 'LinkedIn',
      direction: m.direction,
      messageDate: m.messageDate.split('T')[0]
    }))
```

**Step 5: Store LinkedIn messages in DB**

Add a block after the Promise.all to persist LinkedIn messages, before the classify step. After the log line (line 90 area):

```js
  // Store LinkedIn messages in DB
  for (const msg of linkedinMessages) {
    insertMessage(db, {
      chatId: null,
      contactName: msg.contactName,
      phone: null,
      body: msg.body?.substring(0, 5000),
      timestamp: new Date(msg.messageDate).getTime(),
      direction: msg.direction,
      source: 'linkedin'
    });
  }
```

**Step 6: Test the full scan**

Run: `node src/daily-scan.js`

Expected: Log output shows LinkedIn messages count alongside other sources. Messages flow through classify/extract/upsert.

**Step 7: Commit**

```bash
git add src/daily-scan.js
git commit -m "feat: integrate LinkedIn scanner into daily scan pipeline"
```

---

### Task 5: End-to-end verification

**Step 1: Run full daily scan and verify output**

Run: `node src/daily-scan.js`

Check:
- LinkedIn messages appear in the log counts
- Job-related LinkedIn messages are classified correctly
- Extracted commitments show `channel: 'LinkedIn'`
- Companies table is updated with LinkedIn contacts
- Google Sheet has LinkedIn entries

**Step 2: Verify DB contents**

Run: `node -e "const {initDb, getMessagesSince} = require('./src/db'); const db = initDb(); const msgs = getMessagesSince(db, 'linkedin', 0); console.log('LinkedIn messages:', msgs.length); msgs.slice(0,3).forEach(m => console.log(m.contact_name, m.direction, m.body?.slice(0,80)))"`

**Step 3: Final commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: refine LinkedIn scanner based on e2e testing"
```
