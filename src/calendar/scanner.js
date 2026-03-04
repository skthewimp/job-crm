// src/calendar/scanner.js
const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');

async function scanCalendar(daysAhead = 3) {
  const auth = getOAuth2Client();
  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = res.data.items || [];

  return events.map(event => ({
    id: event.id,
    summary: event.summary || 'No title',
    description: event.description || '',
    start: event.start.dateTime || event.start.date,
    end: event.end.dateTime || event.end.date,
    attendees: (event.attendees || []).map(a => ({
      email: a.email,
      name: a.displayName || a.email,
      status: a.responseStatus
    })),
    location: event.location || '',
    htmlLink: event.htmlLink
  }));
}

module.exports = { scanCalendar };
