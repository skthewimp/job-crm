// src/gmail/scanner.js
const { google } = require('googleapis');
const { getOAuth2Client, getExtraGmailClients } = require('../google-auth');
const { insertMessage } = require('../db');
const { getGmailSelfEmail } = require('../config');

async function scanEmails(db, daysBack = 7) {
  const after = new Date();
  after.setDate(after.getDate() - daysBack);
  const afterEpoch = Math.floor(after.getTime() / 1000);

  // Scan primary account
  const primaryAuth = getOAuth2Client();
  const selfEmail = getGmailSelfEmail();
  const results = await scanOneAccount(db, primaryAuth, selfEmail, afterEpoch);

  // Scan extra Gmail accounts (read-only)
  const extraClients = getExtraGmailClients();
  for (const { auth, email } of extraClients) {
    try {
      console.log(`  Scanning extra Gmail: ${email}...`);
      const extraResults = await scanOneAccount(db, auth, email, afterEpoch);
      results.push(...extraResults);
      console.log(`  Found ${extraResults.length} emails from ${email}`);
    } catch (err) {
      console.error(`  Failed to scan ${email}:`, err.message);
    }
  }

  return results;
}

async function scanOneAccount(db, auth, ownerEmail, afterEpoch) {
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${afterEpoch}`,
    maxResults: 100
  });

  const messages = res.data.messages || [];
  const results = [];

  // Build set of all owner emails for direction detection
  const ownerEmails = getOwnerEmails();

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
    const isFromMe = ownerEmails.some(e => from.toLowerCase().includes(e));
    const contactEmail = isFromMe ? to : from;
    const contactName = extractName(contactEmail);

    insertMessage(db, {
      chatId: `${ownerEmail}:${threadId}`,
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

function getOwnerEmails() {
  const emails = new Set();
  const primary = getGmailSelfEmail();
  if (primary) emails.add(primary.toLowerCase());

  const extra = (process.env.GMAIL_EXTRA_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const e of extra) emails.add(e.toLowerCase());

  return Array.from(emails);
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
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
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
  const match = emailStr.match(/^"?([^"<]+)"?\s*</);
  if (match) return match[1].trim();
  return emailStr.replace(/<.*>/, '').trim() || emailStr;
}

module.exports = { scanEmails };
