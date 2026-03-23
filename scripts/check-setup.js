#!/usr/bin/env node
// Validates that all required configuration is in place before running the CRM.
// Usage: npm run setup:check

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = 0;
let warnings = 0;

function check(label, ok, message) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label} — ${message}`);
    errors++;
  }
}

function warn(label, ok, message) {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ⚠ ${label} — ${message}`);
    warnings++;
  }
}

console.log('\n--- Environment Variables ---');
check('ANTHROPIC_API_KEY', !!process.env.ANTHROPIC_API_KEY, 'Required. Get one at https://console.anthropic.com');
check('GOOGLE_SHEET_ID', !!process.env.GOOGLE_SHEET_ID, 'Required. Create a Google Sheet and copy its ID from the URL');
check('GMAIL_SELF_EMAIL', !!process.env.GMAIL_SELF_EMAIL || !!process.env.CRM_OWNER_EMAIL, 'Required. Set GMAIL_SELF_EMAIL or CRM_OWNER_EMAIL in .env');
warn('CRM_OWNER_NAME', !!process.env.CRM_OWNER_NAME, 'Recommended. Used to identify yourself in message classification');
warn('CRM_TIMEZONE', !!process.env.CRM_TIMEZONE, `Optional. Defaults to ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

console.log('\n--- Google Auth ---');
const credsPath = path.join(ROOT, 'auth', 'google-credentials.json');
const tokenPath = path.join(ROOT, 'auth', 'google-token.json');
check('Google credentials file', fs.existsSync(credsPath),
  'Missing auth/google-credentials.json. Download OAuth2 credentials from Google Cloud Console');
check('Google auth token', fs.existsSync(tokenPath),
  'Missing auth/google-token.json. Run: npm run auth:google');

console.log('\n--- Optional Features ---');
const extraAccounts = (process.env.GMAIL_EXTRA_ACCOUNTS || '').split(',').filter(Boolean);
if (extraAccounts.length > 0) {
  for (const email of extraAccounts) {
    const sanitized = email.trim().replace(/[^a-zA-Z0-9]/g, '_');
    const extraTokenPath = path.join(ROOT, 'auth', `google-token-${sanitized}.json`);
    warn(`Extra Gmail: ${email.trim()}`, fs.existsSync(extraTokenPath),
      `No token. Run: npm run auth:gmail-extra -- ${email.trim()}`);
  }
} else {
  console.log('  - Multi-Gmail: not configured (set GMAIL_EXTRA_ACCOUNTS in .env)');
}

const scanGroups = (process.env.WHATSAPP_SCAN_GROUPS || '').trim();
if (scanGroups) {
  console.log(`  ✓ WhatsApp group scanning: ${scanGroups}`);
} else {
  console.log('  - WhatsApp groups: not configured (set WHATSAPP_SCAN_GROUPS in .env)');
}

console.log('\n--- Data Directory ---');
const dataDir = path.join(ROOT, 'data');
warn('data/ directory', fs.existsSync(dataDir), 'Will be created automatically on first run');

console.log('\n--- Dependencies ---');
try {
  require('better-sqlite3');
  console.log('  ✓ better-sqlite3');
} catch {
  check('better-sqlite3', false, 'Run: npm install');
}
try {
  require('@anthropic-ai/sdk');
  console.log('  ✓ @anthropic-ai/sdk');
} catch {
  check('@anthropic-ai/sdk', false, 'Run: npm install');
}
try {
  require('googleapis');
  console.log('  ✓ googleapis');
} catch {
  check('googleapis', false, 'Run: npm install');
}

console.log(`\n${errors === 0 ? '✓ Setup looks good!' : `✗ ${errors} error(s) found.`}${warnings > 0 ? ` ${warnings} warning(s).` : ''}\n`);
process.exit(errors > 0 ? 1 : 0);
