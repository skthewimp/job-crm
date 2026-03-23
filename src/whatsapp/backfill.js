// src/whatsapp/backfill.js
// Fetches last 24 hours of WhatsApp messages and saves to DB.
// Run as part of daily scan instead of keeping a persistent daemon.

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initDb, insertMessage, insertCall } = require('../db');

const DM_LOOKBACK_MS = 24 * 60 * 60 * 1000;    // 24 hours for DMs
const GROUP_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000; // 3 days for groups

// ---------------------------------------------------------------------------
// Group scanning config (read from .env)
// Set WHATSAPP_SCAN_GROUPS=Group A,College Discussions,Friends Chat
// ---------------------------------------------------------------------------
const SCAN_GROUPS = (process.env.WHATSAPP_SCAN_GROUPS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
// ---------------------------------------------------------------------------

function waitForReady(client) {
  return new Promise((resolve, reject) => {
    client.on('ready', resolve);
    client.on('auth_failure', () => reject(new Error('WhatsApp auth failed')));
    client.on('qr', (qr) => {
      console.log('Scan QR code to authenticate:');
      qrcode.generate(qr, { small: true });
    });
    setTimeout(() => reject(new Error('WhatsApp client timed out after 60s')), 60000);
  });
}

async function fetchDmMessages(client, db, since) {
  const chats = await client.getChats();
  const dmChats = chats.filter(c => !c.isGroup);

  console.log(`  Found ${dmChats.length} DM chats, fetching messages since ${new Date(since).toISOString()}...`);

  let saved = 0;
  for (const chat of dmChats) {
    const messages = await chat.fetchMessages({ limit: 100 });
    const recent = messages.filter(m => m.timestamp * 1000 >= since && m.body);

    for (const msg of recent) {
      let contactName = chat.name || 'Unknown';
      let phone = null;
      try {
        const contact = await msg.getContact();
        if (!msg.fromMe) {
          contactName = contact.pushname || contact.name || chat.name || 'Unknown';
        }
        phone = contact.number || null;
      } catch (_) {
        // Some messages lack valid contact data — fall back to chat name
      }
      insertMessage(db, {
        chatId: chat.id._serialized,
        contactName,
        phone,
        body: msg.body,
        timestamp: msg.timestamp * 1000,
        direction: msg.fromMe ? 'outgoing' : 'incoming',
        source: 'whatsapp',
      });
      saved++;
    }
  }

  console.log(`  Saved ${saved} DM messages from last 24 hours.`);
  return saved;
}

// ---------------------------------------------------------------------------
// GROUP SCANNING — only runs if WHATSAPP_SCAN_GROUPS is set in .env.
// ---------------------------------------------------------------------------
async function fetchGroupMessages(client, db, since) {
  if (SCAN_GROUPS.length === 0) {
    console.log('  WHATSAPP_SCAN_GROUPS not set, skipping group scan.');
    return 0;
  }

  const chats = await client.getChats();
  const groupChats = chats.filter(c => {
    if (!c.isGroup) return false;
    const name = (c.name || '').toLowerCase();
    return SCAN_GROUPS.some(g => name.includes(g));
  });

  if (groupChats.length === 0) {
    console.log('  No matching group chats found. Check WHATSAPP_SCAN_GROUPS in .env.');
    return 0;
  }

  console.log(`  Found ${groupChats.length} matching group(s): ${groupChats.map(c => c.name).join(', ')}`);

  let saved = 0;
  for (const chat of groupChats) {
    const messages = await chat.fetchMessages({ limit: 200 });
    const recent = messages.filter(m => m.timestamp * 1000 >= since && m.body);

    for (const msg of recent) {
      let contactName = 'Unknown';
      let phone = null;
      try {
        const contact = await msg.getContact();
        contactName = contact.pushname || contact.name || 'Unknown';
        phone = contact.number || null;
      } catch (_) {
        // Fall back to defaults
      }
      insertMessage(db, {
        chatId: chat.id._serialized,
        contactName: `[${chat.name}] ${contactName}`,
        phone,
        body: msg.body,
        timestamp: msg.timestamp * 1000,
        direction: msg.fromMe ? 'outgoing' : 'incoming',
        source: 'whatsapp_group',
      });
      saved++;
    }
  }

  console.log(`  Saved ${saved} group messages from last 3 days.`);
  return saved;
}
// ---------------------------------------------------------------------------

async function runBackfill() {
  console.log(`[${new Date().toISOString()}] Starting WhatsApp backfill...`);
  const db = initDb();
  const dmSince = Date.now() - DM_LOOKBACK_MS;
  const groupSince = Date.now() - GROUP_LOOKBACK_MS;

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      headless: true,
    },
  });

  client.initialize();

  try {
    await waitForReady(client);
    console.log('  WhatsApp client ready.');

    await fetchDmMessages(client, db, dmSince);

    await fetchGroupMessages(client, db, groupSince);

  } finally {
    await client.destroy();
    db.close();
    console.log(`[${new Date().toISOString()}] WhatsApp backfill complete.`);
  }
}

runBackfill().catch(err => {
  console.error('WhatsApp backfill failed:', err.message);
  process.exit(1);
});
