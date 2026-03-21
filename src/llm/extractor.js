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

async function extractCommitments(conversationText, contactName, messageDate, todayDate, additionalContext) {
  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this job-hunt related conversation and extract structured data.

This is a conversation between Karthik Shashidhar and ${contactName}.
Each message is prefixed with [Source - direction] to show the channel and direction:
- [Email - outgoing] = Karthik emailed ${contactName}
- [LinkedIn - incoming] = ${contactName} messaged Karthik on LinkedIn
- [WhatsApp - outgoing] = Karthik messaged ${contactName} on WhatsApp
Messages may span MULTIPLE channels (Email, LinkedIn, WhatsApp). Treat them as ONE continuous interaction.
The most recent message date is: ${messageDate}
Today's date is: ${todayDate}
${additionalContext || ''}

WHO IS WHO:
- Karthik Shashidhar (${process.env.GMAIL_SELF_EMAIL}) is the job seeker. He is the user of this CRM.
- ${contactName} is the other person.

CROSS-CHANNEL AWARENESS (CRITICAL):
- These messages come from multiple channels but are about the SAME relationship.
- If a request was made on one channel (e.g., "send me your CV" on LinkedIn) and fulfilled on another (e.g., CV sent via email), the request is SATISFIED — do NOT create a follow-up for it.
- Look at the FULL picture across all channels before deciding on follow-ups.

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
- Actions already completed on ANY channel (e.g., CV already sent by email)
- Meetings/calls ("let's talk tomorrow") — can't verify if they happened
- General pleasantries or discussion with no commitment

COMPANY RULES (IMPORTANT):
- Try hard to infer the company name from ANY clue in the conversation: company names, job postings, URLs, role titles, email domains, or references to "the role", "the position", "the team".
- If a LinkedIn headline is provided above, use it to identify the company — the headline typically contains "Role at Company".
- If ${contactName} is referring someone or acting as a middleman, the company is wherever the ROLE is, not where ${contactName} works.
- If the conversation mentions a specific company or job link, use that.
- If ${contactName} appears to work at or represent a company (e.g., "we're hiring", "our team"), infer that as the company.
- As a last resort, if the conversation is clearly job-related but no company is identifiable, use "Unknown (via ${contactName})" rather than null. This ensures the interaction is tracked.

Extract info about the OTHER person (${contactName}), not Karthik.

Conversation:
${conversationText}

Return a JSON object with these fields (use null ONLY if truly not determinable, except company — see rules above):
{
  "contactName": "full name of the OTHER person (not Karthik)",
  "company": "their company or the company where the role is (NEVER null for job-related conversations — use 'Unknown (via ContactName)' as last resort)",
  "roleTitle": "their job title/role",
  "relationshipType": "Recruiter | Hiring Manager | Referral | Network contact",
  "roleDiscussed": "specific job role being discussed for Karthik",
  "interactionSummary": "one-line summary of this exchange across all channels",
  "followUpDate": "YYYY-MM-DD — only if Karthik has an UNSATISFIED action to take, otherwise null",
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
