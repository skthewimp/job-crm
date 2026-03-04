// src/llm/classifier.js
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const BATCH_SIZE = 20;
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

async function classifyBatch(messages) {
  const numbered = messages.map((msg, i) =>
    `[${i + 1}] ${msg.body.substring(0, 500)}`
  ).join('\n\n');

  const response = await callWithRetry(() => client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Classify each numbered message below as job-related or not. A message is job-related if it involves: job search, career opportunities, recruiting, job applications, professional networking for jobs, interview scheduling, hiring discussions, or follow-ups on job leads.

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
  return results;
}

async function classifyMessages(messages) {
  if (messages.length === 0) return [];

  const jobRelated = [];

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    console.log(`  Classifying batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messages.length / BATCH_SIZE)}...`);
    const hits = await classifyBatch(batch);
    for (const idx of hits) {
      if (batch[idx]) {
        jobRelated.push({ ...batch[idx], isJobRelated: true });
      }
    }
    // Small delay between batches to stay under rate limits
    if (i + BATCH_SIZE < messages.length) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  return jobRelated;
}

module.exports = { classifyMessages };
