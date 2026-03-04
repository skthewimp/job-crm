#!/usr/bin/env node
// One-time script: process 3 weeks of backfilled WhatsApp messages
// Classifies, extracts, updates CRM, and sends a follow-up report email.

require('dotenv').config();
const { initDb, getMessagesSince, upsertContact, getContactsDueForFollowUp, getContacts } = require('../src/db');
const { classifyMessages } = require('../src/llm/classifier');
const { extractCommitments } = require('../src/llm/extractor');
const { initSheet, upsertRow } = require('../src/sheets/updater');
const { authorize } = require('../src/google-auth');
const { google } = require('googleapis');

const THREE_WEEKS_MS = 21 * 24 * 60 * 60 * 1000;

async function sendFollowUpReport(contacts, overdueContacts, allExtracted) {
  const auth = await authorize();
  const gmail = google.gmail({ version: 'v1', auth });

  const overdue = overdueContacts.filter(c => c.next_follow_up_date < new Date().toISOString().split('T')[0]);
  const dueToday = overdueContacts.filter(c => c.next_follow_up_date === new Date().toISOString().split('T')[0]);
  const upcoming = overdueContacts.filter(c => c.next_follow_up_date > new Date().toISOString().split('T')[0]);

  const formatContact = (c) => `
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
        ${items.map(formatContact).join('')}
      </table>`;
  };

  // Also show all WhatsApp-sourced contacts found
  const waContacts = contacts.filter(c => c.channel === 'WhatsApp');

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:800px;margin:0 auto;padding:20px">
      <h1 style="color:#333">WhatsApp CRM Backfill Report</h1>
      <p style="color:#666">3-week WhatsApp scan completed on ${new Date().toISOString().split('T')[0]}</p>
      <p style="color:#666">${allExtracted.length} job-related conversations found across WhatsApp messages.</p>

      ${section('Overdue Follow-ups', '#d32f2f', overdue)}
      ${section('Due Today', '#f57c00', dueToday)}
      ${section('Upcoming Follow-ups', '#1976d2', upcoming)}

      ${waContacts.length > 0 ? `
        <h2 style="color:#333;margin-top:24px">All WhatsApp Job Contacts Found (${waContacts.length})</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="background:#f5f5f5">
            <th style="padding:8px;text-align:left">Name</th>
            <th style="padding:8px;text-align:left">Company</th>
            <th style="padding:8px;text-align:left">Status</th>
            <th style="padding:8px;text-align:left">Follow-up</th>
            <th style="padding:8px;text-align:left">Last Interaction</th>
          </tr>
          ${waContacts.map(c => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #eee"><strong>${c.name}</strong></td>
              <td style="padding:8px;border-bottom:1px solid #eee">${c.company || '-'}</td>
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
    `Subject: WhatsApp CRM Backfill Report - ${new Date().toISOString().split('T')[0]}\r\n` +
    `Content-Type: text/html; charset=utf-8\r\n\r\n` +
    html
  ).toString('base64url');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw }
  });

  console.log('Follow-up report email sent!');
}

async function main() {
  console.log(`[${new Date().toISOString()}] Starting WhatsApp backfill processing...`);
  const db = initDb();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const today = new Date().toISOString().split('T')[0];

  await initSheet(sheetId);

  // Get all WhatsApp messages from last 3 weeks
  const whatsappMessages = getMessagesSince(db, 'whatsapp', Date.now() - THREE_WEEKS_MS);
  console.log(`Found ${whatsappMessages.length} WhatsApp messages from last 3 weeks.`);

  // Classify
  console.log('Classifying messages...');
  const formatted = whatsappMessages.map(m => ({
    body: m.body,
    contactName: m.contact_name,
    source: 'WhatsApp'
  }));

  const jobRelated = await classifyMessages(formatted);
  console.log(`${jobRelated.length} job-related messages found.`);

  // Extract
  console.log('Extracting commitments...');
  const commitments = [];
  for (const msg of jobRelated) {
    const extracted = await extractCommitments(msg.body, msg.contactName, today);
    if (extracted) {
      extracted.channel = 'WhatsApp';
      commitments.push(extracted);
    }
    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`${commitments.length} commitments extracted.`);

  // Update CRM
  console.log('Updating CRM...');
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const selfNames = ['karthik', 'karthik shashidhar'];
  let added = 0, updated = 0, skipped = 0;

  for (const commitment of commitments) {
    if (!commitment.contactName) { skipped++; continue; }

    const nameLower = commitment.contactName.toLowerCase();
    if (selfNames.some(s => nameLower.includes(s)) || nameLower.includes(selfEmail?.split('@')[0])) {
      skipped++;
      continue;
    }

    upsertContact(db, {
      name: commitment.contactName,
      company: commitment.company,
      role: commitment.roleTitle,
      relationshipType: commitment.relationshipType,
      channel: commitment.channel,
      lastInteractionDate: today,
      lastInteractionSummary: commitment.interactionSummary,
      nextFollowUpDate: commitment.followUpDate,
      followUpAction: commitment.followUpAction,
      status: commitment.status,
      roleDiscussed: commitment.roleDiscussed
    });

    try {
      const result = await upsertRow(sheetId, {
        ...commitment,
        lastInteractionDate: today
      });
      if (result.action === 'added') added++;
      else updated++;
    } catch (err) {
      console.error(`  Sheet update failed for ${commitment.contactName}:`, err.message);
    }
  }

  console.log(`CRM updated: ${added} new, ${updated} updated, ${skipped} self-skipped.`);

  // Send report email
  console.log('Sending follow-up report...');
  const allContacts = getContacts(db);
  const followUpContacts = getContactsDueForFollowUp(db, '2026-12-31'); // Get all with any follow-up date
  await sendFollowUpReport(allContacts, followUpContacts, commitments);

  db.close();
  console.log(`[${new Date().toISOString()}] Done!`);
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
