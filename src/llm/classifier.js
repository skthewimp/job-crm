// src/llm/classifier.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

async function classifyMessage(messageText) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: `Classify whether this message is related to a job search, career opportunity, recruiting, job application, professional networking for jobs, or interview scheduling. Reply with ONLY "yes" or "no".

Message: "${messageText}"`
    }]
  });

  const answer = response.content[0].text.trim().toLowerCase();
  return answer === 'yes';
}

async function classifyMessages(messages) {
  const results = [];
  // Process in batches of 5 to avoid rate limits
  for (let i = 0; i < messages.length; i += 5) {
    const batch = messages.slice(i, i + 5);
    const classified = await Promise.all(
      batch.map(async (msg) => ({
        ...msg,
        isJobRelated: await classifyMessage(msg.body)
      }))
    );
    results.push(...classified);
  }
  return results.filter(msg => msg.isJobRelated);
}

module.exports = { classifyMessage, classifyMessages };
