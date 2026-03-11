require('dotenv').config();
const { initDb, insertMessage, getMessagesSince, getCallsSince, getUnclassifiedMessages, markMessagesClassified, upsertCompany, getCompaniesDueForFollowUp } = require('./db');
const { scanEmails } = require('./gmail/scanner');
const { scanCalendar, scanPastEvents } = require('./calendar/scanner');
const { scanLinkedIn } = require('./linkedin/scanner');
const { classifyMessages } = require('./llm/classifier');
const { extractCommitments } = require('./llm/extractor');
const { initSheet, upsertRow } = require('./sheets/updater');
const { sendDailySummary, getLastThreadId } = require('./summary/emailer');
const { checkForFeedback, parseFeedback, applyFeedback } = require('./feedback/processor');

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
  const [emailMessages, upcomingEvents, pastEvents, whatsappMessages, linkedinMessages] = await Promise.all([
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
    Promise.resolve(getMessagesSince(db, 'whatsapp', Date.now() - SEVEN_DAYS_MS)),
    scanLinkedIn().catch(err => {
      console.error('LinkedIn scan failed:', err.message);
      return [];
    })
  ]);

  console.log(`Found: ${emailMessages.length} emails, ${pastEvents.length} past events, ${upcomingEvents.length} upcoming events, ${whatsappMessages.length} WhatsApp messages, ${linkedinMessages.length} LinkedIn messages`);

  // Store LinkedIn messages in DB
  for (const msg of linkedinMessages) {
    insertMessage(db, {
      chatId: null,
      contactName: msg.contactName,
      phone: null,
      body: msg.body?.substring(0, 5000),
      timestamp: new Date(msg.messageDate).getTime(),
      direction: msg.direction,
      source: 'linkedin'
    });
  }

  // Step 2: Build calendar context for cross-referencing
  const { attendeeNames } = buildCalendarContext(pastEvents, upcomingEvents);
  console.log(`Calendar context: ${attendeeNames.length} attendees across ${pastEvents.length + upcomingEvents.length} events`);

  // Step 3: Classify only NEW (unclassified) messages
  // Group by conversation (source + contact) to reduce API calls
  const unclassified = getUnclassifiedMessages(db, Date.now() - SEVEN_DAYS_MS);
  console.log(`${unclassified.length} new messages to classify...`);

  const sourceNameMap = { gmail: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

  // Group messages by conversation (source + contact_name)
  const convMap = new Map(); // key -> { messages: [], body: string }
  for (const m of unclassified) {
    const key = `${m.source}:${m.contact_name}`;
    if (!convMap.has(key)) {
      convMap.set(key, { messages: [], source: m.source, contactName: m.contact_name });
    }
    convMap.get(key).messages.push(m);
  }

  // Build one classification entry per conversation
  const convEntries = [];
  for (const [key, conv] of convMap) {
    const combinedBody = conv.messages
      .map(m => `[${m.direction}] ${m.body}`)
      .join('\n')
      .substring(0, 2000);
    convEntries.push({
      body: combinedBody,
      contactName: conv.contactName,
      source: sourceNameMap[conv.source] || conv.source,
      _key: key,
    });
  }

  console.log(`  Grouped into ${convEntries.length} conversations (from ${unclassified.length} messages)...`);
  const jobRelatedConvs = await classifyMessages(convEntries);
  const jobRelatedKeys = new Set(jobRelatedConvs.map(c => c._key));
  console.log(`${jobRelatedKeys.size} job-related conversations found.`);

  // Expand back to individual messages and mark classified
  const jobRelated = [];
  for (const [key, conv] of convMap) {
    const isJob = jobRelatedKeys.has(key);
    const ids = conv.messages.map(m => m.id);
    markMessagesClassified(db, ids, isJob);
    if (isJob) {
      for (const m of conv.messages) {
        jobRelated.push({
          _dbId: m.id,
          body: m.body,
          contactName: m.contact_name,
          source: sourceNameMap[m.source] || m.source,
          direction: m.direction,
          messageDate: tsToDate(m.timestamp)
        });
      }
    }
  }
  console.log(`${jobRelated.length} job-related messages to extract from.`);

  // Step 4: Extract commitments (grouped by conversation for better context)
  console.log('Extracting commitments...');
  const commitments = [];

  // Group job-related messages by conversation (source + contact)
  const extractGroups = new Map();
  for (const msg of jobRelated) {
    const key = `${msg.source}:${msg.contactName}`;
    if (!extractGroups.has(key)) {
      extractGroups.set(key, { messages: [], source: msg.source, contactName: msg.contactName });
    }
    extractGroups.get(key).messages.push(msg);
  }

  for (const [, group] of extractGroups) {
    // Build conversation text with direction markers, sorted by date
    const sorted = group.messages.sort((a, b) => a.messageDate.localeCompare(b.messageDate));
    const conversationText = sorted
      .map(m => `[${m.direction}] ${m.body}`)
      .join('\n\n')
      .substring(0, 4000);
    const latestDate = sorted[sorted.length - 1].messageDate;

    const extracted = await extractCommitments(conversationText, group.contactName, latestDate, today);
    if (extracted) {
      extracted.channel = group.source;
      extracted.messageDate = latestDate;
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
      // Past events and today's events both count - if there's a meeting today, the follow-up is handled
      const eventIsRelevant = a.isPast || a.eventDate === today;
      if (!eventIsRelevant) continue;

      const aName = (a.name || '').toLowerCase();
      const aEmail = (a.email || '').toLowerCase();

      const matches = contactsList.some(contact =>
        contact && (aName.includes(contact.split(' ')[0]) || aEmail.includes(contact.split(' ')[0]))
      ) || aName.includes(companyLower) || aEmail.includes(companyLower)
        || companyLower.split(' ').some(w => w.length > 3 && (aName.includes(w) || aEmail.includes(w)));

      if (matches && company.next_follow_up_date) {
        const reason = a.isPast ? 'meeting happened' : 'meeting scheduled today';
        console.log(`  Clearing follow-up for ${company.company}: ${reason} with ${a.name} on ${a.eventDate}`);
        db.prepare('UPDATE companies SET next_follow_up_date = NULL, follow_up_action = NULL, last_interaction_date = ?, last_interaction_summary = ?, updated_at = ? WHERE id = ?')
          .run(a.eventDate, `Meeting: ${a.eventSummary} with ${a.name}`, Date.now(), company.id);
        cleared++;
        break;
      }
    }
  }

  // Also check WhatsApp calls from last 7 days
  const recentCalls = getCallsSince(db, Date.now() - SEVEN_DAYS_MS);
  console.log(`  WhatsApp calls in last 7 days: ${recentCalls.length}`);

  const remainingCompanies = db.prepare('SELECT * FROM companies WHERE next_follow_up_date IS NOT NULL').all();
  for (const company of remainingCompanies) {
    const contactsList = (company.contacts || '').toLowerCase().split(',').map(s => s.trim());

    for (const call of recentCalls) {
      const callName = (call.contact_name || '').toLowerCase();
      const matches = contactsList.some(contact =>
        contact && callName.includes(contact.split(' ')[0])
      );

      if (matches) {
        const callDate = new Date(call.timestamp).toISOString().split('T')[0];
        console.log(`  Clearing follow-up for ${company.company}: WhatsApp call with ${call.contact_name} on ${callDate}`);
        db.prepare('UPDATE companies SET next_follow_up_date = NULL, follow_up_action = NULL, last_interaction_date = ?, last_interaction_summary = ?, updated_at = ? WHERE id = ?')
          .run(callDate, `WhatsApp call with ${call.contact_name}`, Date.now(), company.id);
        cleared++;
        break;
      }
    }
  }

  if (cleared > 0) console.log(`Cleared ${cleared} total follow-ups satisfied by meetings/calls.`);

  // Step 7: Process feedback from replies to yesterday's summary
  console.log('Checking for feedback...');
  let feedbackApplied = [];
  try {
    const lastThread = getLastThreadId();
    const replyText = await checkForFeedback(lastThread?.threadId);
    if (replyText) {
      const allCompanies = db.prepare('SELECT * FROM companies').all();
      const actions = await parseFeedback(replyText, allCompanies);
      console.log(`  Feedback: ${actions.length} action(s) parsed.`);
      feedbackApplied = applyFeedback(db, actions);
    }
  } catch (err) {
    console.error('Feedback processing failed:', err.message);
  }

  // Step 8: Send daily summary using clean data
  console.log('Sending daily summary...');
  await sendDailySummary(db, upcomingEvents, feedbackApplied);

  db.close();
  console.log(`[${new Date().toISOString()}] Daily scan complete.`);
}

dailyScan().catch(err => {
  console.error('Daily scan failed:', err);
  process.exit(1);
});
