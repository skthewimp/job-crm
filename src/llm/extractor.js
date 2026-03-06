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

CRITICAL DATE RULES:
1. All relative time references ("tomorrow", "next week", "Monday", "end of week", etc.) are relative to the MESSAGE DATE (${messageDate}), NOT today.
2. ALWAYS resolve to an absolute date in YYYY-MM-DD format. Examples:
   - Message sent 2026-03-01 says "let's talk Monday" → followUpDate: "2026-03-03"
   - Message sent 2026-02-25 says "I'll ping you next week" → followUpDate: "2026-03-02"
   - Message sent 2026-03-04 says "will send by Friday" → followUpDate: "2026-03-06"
3. If the message says "let's talk at 9" or "call me today" with no future date reference, the follow-up date is the message date itself: ${messageDate}
4. KEEP the date even if it's in the past. Past dates become overdue reminders. Do NOT set to null just because the date has passed.
5. Only set followUpDate to null if no follow-up action is mentioned at all.

The job seeker is Karthik Shashidhar (REDACTED_EMAIL). Extract info about the other person they are communicating with.

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
  "followUpDate": "YYYY-MM-DD — the resolved absolute date when follow-up should happen, or null if no action mentioned",
  "followUpAction": "what Karthik needs to do (e.g. 'Send resume', 'Follow up on role', 'Schedule call'), or null",
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
