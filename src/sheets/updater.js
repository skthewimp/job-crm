// src/sheets/updater.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');

const SHEET_COLUMNS = [
  'Contact Name', 'Company', 'Role/Title', 'Relationship Type',
  'Source', 'Channel', 'First Contact Date', 'Last Interaction Date',
  'Last Interaction Summary', 'Next Follow-up Date', 'Follow-up Action',
  'Status', 'Notes', 'Role Discussed'
];

async function initSheet(sheetId) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Sheet1!A1:N1'
  });

  if (!res.data.values || res.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Sheet1!A1:N1',
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
    range: 'Sheet1!A:N'
  });

  const rows = res.data.values || [];
  if (rows.length <= 1) return [];

  return rows.slice(1).map((row, idx) => ({
    rowIndex: idx + 2,
    name: row[0] || '',
    company: row[1] || '',
    role: row[2] || '',
    relationshipType: row[3] || '',
    source: row[4] || '',
    channel: row[5] || '',
    firstContactDate: row[6] || '',
    lastInteractionDate: row[7] || '',
    lastInteractionSummary: row[8] || '',
    nextFollowUpDate: row[9] || '',
    followUpAction: row[10] || '',
    status: row[11] || '',
    notes: row[12] || '',
    roleDiscussed: row[13] || ''
  }));
}

async function upsertRow(sheetId, contact) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const existing = await getAllRows(sheetId);

  const match = existing.find(r =>
    r.name.toLowerCase() === (contact.contactName || '').toLowerCase() &&
    r.company.toLowerCase() === (contact.company || '').toLowerCase()
  );

  const rowData = [
    contact.contactName || '',
    contact.company || '',
    contact.roleTitle || '',
    contact.relationshipType || '',
    contact.source || '',
    contact.channel || '',
    contact.firstContactDate || '',
    contact.lastInteractionDate || new Date().toISOString().split('T')[0],
    contact.interactionSummary || '',
    contact.followUpDate || '',
    contact.followUpAction || '',
    contact.status || 'Active',
    contact.notes || '',
    contact.roleDiscussed || ''
  ];

  if (match) {
    const updatedRow = [
      rowData[0] || match.name,
      rowData[1] || match.company,
      rowData[2] || match.role,
      rowData[3] || match.relationshipType,
      rowData[4] || match.source,
      rowData[5] || match.channel,
      match.firstContactDate || rowData[6],
      rowData[7] || match.lastInteractionDate,
      rowData[8] || match.lastInteractionSummary,
      rowData[9] || match.nextFollowUpDate,
      rowData[10] || match.followUpAction,
      rowData[11] || match.status,
      match.notes ? `${match.notes}\n${rowData[12]}`.trim() : rowData[12],
      rowData[13] || match.roleDiscussed
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `Sheet1!A${match.rowIndex}:N${match.rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [updatedRow] }
    });
    return { action: 'updated', row: match.rowIndex };
  } else {
    rowData[6] = rowData[6] || new Date().toISOString().split('T')[0];
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Sheet1!A:N',
      valueInputOption: 'RAW',
      requestBody: { values: [rowData] }
    });
    return { action: 'added', name: contact.contactName };
  }
}

module.exports = { initSheet, getAllRows, upsertRow, SHEET_COLUMNS };
