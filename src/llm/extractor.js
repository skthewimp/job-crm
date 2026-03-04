// src/llm/extractor.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function extractCommitments(messageText, contactName, todayDate) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this job-hunt related message and extract structured data. Today's date is ${todayDate}.

Message from/about: ${contactName}
Message: "${messageText}"

Return a JSON object with these fields (use null if not found):
{
  "contactName": "name of the person",
  "company": "their company",
  "roleTitle": "their job title/role",
  "relationshipType": "Recruiter | Hiring Manager | Referral | Network contact",
  "roleDiscussed": "specific job role being discussed",
  "interactionSummary": "one-line summary of this exchange",
  "followUpDate": "YYYY-MM-DD if a specific follow-up date is mentioned or implied",
  "followUpAction": "what needs to be done by the follow-up date",
  "status": "Active | Waiting | Interview Scheduled"
}

Return ONLY the JSON, no other text.`
    }]
  });

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
