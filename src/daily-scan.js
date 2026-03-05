require('dotenv').config();
const { initDb, getMessagesSince, upsertCompany } = require('./db');
const { scanEmails } = require('./gmail/scanner');
const { scanCalendar } = require('./calendar/scanner');
const { classifyMessages } = require('./llm/classifier');
const { extractCommitments } = require('./llm/extractor');
const { initSheet, upsertRow } = require('./sheets/updater');
const { sendDailySummary } = require('./summary/emailer');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function dailyScan() {
  console.log(`[${new Date().toISOString()}] Starting daily scan...`);
  const db = initDb();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const today = new Date().toISOString().split('T')[0];

  await initSheet(sheetId);

  console.log('Scanning Gmail, Calendar, and WhatsApp...');
  const [emailMessages, calendarEvents, whatsappMessages] = await Promise.all([
    scanEmails(db).catch(err => {
      console.error('Gmail scan failed:', err.message);
      return [];
    }),
    scanCalendar().catch(err => {
      console.error('Calendar scan failed:', err.message);
      return [];
    }),
    Promise.resolve(getMessagesSince(db, 'whatsapp', Date.now() - SEVEN_DAYS_MS))
  ]);

  console.log(`Found: ${emailMessages.length} emails, ${calendarEvents.length} calendar events, ${whatsappMessages.length} WhatsApp messages`);

  console.log('Classifying messages...');
  const allMessages = [
    ...emailMessages.map(m => ({ ...m, source: 'Email' })),
    ...whatsappMessages.map(m => ({
      body: m.body,
      contactName: m.contact_name,
      source: 'WhatsApp'
    }))
  ];

  const jobRelated = await classifyMessages(allMessages);
  console.log(`${jobRelated.length} job-related messages found.`);

  console.log('Extracting commitments...');
  const commitments = [];
  for (const msg of jobRelated) {
    const extracted = await extractCommitments(msg.body, msg.contactName, today);
    if (extracted) {
      extracted.channel = msg.source;
      commitments.push(extracted);
    }
  }

  const calendarClassified = await classifyMessages(
    calendarEvents.map(e => ({
      body: `${e.summary} ${e.description}`.trim(),
      contactName: e.attendees?.[0]?.name || e.summary,
      source: 'Calendar'
    }))
  );

  console.log('Updating CRM...');
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const selfNames = ['karthik', 'karthik shashidhar'];
  let added = 0, updated = 0, skipped = 0;

  for (const commitment of commitments) {
    if (!commitment.contactName) continue;

    // Skip self
    const nameLower = commitment.contactName.toLowerCase();
    if (selfNames.some(s => nameLower.includes(s)) || nameLower.includes(selfEmail?.split('@')[0])) {
      skipped++;
      continue;
    }

    // Skip if no company
    if (!commitment.company) {
      skipped++;
      continue;
    }

    // Upsert into companies table
    upsertCompany(db, {
      company: commitment.company,
      contactName: commitment.contactName,
      roleDiscussed: commitment.roleDiscussed,
      status: commitment.status,
      channel: commitment.channel,
      lastInteractionDate: today,
      interactionSummary: commitment.interactionSummary,
      followUpDate: commitment.followUpDate,
      followUpAction: commitment.followUpAction,
    });

    // Upsert into Google Sheet (one row per company)
    try {
      const result = await upsertRow(sheetId, {
        ...commitment,
        lastInteractionDate: today
      });
      if (result.action === 'added') added++;
      else if (result.action === 'updated') updated++;
      else skipped++;
    } catch (err) {
      console.error(`  Sheet update failed for ${commitment.company}:`, err.message);
    }
  }

  console.log(`CRM updated: ${added} new, ${updated} updated, ${skipped} skipped.`);

  console.log('Sending daily summary...');
  const jobCalendarEvents = calendarClassified.length > 0
    ? calendarEvents.filter((_, i) =>
        calendarClassified.some(c => c.body?.includes(calendarEvents[i]?.summary))
      )
    : calendarEvents;

  await sendDailySummary(db, jobCalendarEvents);

  db.close();
  console.log(`[${new Date().toISOString()}] Daily scan complete.`);
}

dailyScan().catch(err => {
  console.error('Daily scan failed:', err);
  process.exit(1);
});
