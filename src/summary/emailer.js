const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');
const { getCompaniesDueForFollowUp } = require('../db');

async function sendDailySummary(db, calendarEvents) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const today = new Date().toISOString().split('T')[0];

  const allDue = getCompaniesDueForFollowUp(db, today);
  const overdue = allDue.filter(c => c.next_follow_up_date < today);
  const dueToday = allDue.filter(c => c.next_follow_up_date === today);

  // Only job-related calendar events for next 3 days
  const jobEvents = (calendarEvents || []).filter(e => e && e.summary);

  const totalItems = overdue.length + dueToday.length + jobEvents.length;

  const html = buildEmailHtml(overdue, dueToday, jobEvents, today);

  const subject = totalItems > 0
    ? `Job Hunt: ${totalItems} to-do${totalItems > 1 ? 's' : ''} for ${today}`
    : `Job Hunt: Nothing due today (${today})`;

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

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage }
  });

  console.log('Daily summary email sent.');
}

function buildEmailHtml(overdue, dueToday, calendarEvents, today) {
  let html = '<div style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto">';

  if (overdue.length === 0 && dueToday.length === 0 && calendarEvents.length === 0) {
    html += '<p>Nothing due today. No overdue items.</p></div>';
    return html;
  }

  // Overdue - these come first, they're the most urgent
  if (overdue.length > 0) {
    html += '<h3 style="color:#cc0000;margin-bottom:8px">Overdue</h3>';
    html += formatTodos(overdue, true);
  }

  // Due today
  if (dueToday.length > 0) {
    html += '<h3 style="color:#0066cc;margin-bottom:8px">Today</h3>';
    html += formatTodos(dueToday, false);
  }

  // Calendar events
  if (calendarEvents.length > 0) {
    html += '<h3 style="margin-bottom:8px">Upcoming meetings</h3><ul style="padding-left:20px">';
    for (const e of calendarEvents) {
      const time = new Date(e.start).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      html += `<li>${e.summary} - ${time}`;
      if (e.location) html += ` (${e.location})`;
      html += '</li>';
    }
    html += '</ul>';
  }

  html += '</div>';
  return html;
}

function formatTodos(items, showDate) {
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

module.exports = { sendDailySummary };
