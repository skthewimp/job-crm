require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initDb, insertMessage, insertCall } = require('../db');

const TIMEOUT_MS = 120000; // 2 min max runtime after ready
const FETCH_LIMIT = 50;   // messages per chat

async function collect() {
  const db = initDb();

  // Find the most recent whatsapp message timestamp we already have
  const lastRow = db.prepare(
    "SELECT MAX(timestamp) as ts FROM messages WHERE source = 'whatsapp'"
  ).get();
  const since = lastRow?.ts || (Date.now() - 7 * 24 * 60 * 60 * 1000);
  console.log(`Fetching messages since ${new Date(since).toISOString()}`);

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

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('WhatsApp client failed to become ready within 60s'));
    }, 60000);

    client.on('ready', () => {
      clearTimeout(timeout);
      resolve();
    });

    client.on('auth_failure', (msg) => {
      clearTimeout(timeout);
      reject(new Error(`Auth failed: ${msg}`));
    });

    client.initialize();
  });

  console.log('WhatsApp client ready. Fetching chats...');

  const chats = await client.getChats();
  const directChats = chats.filter(c => !c.isGroup);
  console.log(`Found ${directChats.length} direct chats.`);

  let newMessages = 0;
  let newCalls = 0;

  for (const chat of directChats) {
    try {
      const messages = await chat.fetchMessages({ limit: FETCH_LIMIT });

      for (const msg of messages) {
        const ts = msg.timestamp * 1000;
        if (ts <= since) continue;

        const contact = await msg.getContact();
        const isFromMe = msg.fromMe;

        if (msg.type === 'call_log') {
          try {
            insertCall(db, {
              chatId: chat.id._serialized,
              contactName: chat.name || contact.pushname || contact.name || 'Unknown',
              phone: contact.number || null,
              timestamp: ts,
              direction: isFromMe ? 'outgoing' : 'incoming',
            });
            newCalls++;
          } catch (e) { /* duplicate or error, skip */ }
          continue;
        }

        if (!msg.body) continue;

        try {
          insertMessage(db, {
            chatId: chat.id._serialized,
            contactName: isFromMe ? chat.name : contact.pushname || contact.name || 'Unknown',
            phone: contact.number || null,
            body: msg.body,
            timestamp: ts,
            direction: isFromMe ? 'outgoing' : 'incoming',
            source: 'whatsapp'
          });
          newMessages++;
        } catch (e) { /* duplicate via unique index, skip */ }
      }
    } catch (err) {
      console.error(`Error fetching chat ${chat.name}:`, err.message);
    }
  }

  console.log(`Done. Stored ${newMessages} new messages, ${newCalls} new calls.`);

  await client.destroy();
  db.close();
}

collect()
  .then(() => {
    console.log(`[${new Date().toISOString()}] WhatsApp collection complete.`);
    process.exit(0);
  })
  .catch(err => {
    console.error('WhatsApp collection failed:', err.message);
    process.exit(1);
  });
