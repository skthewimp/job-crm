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
    if (chat.isGroup) return;
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
