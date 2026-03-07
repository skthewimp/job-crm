#!/usr/bin/env node
// One-time script: backfill WhatsApp messages from the last 3 weeks
// Usage: First stop the WhatsApp daemon, then run this, then restart the daemon.

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const { initDb, insertMessage, insertCall } = require('../src/db');

const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000;
const cutoffTime = Date.now() - THREE_WEEKS_MS;

const db = initDb();
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  }
});

client.on('ready', async () => {
  console.log('Connected. Fetching chats...');
  try {
    const chats = await client.getChats();
    console.log(`Found ${chats.length} chats. Fetching messages from last 3 weeks...`);

    let totalMessages = 0;
    let newMessages = 0;

    for (const chat of chats) {
      // Skip status broadcasts and group chats
      if (chat.id._serialized === 'status@broadcast') continue;
      if (chat.isGroup) continue;

      try {
        // fetchMessages returns most recent N messages
        const messages = await chat.fetchMessages({ limit: 500 });

        for (const msg of messages) {
          const ts = msg.timestamp * 1000;
          if (ts < cutoffTime) continue;

          // Capture call_log messages - use chat name directly (getContact fails for calls)
          if (msg.type === 'call_log') {
            try {
              insertCall(db, {
                chatId: chat.id._serialized,
                contactName: chat.name || 'Unknown',
                phone: null,
                timestamp: ts,
                direction: msg.fromMe ? 'outgoing' : 'incoming',
              });
              newMessages++;
            } catch (e) { /* duplicate */ }
            totalMessages++;
            continue;
          }

          if (!msg.body || msg.body.trim() === '') continue;

          totalMessages++;

          try {
            const contact = await msg.getContact();
            const isFromMe = msg.fromMe;
            const contactName = isFromMe ? chat.name : contact.pushname || contact.name || 'Unknown';

            insertMessage(db, {
              chatId: chat.id._serialized,
              contactName,
              phone: contact.number || null,
              body: msg.body,
              timestamp: ts,
              direction: isFromMe ? 'outgoing' : 'incoming',
              source: 'whatsapp'
            });
            newMessages++;
          } catch (e) {
            // getContact() failure or duplicate, skip this message
          }
        }

        if (totalMessages > 0 && totalMessages % 100 === 0) {
          console.log(`  Progress: ${totalMessages} messages scanned, ${newMessages} new...`);
        }
      } catch (err) {
        console.error(`  Error fetching messages from ${chat.name}:`, err.message);
      }
    }

    console.log(`\nDone! Scanned ${totalMessages} messages, inserted ${newMessages} new ones.`);
  } catch (err) {
    console.error('Error during backfill:', err);
  }

  await client.destroy();
  db.close();
  process.exit(0);
});

client.on('qr', () => {
  console.error('ERROR: No saved auth session found. Run the collector first to authenticate.');
  process.exit(1);
});

console.log('Initializing WhatsApp client for backfill...');
client.initialize();
