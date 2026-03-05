#!/usr/bin/env node
// One-time: migrate from per-contact to per-company in both SQLite and Google Sheet
require('dotenv').config();
const { initDb, upsertCompany } = require('../src/db');
const { google } = require('googleapis');
const { getOAuth2Client } = require('../src/google-auth');

const SHEET_TAB = process.env.SHEET_TAB || 'CRM';
const SHEET_COLUMNS = [
  'Company', 'Contacts', 'Role Discussed', 'Status',
  'Channel', 'First Contact Date', 'Last Interaction Date',
  'Last Interaction Summary', 'Next Follow-up Date', 'Follow-up Action',
  'Notes'
];

async function main() {
  const db = initDb();

  // 1. Build companies from existing contacts table
  console.log('Migrating contacts to companies table...');
  const contacts = db.prepare(`
    SELECT * FROM contacts WHERE company IS NOT NULL AND company != '' ORDER BY last_interaction_date ASC
  `).all();

  for (const c of contacts) {
    upsertCompany(db, {
      company: c.company,
      contactName: c.name,
      roleDiscussed: c.role_discussed,
      status: c.status,
      channel: c.channel,
      firstContactDate: c.first_contact_date,
      lastInteractionDate: c.last_interaction_date,
      interactionSummary: c.last_interaction_summary,
      followUpDate: c.next_follow_up_date,
      followUpAction: c.follow_up_action,
    });
  }

  const companies = db.prepare('SELECT * FROM companies ORDER BY last_interaction_date DESC').all();
  console.log(`Created ${companies.length} company records from ${contacts.length} contacts.`);

  // 2. Clear and rebuild the Google Sheet
  console.log('Rebuilding Google Sheet...');
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetId = process.env.GOOGLE_SHEET_ID;

  // Get sheet metadata to find the CRM tab's sheetId
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const crmTab = meta.data.sheets.find(s => s.properties.title === SHEET_TAB);

  if (crmTab) {
    // Clear all content
    await sheets.spreadsheets.values.clear({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A:Z`
    });
  } else {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB } } }]
      }
    });
  }

  // Write header + all company rows
  const rows = [SHEET_COLUMNS];
  for (const c of companies) {
    rows.push([
      c.company,
      c.contacts || '',
      c.role_discussed || '',
      c.status || 'Active',
      c.channel || '',
      c.first_contact_date || '',
      c.last_interaction_date || '',
      c.last_interaction_summary || '',
      c.next_follow_up_date || '',
      c.follow_up_action || '',
      c.notes || ''
    ]);
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A1:K${rows.length}`,
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });

  console.log(`Sheet updated: ${rows.length - 1} company rows written.`);
  db.close();
}

main().catch(err => { console.error('Failed:', err); process.exit(1); });
