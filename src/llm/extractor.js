// src/llm/extractor.js
const Anthropic = require('@anthropic-ai/sdk');
const { getOwnerProfile } = require('../config');

const client = new Anthropic();

const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;

async function callWithRetry(fn, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429 && i < retries - 1) {
        const delay = RETRY_DELAY_MS * (i + 1);
        console.log(`Rate limited, waiting ${delay / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

async function extractCommitments(conversationText, contactName, messageDate, todayDate, additionalContext) {
  const { name: ownerName, email: ownerEmail } = getOwnerProfile();
  const ownerDisplayName = ownerName || 'The CRM owner';
  const ownerDisplayEmail = ownerEmail || 'unknown-email@example.com';
  const ownerUpperName = ownerDisplayName.toUpperCase();

  // Determine direction from the conversation text markers
  const hasDirectionMarkers = /\[(Email|LinkedIn|WhatsApp)\s*-\s*(outgoing|incoming)\]/.test(conversationText);
  const lastDirectionMatch = conversationText.match(/\[(?:Email|LinkedIn|WhatsApp)\s*-\s*(outgoing|incoming)\][^[]*$/);
  const lastDirection = lastDirectionMatch ? lastDirectionMatch[1] : null;

  const senderLine = lastDirection === 'outgoing'
    ? `The most recent message was SENT BY ${ownerDisplayName} TO ${contactName}.`
    : lastDirection === 'incoming'
      ? `The most recent message was SENT BY ${contactName} TO ${ownerDisplayName}.`
      : `Message between ${ownerDisplayName} and ${contactName}.`;

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this personal CRM relevant conversation and extract structured data.

${senderLine}
${additionalContext || ''}
Each message is prefixed with [Source - direction] to show the channel and direction:
- [Email - outgoing] = ${ownerDisplayName} emailed ${contactName}
- [LinkedIn - incoming] = ${contactName} messaged ${ownerDisplayName} on LinkedIn
- [WhatsApp - outgoing] = ${ownerDisplayName} messaged ${contactName} on WhatsApp
Messages may span MULTIPLE channels (Email, LinkedIn, WhatsApp). Treat them as ONE continuous interaction.
The most recent message date is: ${messageDate}
Today's date is: ${todayDate}

WHO IS WHO:
- ${ownerDisplayName} (${ownerDisplayEmail}) is the CRM owner.
- ${contactName} is the other person.
- "I", "me", "my" in the message refers to whoever SENT the message (see direction markers).
- If the message is outgoing (sent by ${ownerDisplayName}), then "I will send that tomorrow" means ${ownerUpperName} will do it.
- If the message is incoming (sent by ${contactName}), then "Can you help me?" means ${contactName} is asking for help.

CROSS-CHANNEL AWARENESS (CRITICAL):
- These messages come from multiple channels but are about the SAME relationship.
- If a request was made on one channel (e.g., "send me your CV" on LinkedIn) and fulfilled on another (e.g., CV sent via email), the request is SATISFIED — do NOT create a follow-up for it.
- Look at the FULL picture across all channels before deciding on follow-ups.

DATE RULES:
1. Resolve all relative dates ("tomorrow", "next week", "Monday") relative to the MESSAGE DATE (${messageDate}), NOT today.
2. Resolve to absolute YYYY-MM-DD format.
3. Keep past dates — they become overdue reminders.

PERSONAL CRM RULES:
- Extract the OTHER person, not ${ownerDisplayName}.
- Track obligations, promises, reminders, waiting states, and durable relationship context.
- followUpDate / followUpAction are only for things ${ownerDisplayName} needs to do.
- waitingOnThem should be true if the other person owes a reply, intro, file, update, scheduling confirmation, or similar next step.
- waitingOnWhat should describe that dependency briefly.
- relationshipType can be Recruiter, Hiring Manager, Referral, Network contact, Friend, Family, Client, Colleague, Founder, Investor, Vendor, Mentor, or Other.
- priority should reflect reminder urgency: High, Medium, or Low.
- status should be one of Active, Waiting, Dormant, or Closed.
- notes should only capture durable context worth remembering later, not a full transcript.

COMPANY RULES (IMPORTANT):
- Try hard to infer the company name from ANY clue in the conversation: company names, job postings, URLs, role titles, or references to "the role", "the position", "the team".
- If a LinkedIn headline is provided above, extract the company name from it (e.g. "Senior Recruiter at KPMG" → company is "KPMG").
- If an email address is provided above, use the email domain to identify the company (e.g. "john@kpmg.com" → company is "KPMG"). Ignore generic domains like gmail.com, yahoo.com, hotmail.com, outlook.com, etc.
- If ${contactName} is referring someone or acting as a middleman, the company is wherever the ROLE is, not where ${contactName} works.
- If no company can be identified from any of these sources, return null for company. Do NOT use "Unknown" or "Unknown (via ...)" as a company name.

Extract info about the OTHER person (${contactName}), not ${ownerDisplayName}.

Conversation:
${conversationText}

Return a JSON object with these fields (use null if not found):
{
  "contactName": "full name of the OTHER person (not ${ownerDisplayName})",
  "company": "their company or the company where the role is",
  "roleTitle": "their job title/role",
  "relationshipType": "Recruiter | Hiring Manager | Referral | Network contact | Friend | Family | Client | Colleague | Founder | Investor | Vendor | Mentor | Other",
  "roleDiscussed": "specific job role being discussed, or relationship context",
  "interactionSummary": "one-line summary of this exchange across all channels",
  "followUpDate": "YYYY-MM-DD — only if ${ownerDisplayName} has an UNSATISFIED action to take, otherwise null",
  "followUpAction": "what ${ownerDisplayName} needs to do (verb phrase), or null",
  "waitingOnThem": true,
  "waitingOnWhat": "what the other person owes or needs to reply with, or null",
  "priority": "High | Medium | Low",
  "status": "Active | Waiting | Dormant | Closed",
  "notes": "durable context to save for future follow-up, or null"
}

IMPORTANT: Never return ${ownerDisplayName} as the contactName. If you cannot identify another person, return null for contactName.

Return ONLY the JSON, no other text.`
    }]
  }));

  const text = (response.content[0].text || '').trim();

  if (!text) {
    console.warn('LLM returned empty response, using heuristic fallback.');
    return extractHeuristicCommitment(conversationText, contactName, messageDate, lastDirection);
  }

  try {
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse LLM response:', text.slice(0, 200));
    return extractHeuristicCommitment(conversationText, contactName, messageDate, lastDirection);
  }
}

function extractHeuristicCommitment(messageText, contactName, messageDate, direction) {
  const text = (messageText || '').replace(/\s+/g, ' ').trim();
  const lowered = text.toLowerCase();
  const followUpDate = resolveRelativeDate(lowered, messageDate);

  if (direction === 'outgoing') {
    const outgoingAction = extractOutgoingAction(text);
    if (outgoingAction && followUpDate) {
      return {
        contactName: contactName || null,
        company: null,
        roleTitle: null,
        relationshipType: 'Other',
        roleDiscussed: 'Follow-up conversation',
        interactionSummary: summarizeInteraction(text, contactName, 'Promised a follow-up'),
        followUpDate,
        followUpAction: outgoingAction,
        waitingOnThem: false,
        waitingOnWhat: null,
        priority: 'High',
        status: 'Active',
        notes: 'Extracted via heuristic fallback',
      };
    }
  }

  const waitingOnWhat = extractIncomingPromise(text);
  if (waitingOnWhat && followUpDate) {
    return {
      contactName: contactName || null,
      company: null,
      roleTitle: null,
      relationshipType: 'Other',
      roleDiscussed: 'Follow-up conversation',
      interactionSummary: summarizeInteraction(text, contactName, 'Waiting on a promised follow-up'),
      followUpDate,
      followUpAction: null,
      waitingOnThem: true,
      waitingOnWhat,
      priority: 'Medium',
      status: 'Waiting',
      notes: 'Extracted via heuristic fallback',
    };
  }

  return null;
}

function extractOutgoingAction(text) {
  const patterns = [
    /\blet me ([^.?!]+)/i,
    /\bi(?:'| wi)?ll ([^.?!]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const action = match[1]
        .replace(/\b(today|tonight|this evening|tomorrow|next week|on monday|on tuesday|on wednesday|on thursday|on friday|on saturday|on sunday)\b/ig, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (action) return capitalize(action);
    }
  }

  return null;
}

function extractIncomingPromise(text) {
  const patterns = [
    /\bi(?:'| wi)?ll ([^.?!]+)/i,
    /\blet me ([^.?!]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return capitalize(match[1].replace(/\s+/g, ' ').trim());
    }
  }

  return null;
}

function resolveRelativeDate(loweredText, baseDate) {
  if (!baseDate) return null;

  const base = new Date(`${baseDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;

  if (/\b(today|tonight|this evening)\b/.test(loweredText)) {
    return formatDate(base);
  }

  if (/\btomorrow\b/.test(loweredText)) {
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 1);
    return formatDate(next);
  }

  if (/\bnext week\b/.test(loweredText)) {
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 7);
    return formatDate(next);
  }

  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < weekdays.length; i++) {
    const weekday = weekdays[i];
    if (new RegExp(`\\b${weekday}\\b`).test(loweredText)) {
      const currentDay = base.getUTCDay();
      let delta = (i - currentDay + 7) % 7;
      if (delta === 0) delta = 7;
      const resolved = new Date(base);
      resolved.setUTCDate(resolved.getUTCDate() + delta);
      return formatDate(resolved);
    }
  }

  return null;
}

function summarizeInteraction(text, contactName, fallback) {
  const firstSentence = text.split(/[.?!]\s/)[0]?.trim();
  if (firstSentence) return firstSentence;
  if (contactName) return `${fallback} with ${contactName}`;
  return fallback;
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

module.exports = { extractCommitments };
