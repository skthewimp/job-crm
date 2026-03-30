// src/llm/classifier.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const BATCH_SIZE = 20;
const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 3;
const JOB_SEARCH_KEYWORDS = /\b(job|role|position|hiring|recruit|interview|resume|cv|offer|candidate|application|apply|openings?|opportunity|JD|job description)\b/i;

const OUTBOUND_COMMITMENT_PATTERNS = [
  /\bi('| a)?ll\b.+\b(get back|follow up|send|share|revert|reply|update|call|introduce|connect|circle back)\b/i,
  /\blet me\b.+\b(get back|send|share|follow up|reply|check|confirm|introduce)\b/i,
  /\bwill\b.+\b(send|share|follow up|reply|update|call|introduce|connect)\b/i,
];
const WAITING_OR_COORDINATION_PATTERNS = [
  /\bawait(ing)?\b/i,
  /\bplease\b.+\b(send|share|reply|confirm|review|check)\b/i,
  /\bnext week\b/i,
  /\btomorrow\b/i,
  /\bthis evening\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight|tomorrow)\b/i,
];

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

async function classifyBatch(messages) {
  const numbered = messages.map((msg, i) =>
    `[${i + 1}] ${getMessageTextForClassification(msg).substring(0, 700)}`
  ).join('\n\n');

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Classify each numbered message below as JOB-SEARCH relevant or not.

This is a JOB SEARCH CRM. A message is relevant ONLY if it relates to:
- job opportunities, roles, positions, or hiring discussions
- recruiter outreach or communication with hiring managers
- job applications, interviews, assessments, or offer discussions
- professional introductions specifically for job/role opportunities
- resume/CV sharing in the context of job applications
- career-related networking where a specific role or company opportunity is being discussed

Mark as NOT relevant if it is:
- casual banter, social catch-ups, coffee meetings with no job context
- investor relations, fundraising, or business development
- personal favors, family matters, or non-career introductions
- spam, promo, OTP, receipt, or automated noise
- general professional networking with no specific job/role discussed
- business operations, client work, consulting engagements
- anything that doesn't involve finding or applying for a job

For each message, output ONLY its number and "yes" or "no", one per line. Example:
1: yes
2: no
3: yes

Messages:

${numbered}`
    }]
  }));

  const text = response.content[0].text;
  const results = new Set();
  for (const line of text.split('\n')) {
    const match = line.match(/(\d+)\s*:\s*(yes)/i);
    if (match) results.add(parseInt(match[1]) - 1);
  }

  // Regex fallback: catch obvious CRM messages the LLM missed
  messages.forEach((message, idx) => {
    if (!results.has(idx) && isObviousCrmMessage(message)) {
      results.add(idx);
    }
  });

  return results;
}

async function classifyMessages(messages) {
  if (messages.length === 0) return [];

  const relevantMessages = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    console.log(`  Classifying batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messages.length / BATCH_SIZE)}...`);
    const hits = await classifyBatch(batch);
    for (const idx of hits) {
      if (batch[idx]) {
        relevantMessages.push({ ...batch[idx], isCrmRelevant: true });
      }
    }
    // Small delay between batches to stay under rate limits
    if (i + BATCH_SIZE < messages.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return relevantMessages;
}

function getMessageTextForClassification(message) {
  const subject = (message.subject || '').trim();
  const body = (message.body || '').trim();
  const direction = message.direction ? `Direction: ${message.direction}\n` : '';
  const contact = message.contactName ? `Contact: ${message.contactName}\n` : '';

  if (subject) {
    return `${direction}${contact}Subject: ${subject}\n\n${body}`;
  }

  return `${direction}${contact}${body}`;
}

function isObviousCrmMessage(message) {
  const text = getMessageTextForClassification(message);

  // Regex fallback only fires if the message contains job-search keywords
  if (!JOB_SEARCH_KEYWORDS.test(text)) {
    return false;
  }

  const isOutgoing = message.direction === 'outgoing';

  if (isOutgoing && OUTBOUND_COMMITMENT_PATTERNS.some(pattern => pattern.test(text))) {
    return true;
  }

  return WAITING_OR_COORDINATION_PATTERNS.some(pattern => pattern.test(text)) &&
    /(follow up|get back|send|share|reply|update|info|information|intro|connect|call|meeting|confirm)/i.test(text);
}

module.exports = { classifyMessages };
