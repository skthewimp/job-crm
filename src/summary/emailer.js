const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { getOAuth2Client } = require('../google-auth');
const { getCompaniesDueForFollowUp, getContacts } = require('../db');
const { getCrmTimezone, getGmailSelfEmail } = require('../config');

const THREAD_ID_PATH = path.join(__dirname, '..', '..', 'data', 'last-summary-thread.json');

function getLastThreadId() {
  try {
    if (fs.existsSync(THREAD_ID_PATH)) {
      return JSON.parse(fs.readFileSync(THREAD_ID_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return null;
}

function saveThreadId(threadId, date) {
  fs.mkdirSync(path.dirname(THREAD_ID_PATH), { recursive: true });
  fs.writeFileSync(THREAD_ID_PATH, JSON.stringify({ threadId, date }, null, 2));
}

async function sendDailySummary(db, calendarEvents, feedbackApplied) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const selfEmail = getGmailSelfEmail();
  const today = new Date().toISOString().split('T')[0];

  const allDue = getCompaniesDueForFollowUp(db, today);
  const overdue = allDue.filter(c => c.next_follow_up_date < today);
  const dueToday = allDue.filter(c => c.next_follow_up_date === today);

  // Contacts in "Waiting" status with no follow-up date (waiting on others)
  const allContacts = getContacts(db);
  const waiting = allContacts
    .filter(c => c.status === 'Waiting' && !c.next_follow_up_date)
    .slice(0, 10);

  // Recent interactions not already in the due list
  const dueCompanyNames = new Set(allDue.map(c => c.company));
  const recent = allContacts
    .filter(c => c.last_interaction_date && !dueCompanyNames.has(c.company))
    .slice(0, 5);

  const upcomingEvents = (calendarEvents || []).filter(e => e && e.summary);
  const totalItems = overdue.length + dueToday.length + waiting.length + upcomingEvents.length;

  const html = buildEmailHtml(overdue, dueToday, waiting, upcomingEvents, recent, today, feedbackApplied);

  const timezone = getCrmTimezone();
  const scanTime = new Date().toLocaleTimeString('en-IN', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: true });

  const subject = totalItems > 0
    ? `CRM: ${totalItems} to-do${totalItems > 1 ? 's' : ''} for ${today} (scanned ${scanTime})`
    : `CRM: Nothing due today (${today}, scanned ${scanTime})`;

  const message = [
    `To: ${selfEmail}`,
    'Content-Type: text/html; charset=utf-8',
    `Subject: ${subject}`,
    '',
    html
  ].join('\n');

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const sent = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage }
  });

  // Save thread ID so feedback processor can find replies tomorrow
  if (sent.data?.threadId) {
    saveThreadId(sent.data.threadId, today);
  }

  console.log('Daily summary email sent.');
}

function buildEmailHtml(overdue, dueToday, waiting, calendarEvents, recent, today, feedbackApplied) {
  const timezone = getCrmTimezone();
  let html = '<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">';

  // Show feedback that was applied from yesterday's reply
  if (feedbackApplied && feedbackApplied.length > 0) {
    html += '<h3 style="color:#228B22;margin-bottom:8px">Your feedback applied</h3>';
    html += '<ul style="padding-left:20px;margin-top:4px">';
    for (const fb of feedbackApplied) {
      html += `<li>${fb}</li>`;
    }
    html += '</ul>';
  }

  if (overdue.length === 0 && dueToday.length === 0 && waiting.length === 0 && calendarEvents.length === 0 && recent.length === 0) {
    html += '<p>Nothing due today. No overdue items or waiting relationships.</p>';
    html += buildFooter();
    html += '</div>';
    return html;
  }

  // Overdue - these come first, they're the most urgent
  if (overdue.length > 0) {
    html += '<h3 style="color:#cc0000;margin-bottom:8px">Overdue</h3>';
    html += formatCompanyTodos(overdue, true);
  }

  // Due today
  if (dueToday.length > 0) {
    html += '<h3 style="color:#0066cc;margin-bottom:8px">Today</h3>';
    html += formatCompanyTodos(dueToday, false);
  }

  // Waiting on others
  if (waiting.length > 0) {
    html += '<h3 style="color:#8a5a00;margin-bottom:8px">Waiting On Others</h3>';
    html += formatWaiting(waiting);
  }

  // Calendar events
  if (calendarEvents.length > 0) {
    html += '<h3 style="margin-bottom:8px">Upcoming meetings</h3><ul style="padding-left:20px">';
    for (const e of calendarEvents) {
      const time = new Date(e.start).toLocaleString('en-IN', {
        timeZone: timezone,
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      html += `<li>${e.summary} - ${time}`;
      if (e.location) html += ` (${e.location})`;
      html += '</li>';
    }
    html += '</ul>';
  }

  // Recent interactions
  if (recent.length > 0) {
    html += '<h3 style="margin-bottom:8px">Recent Interactions</h3>';
    html += formatRecent(recent);
  }

  html += buildFooter();
  html += '</div>';
  return html;
}

function buildFooter() {
  return '<p style="color:#666;font-size:12px;margin-top:24px;border-top:1px solid #eee;padding-top:12px">' +
    'Reply to this email with feedback. Examples:<br>' +
    '- "Drop Acme Corp - not interested"<br>' +
    '- "Postpone HasGeek to next week"<br>' +
    '- "Already spoke to Irina, clear the follow-up"<br>' +
    '- "Change status of Microsoft to Interview Scheduled"' +
    '</p>';
}

function formatCompanyTodos(items, showDate) {
  let html = '<ul style="padding-left:20px;margin-top:4px">';
  for (const c of items) {
    const action = c.follow_up_action || 'Follow up';
    const who = c.contacts ? `${c.company} (${c.contacts})` : c.company;
    html += `<li><strong>${action}</strong> - ${who}`;
    if (showDate) html += ` <span style="color:#999">[was due ${c.next_follow_up_date}]</span>`;
    html += '</li>';
  }
  html += '</ul>';
  return html;
}

function formatWaiting(items) {
  let html = '<ul style="padding-left:20px;margin-top:4px">';
  for (const c of items) {
    const waitingOn = extractWaitingOn(c);
    const who = c.company ? `${c.name} (${c.company})` : c.name;
    html += `<li><strong>${who}</strong>`;
    if (waitingOn) html += ` - waiting on ${waitingOn}`;
    html += '</li>';
  }
  html += '</ul>';
  return html;
}

function formatRecent(items) {
  let html = '<ul style="padding-left:20px;margin-top:4px">';
  for (const c of items) {
    const who = c.company ? `${c.name} (${c.company})` : c.name;
    html += `<li><strong>${who}</strong> - ${c.last_interaction_summary || 'Recent interaction logged'}</li>`;
  }
  html += '</ul>';
  return html;
}

function extractWaitingOn(contact) {
  const notes = contact.notes || '';
  const match = notes.match(/Waiting on:\s*(.+)/i);
  return match ? match[1].trim() : '';
}

module.exports = { sendDailySummary, getLastThreadId };
