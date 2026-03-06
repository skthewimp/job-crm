// src/llm/extractor.js
const Anthropic = require('@anthropic-ai/sdk');

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

async function extractCommitments(messageText, contactName, messageDate, todayDate) {
  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this job-hunt related message and extract structured data about the OTHER person (not Karthik Shashidhar, who is the job seeker).

This message was sent on: ${messageDate}
Today's date is: ${todayDate}

CRITICAL: All relative time references in the message ("tomorrow", "next week", "let's talk at 9", "Monday", etc.) are relative to the MESSAGE DATE (${messageDate}), NOT today. For example:
- If the message was sent on 2026-03-01 and says "let's talk Monday", that means 2026-03-03 (the Monday after March 1st)
- If the message says "follow up next week" and was sent on 2026-02-25, the follow-up date is around 2026-03-02
- If the message says "let's talk at 9" with no future date, it means ${messageDate} at 9:00 — this is ALREADY PAST, so set followUpDate to null
- Only set a followUpDate if the resolved date is today (${todayDate}) or later. If the follow-up date has already passed, set followUpDate to null.

The job seeker is Karthik Shashidhar (karthik.shashidhar@gmail.com). Extract info about the other person they are communicating with.

Message from/about: ${contactName}
Message: "${messageText}"

Return a JSON object with these fields (use null if not found):
{
  "contactName": "full name of the OTHER person (not Karthik)",
  "company": "their company",
  "roleTitle": "their job title/role",
  "relationshipType": "Recruiter | Hiring Manager | Referral | Network contact",
  "roleDiscussed": "specific job role being discussed for Karthik",
  "interactionSummary": "one-line summary of this exchange",
  "followUpDate": "YYYY-MM-DD — only if a concrete future follow-up is needed (on or after ${todayDate}), otherwise null",
  "followUpAction": "what needs to be done by the follow-up date, or null if no action pending",
  "status": "Active | Waiting | Interview Scheduled"
}

IMPORTANT: Never return Karthik Shashidhar as the contactName. If you cannot identify another person, return null for contactName.

Return ONLY the JSON, no other text.`
    }]
  }));

  try {
    const text = response.content[0].text.trim();
    const jsonStr = text.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    return JSON.parse(jsonStr);
  } catch {
    console.error('Failed to parse LLM response:', response.content[0].text);
    return null;
  }
}

module.exports = { extractCommitments };
