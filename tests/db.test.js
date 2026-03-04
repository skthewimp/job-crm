const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { initDb, insertMessage, getMessagesSince, upsertContact, getContacts, getContactByNameAndCompany } = require('../src/db');

const TEST_DB = './data/test.sqlite';

describe('Database', () => {
  let db;

  before(() => {
    db = initDb(TEST_DB);
  });

  after(() => {
    db.close();
    fs.unlinkSync(TEST_DB);
  });

  it('should insert and retrieve WhatsApp messages', () => {
    insertMessage(db, {
      chatId: 'chat123',
      contactName: 'Jane Doe',
      phone: '+1234567890',
      body: 'Let me follow up next Tuesday',
      timestamp: Date.now(),
      direction: 'incoming',
      source: 'whatsapp'
    });

    const msgs = getMessagesSince(db, 'whatsapp', Date.now() - 86400000);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].contact_name, 'Jane Doe');
  });

  it('should insert and retrieve email messages', () => {
    insertMessage(db, {
      chatId: 'thread_abc',
      contactName: 'John Smith',
      phone: null,
      body: 'I will send you the JD by Friday',
      timestamp: Date.now(),
      direction: 'incoming',
      source: 'gmail'
    });

    const msgs = getMessagesSince(db, 'gmail', Date.now() - 86400000);
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].source, 'gmail');
  });

  it('should upsert contacts without duplicates', () => {
    upsertContact(db, {
      name: 'Jane Doe',
      company: 'Acme Corp',
      role: 'Recruiter',
      relationshipType: 'Recruiter',
      source: 'LinkedIn',
      channel: 'WhatsApp',
      firstContactDate: '2026-03-01',
      lastInteractionDate: '2026-03-04',
      lastInteractionSummary: 'Discussed senior role',
      nextFollowUpDate: '2026-03-10',
      followUpAction: 'Send resume',
      status: 'Active',
      roleDiscussed: 'Senior Engineer'
    });

    // Upsert same contact - should update, not duplicate
    upsertContact(db, {
      name: 'Jane Doe',
      company: 'Acme Corp',
      lastInteractionDate: '2026-03-05',
      lastInteractionSummary: 'Sent resume',
      status: 'Waiting'
    });

    const contact = getContactByNameAndCompany(db, 'Jane Doe', 'Acme Corp');
    assert.strictEqual(contact.status, 'Waiting');
    assert.strictEqual(contact.last_interaction_date, '2026-03-05');
    // Original fields preserved
    assert.strictEqual(contact.role, 'Recruiter');
  });
});
