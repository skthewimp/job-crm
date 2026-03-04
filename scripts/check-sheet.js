const { google } = require('googleapis');
const { getOAuth2Client } = require('../src/google-auth');
const auth = getOAuth2Client();
const sheets = google.sheets({ version: 'v4', auth });
sheets.spreadsheets.values.get({
  spreadsheetId: '1vqPh6dG3QfDtFfgsW7dNAEmRK6WXcTz3uU8jfwy8KQM',
  range: 'CRM!A:B'
}).then(res => {
  const rows = (res.data.values || []).slice(1);
  console.log('Total rows:', rows.length);
  const companies = {};
  rows.forEach(r => {
    const co = (r[1] || '').toLowerCase();
    companies[co] = companies[co] || [];
    companies[co].push(r[0]);
  });
  Object.entries(companies).filter(([k,v]) => v.length > 1).forEach(([k,v]) => {
    console.log('  Dup:', k || '(no company)', '->', v.join(', '));
  });
}).catch(err => console.error(err.message));
