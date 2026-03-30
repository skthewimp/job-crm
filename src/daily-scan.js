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
const { isOwnerEmail, isOwnerName } = require('./config');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function tsToDate(ts) {
  return new Date(ts).toISOString().split('T')[0];
}

// Extract names/companies from calendar events for cross-referencing
function buildCalendarContext(pastEvents, upcomingEvents) {
  const attendeeNames = [];

  for (const event of [...pastEvents, ...upcomingEvents]) {
    const isPast = new Date(event.start) < new Date();
    for (const a of event.attendees) {
      if (isOwnerName(a.name || '') || isOwnerEmail(a.email || '')) continue;
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

  // Build email domain map: contactName -> email domain (e.g. "kpmg.com")
  const contactEmails = new Map(); // contactName -> email address
  for (const msg of emailMessages) {
    if (msg.contactEmail) {
      const emailMatch = msg.contactEmail.match(/<?\s*([^<>\s]+@[^<>\s]+)\s*>?/);
      if (emailMatch) {
        contactEmails.set(msg.contactName, emailMatch[1].toLowerCase());
      }
    }
  }

  // Store LinkedIn messages in DB (with headline as metadata prefix)
  const linkedinHeadlines = new Map(); // contactName -> headline
  for (const msg of linkedinMessages) {
    if (msg.linkedinHeadline) {
      linkedinHeadlines.set(msg.contactName, msg.linkedinHeadline);
    }
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
  // If a contact already has job-related messages (across any source), auto-classify
  // their new messages as job-related — once a thread is job-related, it stays that way.
  const unclassified = getUnclassifiedMessages(db, Date.now() - SEVEN_DAYS_MS);
  console.log(`${unclassified.length} new messages to classify...`);

  const sourceNameMap = { gmail: 'Email', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

  // Build set of contact names (normalized) that already have job-related messages
  const knownJobContacts = new Set(
    db.prepare(`
      SELECT DISTINCT LOWER(TRIM(contact_name)) FROM messages
      WHERE classified = 1 AND contact_name IS NOT NULL
    `).all().map(r => Object.values(r)[0])
  );

  // Group messages by conversation (source + contact_name)
  const convMap = new Map(); // key -> { messages: [], body: string }
  for (const m of unclassified) {
    const key = `${m.source}:${m.contact_name}`;
    if (!convMap.has(key)) {
      convMap.set(key, { messages: [], source: m.source, contactName: m.contact_name });
    }
    convMap.get(key).messages.push(m);
  }

  // Send all conversations to the LLM for classification — even known contacts,
  // since people who are job-related in one context may also have non-job conversations.
  const convEntries = [];
  for (const [key, conv] of convMap) {
    const combinedBody = conv.messages
      .map(m => `[${m.direction}] ${m.body}`)
      .join('\n')
      .substring(0, 2000);
    convEntries.push({
      body: combinedBody,
      contactName: conv.contactName,
      direction: conv.messages[conv.messages.length - 1].direction,
      source: sourceNameMap[conv.source] || conv.source,
      _key: key,
      _isKnownContact: knownJobContacts.has(conv.contactName.toLowerCase().trim()),
    });
  }

  console.log(`  ${convEntries.length} conversations to classify (${convEntries.filter(c => c._isKnownContact).length} from known contacts)`);
  const jobRelatedConvs = convEntries.length > 0 ? await classifyMessages(convEntries) : [];
  const jobRelatedKeys = new Set(jobRelatedConvs.map(c => c._key));
  console.log(`${jobRelatedKeys.size} CRM-relevant conversations found.`);

  if (process.env.DEBUG_CLASSIFIER === '1') {
    const missKeys = [...convMap.keys()].filter(k => !jobRelatedKeys.has(k));
    for (const key of missKeys.slice(0, 10)) {
      const conv = convMap.get(key);
      const preview = conv.messages[0]?.body?.slice(0, 120) || '';
      console.log(`  Classifier miss: [${conv.source}] ${conv.contactName} :: ${preview}`);
    }
  }

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
  console.log(`${jobRelated.length} CRM-relevant messages to extract from.`);

  // Step 4: Extract commitments — grouped by PERSON across all sources
  // This ensures cross-channel context (e.g., LinkedIn ask + email response are seen together)
  console.log('Extracting commitments...');
  const commitments = [];

  // Group job-related messages by normalized contact name (across all sources)
  const extractGroups = new Map();
  for (const msg of jobRelated) {
    const normName = msg.contactName.toLowerCase().trim();
    if (!extractGroups.has(normName)) {
      extractGroups.set(normName, {
        messages: [],
        displayName: msg.contactName,
        sources: new Set()
      });
    }
    const group = extractGroups.get(normName);
    group.messages.push(msg);
    group.sources.add(msg.source);
    // Keep the longest/most complete version of the name as display name
    if (msg.contactName.length > group.displayName.length) {
      group.displayName = msg.contactName;
    }
  }

  console.log(`  Grouped ${jobRelated.length} messages into ${extractGroups.size} cross-source conversations`);

  for (const [, group] of extractGroups) {
    // Build conversation text with source AND direction markers, sorted by date
    const sorted = group.messages.sort((a, b) => a.messageDate.localeCompare(b.messageDate));
    const conversationText = sorted
      .map(m => `[${m.source} - ${m.direction}] ${m.body}`)
      .join('\n\n')
      .substring(0, 4000);
    const latestDate = sorted[sorted.length - 1].messageDate;

    // Add LinkedIn headline and email domain context if available
    const headline = linkedinHeadlines.get(group.displayName);
    const email = contactEmails.get(group.displayName);
    let additionalContext = '';
    if (headline) additionalContext += `\nLinkedIn headline for ${group.displayName}: "${headline}"`;
    if (email) additionalContext += `\nEmail address for ${group.displayName}: ${email}`;

    const extracted = await extractCommitments(
      conversationText, group.displayName, latestDate, today, additionalContext
    );
    if (extracted) {
      extracted.channel = [...group.sources].join(', ');
      extracted.messageDate = latestDate;
      commitments.push(extracted);
    }
  }

  // Step 5: Update CRM
  console.log('Updating CRM...');
  let added = 0, updated = 0, skipped = 0;

  for (const commitment of commitments) {
    if (!commitment.contactName) continue;

    if (isOwnerName(commitment.contactName) || isOwnerEmail(commitment.contactName)) {
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

  // Cross-reference: clear follow-ups where an outgoing email was sent
  const outgoingEmails = emailMessages.filter(m => m.direction === 'outgoing');
  const companiesAfterCal = db.prepare('SELECT * FROM companies WHERE next_follow_up_date IS NOT NULL').all();
  for (const company of companiesAfterCal) {
    const contactsList = (company.contacts || '').toLowerCase().split(',').map(s => s.trim());

    for (const email of outgoingEmails) {
      const emailTo = (email.contactName || '').toLowerCase();
      const matches = contactsList.some(contact => {
        const firstName = contact.split(' ')[0];
        return firstName && emailTo.includes(firstName);
      });

      if (matches && company.next_follow_up_date) {
        const replyDate = tsToDate(email.timestamp);
        if (replyDate >= company.next_follow_up_date) {
          console.log(`  Clearing follow-up for ${company.company}: outgoing email sent on ${replyDate}`);
          db.prepare('UPDATE companies SET next_follow_up_date = NULL, follow_up_action = NULL, last_interaction_date = ?, last_interaction_summary = ?, updated_at = ? WHERE id = ?')
            .run(replyDate, `Replied via email`, Date.now(), company.id);
          cleared++;
          break;
        }
      }
    }
  }

  // Also check WhatsApp calls from last 7 days
  const recentCalls = getCallsSince(db, Date.now() - SEVEN_DAYS_MS);
  console.log(`  WhatsApp calls in last 7 days: ${recentCalls.length}`);

  // Build phone-to-company mapping: find phone numbers mentioned in message
  // bodies from known company contacts (e.g., someone shares their number on LinkedIn)
  const phoneToCompany = new Map(); // normalized phone -> { companyName, contactName }
  const allCompaniesForPhones = db.prepare('SELECT * FROM companies').all();
  for (const company of allCompaniesForPhones) {
    const contactsList = (company.contacts || '').split(',').map(s => s.trim()).filter(Boolean);
    for (const contactName of contactsList) {
      // Find messages from this contact that contain phone numbers
      const msgs = db.prepare(
        "SELECT body, phone FROM messages WHERE contact_name = ? AND classified = 1"
      ).all(contactName);
      for (const msg of msgs) {
        // Extract phone numbers from message body (Indian +91 and international formats)
        const phoneMatches = (msg.body || '').match(/\+?\d[\d\s\-()]{7,}\d/g) || [];
        for (const ph of phoneMatches) {
          const normalized = ph.replace(/[\s\-()+ ]/g, '');
          if (normalized.length >= 10) {
            phoneToCompany.set(normalized.slice(-10), { companyName: company.company, contactName, companyId: company.id });
          }
        }
        // Also index the phone field from WhatsApp messages
        if (msg.phone) {
          const norm = msg.phone.replace(/[\s\-()+ ]/g, '');
          if (norm.length >= 10) {
            phoneToCompany.set(norm.slice(-10), { companyName: company.company, contactName, companyId: company.id });
          }
        }
      }
    }
  }
  console.log(`  Phone-to-company index: ${phoneToCompany.size} numbers mapped`);

  const remainingCompanies = db.prepare('SELECT * FROM companies WHERE next_follow_up_date IS NOT NULL').all();
  for (const company of remainingCompanies) {
    const contactsList = (company.contacts || '').toLowerCase().split(',').map(s => s.trim());

    for (const call of recentCalls) {
      const callName = (call.contact_name || '').toLowerCase();
      // Match by contact name
      let matches = contactsList.some(contact =>
        contact && callName.includes(contact.split(' ')[0])
      );

      // If no name match, try matching by phone number
      if (!matches && call.phone) {
        const callPhoneNorm = call.phone.replace(/[\s\-()+ ]/g, '').slice(-10);
        const phoneMatch = phoneToCompany.get(callPhoneNorm);
        if (phoneMatch && phoneMatch.companyId === company.id) {
          matches = true;
        }
      }

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

  if (cleared > 0) console.log(`Cleared ${cleared} total follow-ups satisfied by meetings/calls/emails.`);

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
