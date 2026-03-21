#!/usr/bin/env node
// One-off script: Replace Google Sheet CRM tab with clean data from SQLite
require('dotenv').config();
const { google } = require('googleapis');
const { getOAuth2Client } = require('../src/google-auth');
const { initDb } = require('../src/db');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || 'CRM';

const COLUMNS = [
  'Company', 'Contacts', 'Role Discussed', 'Status',
  'Channel', 'First Contact Date', 'Last Interaction Date',
  'Last Interaction Summary', 'Next Follow-up Date', 'Follow-up Action',
  'Notes'
];

async function sync() {
  const db = initDb();
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read all companies from clean SQLite
  const companies = db.prepare(`
    SELECT company, contacts, role_discussed, status, channel,
           first_contact_date, last_interaction_date, last_interaction_summary,
           next_follow_up_date, follow_up_action, notes
    FROM companies
    ORDER BY company COLLATE NOCASE
  `).all();

  console.log(`Read ${companies.length} companies from SQLite.`);

  // Build sheet rows
  const rows = [COLUMNS];
  for (const c of companies) {
    rows.push([
      c.company || '',
      c.contacts || '',
      c.role_discussed || '',
      c.status || '',
      c.channel || '',
      c.first_contact_date || '',
      c.last_interaction_date || '',
      c.last_interaction_summary || '',
      c.next_follow_up_date || '',
      c.follow_up_action || '',
      c.notes || ''
    ]);
  }

  // Clear existing data
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A:K`
  });
  console.log('Cleared existing sheet data.');

  // Write clean data
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });

  console.log(`Wrote ${rows.length - 1} rows to Google Sheet.`);
  db.close();
}

sync()
  .then(() => console.log('Sheet sync complete.'))
  .catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
