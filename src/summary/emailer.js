const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');
const { getContactsDueForFollowUp } = require('../db');

async function sendDailySummary(db, calendarEvents) {
  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });
  const selfEmail = process.env.GMAIL_SELF_EMAIL;
  const today = new Date().toISOString().split('T')[0];

  const overdue = getContactsDueForFollowUp(db, today);
  const todayFollowUps = overdue.filter(c => c.next_follow_up_date === today);
  const overdueFollowUps = overdue.filter(c => c.next_follow_up_date < today);

  const html = buildEmailHtml(todayFollowUps, overdueFollowUps, calendarEvents, today);

  const message = [
    `To: ${selfEmail}`,
    'Content-Type: text/html; charset=utf-8',
    `Subject: Job Hunt CRM - Daily Summary for ${today}`,
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

function buildEmailHtml(todayFollowUps, overdueFollowUps, calendarEvents, today) {
  let html = `<h2>Job Hunt CRM - ${today}</h2>`;

  if (overdueFollowUps.length > 0) {
    html += '<h3 style="color: #cc0000;">Overdue Follow-ups</h3><ul>';
    for (const c of overdueFollowUps) {
      html += `<li><strong>${c.name}</strong> (${c.company || 'Unknown'}) - Due: ${c.next_follow_up_date}<br/>`;
      html += `Action: ${c.follow_up_action || 'Follow up'}</li>`;
    }
    html += '</ul>';
  }

  if (todayFollowUps.length > 0) {
    html += '<h3 style="color: #0066cc;">Due Today</h3><ul>';
    for (const c of todayFollowUps) {
      html += `<li><strong>${c.name}</strong> (${c.company || 'Unknown'})<br/>`;
      html += `Action: ${c.follow_up_action || 'Follow up'}</li>`;
    }
    html += '</ul>';
  }

  if (calendarEvents && calendarEvents.length > 0) {
    html += '<h3>Upcoming Calendar Events</h3><ul>';
    for (const e of calendarEvents) {
      const time = new Date(e.start).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short'
      });
      html += `<li><strong>${e.summary}</strong> - ${time}`;
      if (e.location) html += ` (${e.location})`;
      html += '</li>';
    }
    html += '</ul>';
  }

  if (overdueFollowUps.length === 0 && todayFollowUps.length === 0 &&
      (!calendarEvents || calendarEvents.length === 0)) {
    html += '<p>No follow-ups due and no upcoming events. Enjoy the day!</p>';
  }

  return html;
}

module.exports = { sendDailySummary };
