// tests/llm.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('LLM Classifier', () => {
  it('should classify job-hunt messages as relevant', async () => {
    const { classifyMessage } = require('../src/llm/classifier');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await classifyMessage(
      'Hi, I saw your profile and we have a Senior Data Scientist role at Google. Would you be interested in chatting this week?'
    );
    assert.strictEqual(result, true);
  });

  it('should classify non-job messages as irrelevant', async () => {
    const { classifyMessage } = require('../src/llm/classifier');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await classifyMessage(
      'Hey want to grab dinner tonight? That new Thai place looks good.'
    );
    assert.strictEqual(result, false);
  });
});

describe('LLM Extractor', () => {
  it('should extract follow-up commitments', async () => {
    const { extractCommitments } = require('../src/llm/extractor');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await extractCommitments(
      'Great chatting with you! I will send over the job description by Friday March 7th. Let me know if you have questions.',
      'Jane Doe',
      '2026-03-04'
    );
    assert.ok(result.contactName);
    assert.ok(result.followUpDate || result.commitments?.length > 0);
  });
});
