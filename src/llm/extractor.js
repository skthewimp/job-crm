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

async function extractCommitments(messageText, contactName, messageDate, todayDate, direction) {
  const senderLine = direction === 'outgoing'
    ? `This message was SENT BY Karthik Shashidhar TO ${contactName}.`
    : direction === 'incoming'
      ? `This message was SENT BY ${contactName} TO Karthik Shashidhar.`
      : `Message between Karthik Shashidhar and ${contactName} (direction unknown).`;

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this job-hunt related message and extract structured data.

${senderLine}
This message was sent on: ${messageDate}
Today's date is: ${todayDate}

WHO IS WHO:
- Karthik Shashidhar (REDACTED_EMAIL) is the job seeker. He is the user of this CRM.
- ${contactName} is the other person.
- "I", "me", "my" in the message refers to whoever SENT the message (see above).
- If the message is outgoing (sent by Karthik), then "I will send you my resume" means KARTHIK will send his resume.
- If the message is incoming (sent by ${contactName}), then "Can you help me?" means ${contactName} is asking for help.

DATE RULES:
1. Resolve all relative dates ("tomorrow", "next week", "Monday") relative to the MESSAGE DATE (${messageDate}), NOT today.
2. Resolve to absolute YYYY-MM-DD format.
3. Keep past dates — they become overdue reminders.

FOLLOW-UP RULES:
Only set followUpDate/followUpAction for things KARTHIK needs to act on:
- Karthik said he would do something → follow-up on that date
- Karthik asked for something and hasn't received it → nudge follow-up
- Other person promised to send something → nudge follow-up if enough time has passed
Do NOT set follow-ups for:
- Meetings/calls ("let's talk tomorrow") — can't verify if they happened
- General pleasantries or discussion with no commitment

Extract info about the OTHER person (${contactName}), not Karthik.

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
  "followUpAction": "what Karthik needs to do (verb phrase), or null",
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
