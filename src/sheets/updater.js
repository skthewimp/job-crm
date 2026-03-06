// src/sheets/updater.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');

const SHEET_TAB = process.env.SHEET_TAB || 'CRM';

const SHEET_COLUMNS = [
  'Company', 'Contacts', 'Role Discussed', 'Status',
  'Channel', 'First Contact Date', 'Last Interaction Date',
  'Last Interaction Summary', 'Next Follow-up Date', 'Follow-up Action',
  'Notes'
];

async function initSheet(sheetId) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabExists = meta.data.sheets.some(s => s.properties.title === SHEET_TAB);

  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        requests: [{ addSheet: { properties: { title: SHEET_TAB } } }]
      }
    });
  }

  let res;
  try {
    res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A1:K1`
    });
  } catch {
    res = { data: {} };
  }

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A1:K1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_COLUMNS] }
    });
  }
}

async function getAllRows(sheetId) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${SHEET_TAB}!A:K`
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((row, idx) => ({
    rowIndex: idx + 2,
    company: row[0] || '',
    contacts: row[1] || '',
    roleDiscussed: row[2] || '',
    status: row[3] || '',
    channel: row[4] || '',
    firstContactDate: row[5] || '',
    lastInteractionDate: row[6] || '',
    lastInteractionSummary: row[7] || '',
    nextFollowUpDate: row[8] || '',
    followUpAction: row[9] || '',
    notes: row[10] || ''
  }));
}

async function upsertRow(sheetId, contact) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const existing = await getAllRows(sheetId);

  const company = (contact.company || '').trim();
  if (!company) return { action: 'skipped', reason: 'no company' };

  const match = existing.find(r =>
    r.company.toLowerCase() === company.toLowerCase()
  );

  if (match) {
    // Merge contact name into existing contacts list
    const existingContacts = match.contacts.split(',').map(s => s.trim()).filter(Boolean);
    const newName = (contact.contactName || '').trim();
    if (newName && !existingContacts.some(n => n.toLowerCase() === newName.toLowerCase())) {
      existingContacts.push(newName);
    }

    // Only update interaction details if this message is newer
    const isNewer = (contact.lastInteractionDate || '') >= (match.lastInteractionDate || '');

    // For follow-up: keep the latest (most future) date
    let followUpDate = match.nextFollowUpDate;
    let followUpAction = match.followUpAction;
    if (contact.followUpDate && (!match.nextFollowUpDate || contact.followUpDate > match.nextFollowUpDate)) {
      followUpDate = contact.followUpDate;
      followUpAction = contact.followUpAction || match.followUpAction;
    }

    const updatedRow = [
      match.company,
      existingContacts.join(', '),
      (isNewer && contact.roleDiscussed) ? contact.roleDiscussed : match.roleDiscussed,
      (isNewer && contact.status) ? contact.status : match.status,
      contact.channel || match.channel,
      match.firstContactDate || contact.firstContactDate || '',
      isNewer ? (contact.lastInteractionDate || match.lastInteractionDate) : match.lastInteractionDate,
      isNewer ? (contact.interactionSummary || match.lastInteractionSummary) : match.lastInteractionSummary,
      followUpDate,
      followUpAction,
      match.notes ? `${match.notes}\n${contact.notes || ''}`.trim() : (contact.notes || '')
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A${match.rowIndex}:K${match.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updatedRow] }
    });
    return { action: 'updated', row: match.rowIndex };
  } else {
    const rowData = [
      company,
      contact.contactName || '',
      contact.roleDiscussed || '',
      contact.status || 'Active',
      contact.channel || '',
      contact.firstContactDate || new Date().toISOString().split('T')[0],
      contact.lastInteractionDate || new Date().toISOString().split('T')[0],
      contact.interactionSummary || '',
      contact.followUpDate || '',
      contact.followUpAction || '',
      contact.notes || ''
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${SHEET_TAB}!A:K`,
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] }
    });
    return { action: 'added', company };
  }
}

module.exports = { initSheet, getAllRows, upsertRow, SHEET_COLUMNS };
