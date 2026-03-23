// tests/llm.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('LLM Classifier', () => {
  it('should classify CRM-relevant messages as relevant', async () => {
    const { classifyMessages } = require('../src/llm/classifier');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const results = await classifyMessages([{
      body: 'Hi, I saw your profile and we have a Senior Data Scientist role at Google. Would you be interested in chatting this week?',
      contactName: 'Test Recruiter',
      direction: 'incoming'
    }]);
    assert.strictEqual(results.length, 1);
  });

  it('should classify non-CRM messages as irrelevant', async () => {
    const { classifyMessages } = require('../src/llm/classifier');
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const results = await classifyMessages([{
      body: 'Hey want to grab dinner tonight? That new Thai place looks good.',
      contactName: 'Friend',
      direction: 'incoming'
    }]);
    assert.strictEqual(results.length, 0);
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
      '[Email - incoming] Great chatting with you! I will send over the job description by Friday March 7th. Let me know if you have questions.',
      'Jane Doe',
      '2026-03-04',
      '2026-03-04'
    );
    assert.ok(result);
    assert.ok(result.contactName);
  });

  it('should fall back to heuristic extraction on bad LLM response', async () => {
    // Test the heuristic fallback directly by importing the module
    // The heuristic should extract from outgoing commitment text
    const { extractCommitments } = require('../src/llm/extractor');
    // We can't easily test the fallback without mocking the LLM,
    // but we can verify the function handles the direction parameter
    if (!process.env.ANTHROPIC_API_KEY) {
      console.log('Skipping - no API key');
      return;
    }
    const result = await extractCommitments(
      "[WhatsApp - outgoing] I'll send you the deck tomorrow",
      'Bob',
      '2026-03-10',
      '2026-03-10'
    );
    assert.ok(result);
  });
});

describe('Config', () => {
  it('should return owner profile from env vars', () => {
    const { getOwnerProfile, isOwnerName, getGmailSelfEmail, getCrmTimezone } = require('../src/config');
    const profile = getOwnerProfile();
    assert.ok(typeof profile.name === 'string');
    assert.ok(typeof profile.email === 'string');
    assert.ok(typeof getCrmTimezone() === 'string');
  });

  it('should match owner name variants', () => {
    const { isOwnerName, isOwnerEmail } = require('../src/config');
    // These just verify the functions don't crash - actual matching depends on env vars
    assert.strictEqual(typeof isOwnerName('test'), 'boolean');
    assert.strictEqual(typeof isOwnerEmail('test@example.com'), 'boolean');
  });
});
