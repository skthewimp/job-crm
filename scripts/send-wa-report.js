#!/usr/bin/env node
// Just sends the follow-up report from existing DB data (no re-classification needed)
require('dotenv').config();
const { initDb, getContacts, getContactsDueForFollowUp } = require('../src/db');
const { authorize } = require('../src/google-auth');
const { google } = require('googleapis');

async function main() {
  const db = initDb();
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth });
  const today = new Date().toISOString().split('T')[0];

  const allContacts = getContacts(db);
  const waContacts = allContacts.filter(c => c.channel === 'WhatsApp');
  const followUps = getContactsDueForFollowUp(db, '2026-12-31');
  const overdue = followUps.filter(c => c.next_follow_up_date < today);
  const dueToday = followUps.filter(c => c.next_follow_up_date === today);
  const upcoming = followUps.filter(c => c.next_follow_up_date > today);

  console.log(`Total contacts: ${allContacts.length}`);
  console.log(`WhatsApp contacts: ${waContacts.length}`);
  console.log(`Follow-ups: ${overdue.length} overdue, ${dueToday.length} today, ${upcoming.length} upcoming`);

  const formatRow = (c) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee"><strong>${c.name}</strong></td>
      <td style="padding:8px;border-bottom:1px solid #eee">${c.company || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${c.next_follow_up_date || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${c.follow_up_action || '-'}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${c.last_interaction_summary || '-'}</td>
    </tr>`;

  const section = (title, color, items) => {
    if (items.length === 0) return '';
    return `
      <h2 style="color:${color};margin-top:24px">${title} (${items.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <tr style="background:#f5f5f5">
          <th style="padding:8px;text-align:left">Name</th>
          <th style="padding:8px;text-align:left">Company</th>
          <th style="padding:8px;text-align:left">Follow-up Date</th>
          <th style="padding:8px;text-align:left">Action</th>
          <th style="padding:8px;text-align:left">Last Interaction</th>
        </tr>
        ${items.map(formatRow).join('')}
      </table>`;
  };

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:800px;margin:0 auto;padding:20px">
      <h1 style="color:#333">WhatsApp CRM Backfill Report</h1>
      <p style="color:#666">3-week WhatsApp scan completed on ${today}. Found ${waContacts.length} job-related WhatsApp contacts.</p>

      ${section('Overdue Follow-ups', '#d32f2f', overdue)}
      ${section('Due Today', '#f57c00', dueToday)}
      ${section('Upcoming Follow-ups', '#1976d2', upcoming)}

      ${waContacts.length > 0 ? `
        <h2 style="color:#333;margin-top:24px">All WhatsApp Job Contacts (${waContacts.length})</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="background:#f5f5f5">
            <th style="padding:8px;text-align:left">Name</th>
            <th style="padding:8px;text-align:left">Company</th>
            <th style="padding:8px;text-align:left">Role Discussed</th>
            <th style="padding:8px;text-align:left">Status</th>
            <th style="padding:8px;text-align:left">Follow-up</th>
            <th style="padding:8px;text-align:left">Last Interaction</th>
          </tr>
          ${waContacts.map(c => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>${c.name}</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.company || '-'}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.role_discussed || '-'}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.status || '-'}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.next_follow_up_date || '-'}</td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.last_interaction_summary || '-'}</td>
            </tr>`).join('')}
        </table>` : ''}
    </div>`;

  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const raw = Buffer.from(
    `From: ${selfEmail}\r\n` +
    `To: ${selfEmail}\r\n` +
    `Subject: WhatsApp CRM Backfill Report - ${today}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    html
  ).toString('base64url');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  console.log('Report email sent!');
  db.close();
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1); });
