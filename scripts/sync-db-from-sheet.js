#!/usr/bin/env node
// One-off script: Read Google Sheet CRM tab, delete companies from SQLite
// that are no longer in the sheet, and add them to the blocklist so they
// never come back.
require('dotenv').config();
const { initDb } = require('../src/db');
const { getAllRows } = require('../src/sheets/updater');

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

async function sync() {
  const db = initDb();

  // Read current sheet state (the user's source of truth)
  console.log('Reading Google Sheet...');
  const sheetRows = await getAllRows(SHEET_ID);
  const sheetCompanies = new Set(
    sheetRows.map(r => r.company.trim().toLowerCase()).filter(Boolean)
  );
  console.log(`Sheet has ${sheetCompanies.size} companies.`);

  // Read all companies from SQLite
  const dbCompanies = db.prepare('SELECT id, company FROM companies').all();
  console.log(`SQLite has ${dbCompanies.length} companies.`);

  // Find companies to remove (in DB but not in sheet)
  const toRemove = dbCompanies.filter(
    c => !sheetCompanies.has(c.company.trim().toLowerCase())
  );

  if (toRemove.length === 0) {
    console.log('No companies to remove — DB and sheet are in sync.');
    db.close();
    return;
  }

  console.log(`\nRemoving ${toRemove.length} companies from SQLite and adding to blocklist:`);
  for (const c of toRemove) {
    console.log(`  - ${c.company}`);
  }

  // Delete from companies table and add to blocklist
  const deleteStmt = db.prepare('DELETE FROM companies WHERE id = ?');
  const blockStmt = db.prepare(
    'INSERT OR IGNORE INTO blocked_companies (company) VALUES (?)'
  );

  const run = db.transaction(() => {
    for (const c of toRemove) {
      deleteStmt.run(c.id);
      blockStmt.run(c.company.trim().toLowerCase());
    }
  });
  run();

  console.log(`\nDone. Removed ${toRemove.length} companies and blocklisted them.`);
  console.log('These companies will be ignored by future daily scans.');
  db.close();
}

sync()
  .then(() => console.log('\nSync complete.'))
  .catch(err => {
    console.error('Sync failed:', err.message);
    process.exit(1);
  });
