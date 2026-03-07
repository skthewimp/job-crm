require('dotenv').config();
const { initDb, getMessagesSince, upsertCompany, getCompaniesDueForFollowUp } = require('./db');
const { scanEmails } = require('./gmail/scanner');
const { scanCalendar, scanPastEvents } = require('./calendar/scanner');
const { classifyMessages } = require('./llm/classifier');
const { extractCommitments } = require('./llm/extractor');
const { initSheet, upsertRow } = require('./sheets/updater');
const { sendDailySummary } = require('./summary/emailer');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function tsToDate(ts) {
  return new Date(ts).toISOString().split('T')[0];
}

// Extract names/companies from calendar events for cross-referencing
function buildCalendarContext(pastEvents, upcomingEvents) {
  const meetingsDone = new Set(); // company names where a meeting already happened
  const attendeeNames = [];

  for (const event of [...pastEvents, ...upcomingEvents]) {
    const isPast = new Date(event.start) < new Date();
    for (const a of event.attendees) {
      const name = (a.name || '').toLowerCase();
      const email = (a.email || '').toLowerCase();
      if (email.includes('karthik')) continue;
      attendeeNames.push({
        name: a.name,
        email: a.email,
        eventSummary: event.summary,
        eventDate: new Date(event.start).toISOString().split('T')[0],
        isPast
      });
    }
  }

  return { attendeeNames };
}

// Check if a company's follow-up has been satisfied by a calendar event
function isFollowUpSatisfied(company, followUpDate, calendarAttendees) {
  if (!company || !followUpDate) return false;

  const companyLower = company.toLowerCase();
  const contacts = (company.contacts || '').toLowerCase();

  for (const a of calendarAttendees) {
    if (!a.isPast) continue; // only past events count as "done"

    const nameLower = (a.name || '').toLowerCase();
    const emailLower = (a.email || '').toLowerCase();

    // Check if attendee name/email matches the company or any contact name
    if (nameLower.includes(companyLower) || emailLower.includes(companyLower) ||
        companyLower.includes(nameLower.split(' ')[0])) {
      // Meeting happened with someone related to this company after the follow-up was due
      if (a.eventDate >= followUpDate) return true;
    }
  }

  return false;
}

async function dailyScan() {
  console.log(`[${new Date().toISOString()}] Starting daily scan...`);
  const db = initDb();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const today = new Date().toISOString().split('T')[0];

  await initSheet(sheetId);

  // Step 1: Scan ALL sources in parallel
  console.log('Scanning all sources...');
  const [emailMessages, upcomingEvents, pastEvents, whatsappMessages] = await Promise.all([
    scanEmails(db).catch(err => {
      console.error('Gmail scan failed:', err.message);
      return [];
    }),
    scanCalendar().catch(err => {
      console.error('Calendar scan failed:', err.message);
      return [];
    }),
    scanPastEvents().catch(err => {
      console.error('Past calendar scan failed:', err.message);
      return [];
    }),
    Promise.resolve(getMessagesSince(db, 'whatsapp', Date.now() - SEVEN_DAYS_MS))
  ]);

  console.log(`Found: ${emailMessages.length} emails, ${pastEvents.length} past events, ${upcomingEvents.length} upcoming events, ${whatsappMessages.length} WhatsApp messages`);

  // Step 2: Build calendar context for cross-referencing
  const { attendeeNames } = buildCalendarContext(pastEvents, upcomingEvents);
  console.log(`Calendar context: ${attendeeNames.length} attendees across ${pastEvents.length + upcomingEvents.length} events`);

  // Step 3: Classify messages
  console.log('Classifying messages...');
  const allMessages = [
    ...emailMessages.map(m => ({ ...m, source: 'Email', messageDate: tsToDate(m.timestamp) })),
    ...whatsappMessages.map(m => ({
      body: m.body,
      contactName: m.contact_name,
      source: 'WhatsApp',
      direction: m.direction,
      messageDate: tsToDate(m.timestamp)
    }))
  ];

  const jobRelated = await classifyMessages(allMessages);
  console.log(`${jobRelated.length} job-related messages found.`);

  // Step 4: Extract commitments
  console.log('Extracting commitments...');
  const commitments = [];
  for (const msg of jobRelated) {
    const extracted = await extractCommitments(msg.body, msg.contactName, msg.messageDate, today, msg.direction);
    if (extracted) {
      extracted.channel = msg.source;
      extracted.messageDate = msg.messageDate;
      commitments.push(extracted);
    }
  }

  // Step 5: Update CRM
  console.log('Updating CRM...');
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const selfNames = ['karthik', 'karthik shashidhar'];
  let added = 0, updated = 0, skipped = 0;

  for (const commitment of commitments) {
    if (!commitment.contactName) continue;

    const nameLower = commitment.contactName.toLowerCase();
    if (selfNames.some(s => nameLower.includes(s)) || nameLower.includes(selfEmail?.split('@')[0])) {
      skipped++;
      continue;
    }

    if (!commitment.company) {
      skipped++;
      continue;
    }

    const interactionDate = commitment.messageDate || today;

    upsertCompany(db, {
      company: commitment.company,
      contactName: commitment.contactName,
      roleDiscussed: commitment.roleDiscussed,
      status: commitment.status,
      channel: commitment.channel,
      lastInteractionDate: interactionDate,
      interactionSummary: commitment.interactionSummary,
      followUpDate: commitment.followUpDate,
      followUpAction: commitment.followUpAction,
    });

    try {
      const result = await upsertRow(sheetId, {
        ...commitment,
        lastInteractionDate: interactionDate
      });
      if (result.action === 'added') added++;
      else if (result.action === 'updated') updated++;
      else skipped++;
    } catch (err) {
      console.error(`  Sheet update failed for ${commitment.company}:`, err.message);
    }
  }

  console.log(`CRM updated: ${added} new, ${updated} updated, ${skipped} skipped.`);

  // Step 6: Cross-reference - clear follow-ups that calendar events have satisfied
  console.log('Cross-referencing follow-ups with calendar...');
  const allCompanies = db.prepare('SELECT * FROM companies WHERE next_follow_up_date IS NOT NULL').all();
  let cleared = 0;

  for (const company of allCompanies) {
    // Check if any calendar attendee matches this company's contacts
    const companyLower = company.company.toLowerCase();
    const contactsList = (company.contacts || '').toLowerCase().split(',').map(s => s.trim());

    for (const a of attendeeNames) {
      if (!a.isPast) continue;
      const aName = (a.name || '').toLowerCase();
      const aEmail = (a.email || '').toLowerCase();

      const matches = contactsList.some(contact =>
        contact && (aName.includes(contact.split(' ')[0]) || aEmail.includes(contact.split(' ')[0]))
      ) || aName.includes(companyLower) || aEmail.includes(companyLower)
        || companyLower.split(' ').some(w => w.length > 3 && (aName.includes(w) || aEmail.includes(w)));

      if (matches && company.next_follow_up_date && a.eventDate >= company.next_follow_up_date) {
        console.log(`  Clearing follow-up for ${company.company}: meeting with ${a.name} on ${a.eventDate} satisfies due date ${company.next_follow_up_date}`);
        db.prepare('UPDATE companies SET next_follow_up_date = NULL, follow_up_action = NULL, last_interaction_date = ?, last_interaction_summary = ?, updated_at = ? WHERE id = ?')
          .run(a.eventDate, `Meeting: ${a.eventSummary} with ${a.name}`, Date.now(), company.id);
        cleared++;
        break;
      }
    }
  }

  if (cleared > 0) console.log(`Cleared ${cleared} follow-ups satisfied by calendar events.`);

  // Step 7: Send daily summary using clean data
  console.log('Sending daily summary...');
  await sendDailySummary(db, upcomingEvents);

  db.close();
  console.log(`[${new Date().toISOString()}] Daily scan complete.`);
}

dailyScan().catch(err => {
  console.error('Daily scan failed:', err);
  process.exit(1);
});
