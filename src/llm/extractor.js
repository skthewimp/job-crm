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

DATE RULES:
1. All relative time references ("tomorrow", "next week", "Monday", etc.) are relative to the MESSAGE DATE (${messageDate}), NOT today.
2. ALWAYS resolve to an absolute YYYY-MM-DD date.
3. KEEP the date even if it's in the past — past dates become overdue reminders.

FOLLOW-UP RULES — THIS IS CRITICAL:
Only set followUpDate/followUpAction for things KARTHIK committed to doing or needs to act on. These are actionable to-dos for Karthik.

SET a follow-up when Karthik said or needs to:
- "I'll send you my resume by Friday" → followUpDate: that Friday, action: "Send resume to [person]"
- "Let me follow up next week" → followUpDate: next Monday, action: "Follow up with [person] about [topic]"
- "I'll ping you after the long weekend" → followUpDate: Tuesday after weekend, action: "Ping [person]"
- "Can you send me the JD?" (Karthik asking) → followUpDate: null (ball is in their court)
- Someone says "I'll share the JD" → followUpDate: a few days later, action: "Follow up if JD not received from [person]"

Do NOT set a follow-up for:
- "Let's talk tomorrow" / "Let's connect at 9" / "Can we chat Monday?" — these are meetings that may or may not have happened. We have no way to verify, so don't track them.
- "Nice to meet you" / "Thanks for your time" — no action needed.
- General discussion with no commitment from either side.
- The other person saying they will do something where Karthik just needs to wait (unless enough time has passed that Karthik should nudge them).

In short: followUpDate is Karthik's to-do list. If Karthik doesn't need to DO something, don't set it.

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
  "followUpDate": "YYYY-MM-DD — only if Karthik has a concrete action to take, otherwise null",
  "followUpAction": "what Karthik needs to do (verb phrase: 'Send resume to...', 'Follow up with... about...'), or null",
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
