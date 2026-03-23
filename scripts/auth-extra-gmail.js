#!/usr/bin/env node
// Authorize an extra Gmail account for read-only scanning.
// Usage: npm run auth:gmail-extra -- your-email@gmail.com

require('dotenv').config();
const { authorizeExtra } = require('../src/google-auth');

const email = process.argv[2];
if (!email || !email.includes('@')) {
  console.error('Usage: npm run auth:gmail-extra -- your-email@gmail.com');
  process.exit(1);
}

authorizeExtra(email).then(() => {
  console.log(`\nDone! Add this to your .env if not already there:`);
  console.log(`GMAIL_EXTRA_ACCOUNTS=${email}`);
  console.log(`\n(For multiple accounts, comma-separate them: email1@gmail.com,email2@gmail.com)`);
}).catch(err => {
  console.error('Authorization failed:', err.message);
  process.exit(1);
});
