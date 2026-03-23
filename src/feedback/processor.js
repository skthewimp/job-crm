// src/feedback/processor.js
// Processes replies to daily summary emails as CRM commands.
// Users can reply with natural language like "drop X", "postpone Y to next week", etc.

const { google } = require('googleapis');
const { getOAuth2Client } = require('../google-auth');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function checkForFeedback(lastThreadId) {
  if (!lastThreadId) {
    console.log('  Feedback: no previous summary thread ID found, skipping.');
    return null;
  }

  const auth = getOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  // Get the thread to find replies
  const thread = await gmail.users.threads.get({
    userId: 'me',
    id: lastThreadId,
    format: 'full'
  });

  const messages = thread.data.messages || [];
  if (messages.length <= 1) {
    console.log('  Feedback: no replies to last summary.');
    return null;
  }

  // Skip the first message (the original summary), collect replies
  const replies = [];
  for (const msg of messages.slice(1)) {
    const body = extractPlainText(msg.payload);
    if (body && body.trim()) {
      replies.push(body.trim());
    }
  }

  if (replies.length === 0) {
    console.log('  Feedback: replies found but no readable text.');
    return null;
  }

  console.log(`  Feedback: found ${replies.length} reply(s) to process.`);
  return replies.join('\n---\n');
}

function extractPlainText(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractPlainText(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

async function parseFeedback(replyText, companies) {
  const companyList = companies.map(c =>
    `- "${c.company}" (contacts: ${c.contacts || 'none'}, status: ${c.status}, follow-up: ${c.next_follow_up_date || 'none'}, action: ${c.follow_up_action || 'none'})`
  ).join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Parse this user reply to their daily CRM summary email. Extract actionable instructions.

Current companies in CRM:
${companyList}

User's reply:
"${replyText}"

Return a JSON array of actions. Each action should be one of:
- {"action": "drop", "company": "exact company name", "reason": "user's reason"}
  → Mark as Not Interested, clear follow-up
- {"action": "clear_followup", "company": "exact company name", "reason": "why"}
  → Clear the follow-up date (e.g., already handled)
- {"action": "postpone", "company": "exact company name", "newDate": "YYYY-MM-DD", "reason": "why"}
  → Move follow-up to a new date
- {"action": "update_status", "company": "exact company name", "status": "new status", "reason": "why"}
  → Change status (Active, Waiting, Interview Scheduled, Offer, Closed, Not Interested)
- {"action": "note", "company": "exact company name", "note": "text to add"}
  → Add a note to the company record
- {"action": "unknown", "text": "original instruction you couldn't parse"}
  → For anything you can't map to an action

Match company names fuzzy but return the EXACT name from the CRM list above.
Today's date is ${new Date().toISOString().split('T')[0]}.
For "next week", use the Monday of next week. For "tomorrow", use the next day.

Return ONLY the JSON array, no other text.`
    }]
  });

  try {
    const text = response.content[0].text.trim();
    return parseJsonResponse(text);
  } catch {
    console.error('  Feedback: failed to parse LLM response:', response.content[0].text);
    return [];
  }
}

function parseJsonResponse(text) {
  // Strip markdown fences
  let cleaned = text.replace(/^```json?\n?/s, '').replace(/\n?```$/s, '').trim();

  // Try parsing as-is
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // Try extracting the JSON array from surrounding text
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch { /* continue */ }
  }

  // Try fixing common issues: trailing commas, smart quotes
  cleaned = cleaned
    .replace(/,\s*([\]}])/g, '$1')           // trailing commas
    .replace(/[\u201c\u201d]/g, '"')          // smart quotes
    .replace(/[\u2018\u2019]/g, "'");         // smart apostrophes
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  console.error('  Feedback: could not parse LLM JSON, raw response:', text.substring(0, 500));
  return [];
}

function applyFeedback(db, actions) {
  const applied = [];

  for (const action of actions) {
    if (action.action === 'unknown') {
      console.log(`  Feedback: couldn't parse: "${action.text}"`);
      applied.push(`Could not understand: "${action.text}"`);
      continue;
    }

    const company = db.prepare('SELECT * FROM companies WHERE company = ?').get(action.company);
    if (!company) {
      console.log(`  Feedback: company "${action.company}" not found in CRM.`);
      applied.push(`Company "${action.company}" not found`);
      continue;
    }

    switch (action.action) {
      case 'drop': {
        db.prepare(
          'UPDATE companies SET status = ?, next_follow_up_date = NULL, follow_up_action = NULL, notes = ?, updated_at = ? WHERE id = ?'
        ).run('Not Interested', appendNote(company.notes, `Dropped: ${action.reason || 'user request'}`), Date.now(), company.id);
        const msg = `Dropped ${action.company} — marked Not Interested`;
        console.log(`  Feedback: ${msg}`);
        applied.push(msg);
        break;
      }
      case 'clear_followup': {
        db.prepare(
          'UPDATE companies SET next_follow_up_date = NULL, follow_up_action = NULL, updated_at = ? WHERE id = ?'
        ).run(Date.now(), company.id);
        const msg = `Cleared follow-up for ${action.company}`;
        console.log(`  Feedback: ${msg}`);
        applied.push(msg);
        break;
      }
      case 'postpone': {
        db.prepare(
          'UPDATE companies SET next_follow_up_date = ?, updated_at = ? WHERE id = ?'
        ).run(action.newDate, Date.now(), company.id);
        const msg = `Postponed ${action.company} to ${action.newDate}`;
        console.log(`  Feedback: ${msg}`);
        applied.push(msg);
        break;
      }
      case 'update_status': {
        db.prepare(
          'UPDATE companies SET status = ?, updated_at = ? WHERE id = ?'
        ).run(action.status, Date.now(), company.id);
        const msg = `Updated ${action.company} status to ${action.status}`;
        console.log(`  Feedback: ${msg}`);
        applied.push(msg);
        break;
      }
      case 'note': {
        db.prepare(
          'UPDATE companies SET notes = ?, updated_at = ? WHERE id = ?'
        ).run(appendNote(company.notes, action.note), Date.now(), company.id);
        const msg = `Added note to ${action.company}`;
        console.log(`  Feedback: ${msg}`);
        applied.push(msg);
        break;
      }
    }
  }

  return applied;
}

function appendNote(existing, newNote) {
  if (!existing) return newNote;
  return `${existing}\n${newNote}`.trim();
}

module.exports = { checkForFeedback, parseFeedback, applyFeedback };
