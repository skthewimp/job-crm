require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { initDb, insertMessage, insertCall } = require('../db');

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
  console.log('WhatsApp client ready and listening for messages and calls.');
});

client.on('message_create', async (msg) => {
  try {
    const chat = await msg.getChat();
    if (chat.isGroup) return;
    const contact = await msg.getContact();
    const isFromMe = msg.fromMe;

    // Capture call_log messages (appear as chat entries when a call happens)
    if (msg.type === 'call_log') {
      insertCall(db, {
        chatId: chat.id._serialized,
        contactName: chat.name || contact.pushname || contact.name || 'Unknown',
        phone: contact.number || null,
        timestamp: msg.timestamp * 1000,
        direction: isFromMe ? 'outgoing' : 'incoming',
      });
      return;
    }

    if (!msg.body) return;

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

// Capture incoming calls in real-time
client.on('call', async (call) => {
  try {
    const contact = await client.getContactById(call.from);
    insertCall(db, {
      chatId: call.from,
      contactName: contact.pushname || contact.name || 'Unknown',
      phone: contact.number || null,
      timestamp: Date.now(),
      direction: call.fromMe ? 'outgoing' : 'incoming',
    });
  } catch (err) {
    console.error('Error storing call:', err.message);
  }
});

client.on('disconnected', (reason) => {
  console.log('Client disconnected:', reason);
  setTimeout(() => {
    console.log('Attempting reconnect...');
    client.initialize();
  }, 30000);
});

client.initialize();

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
