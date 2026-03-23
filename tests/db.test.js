const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const {
  initDb, insertMessage, getMessagesSince,
  upsertContact, getContacts, getContactByNameAndCompany,
  insertCall, getCallsSince,
  upsertCompany, getCompaniesDueForFollowUp,
  getUnclassifiedMessages, markMessagesClassified
} = require('../src/db');

const TEST_DB = './data/test.sqlite';

describe('Database', () => {
  let db;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = initDb(TEST_DB);
  });

  after(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
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

  it('should deduplicate messages on insert', () => {
    const ts = Date.now() - 50000;
    insertMessage(db, {
      chatId: 'dedup_chat',
      contactName: 'Dedup Test',
      phone: null,
      body: 'Hello',
      timestamp: ts,
      direction: 'incoming',
      source: 'gmail'
    });

    // Insert same message again
    const result = insertMessage(db, {
      chatId: 'dedup_chat',
      contactName: 'Dedup Test',
      phone: null,
      body: 'Hello',
      timestamp: ts,
      direction: 'incoming',
      source: 'gmail'
    });

    assert.strictEqual(result.changes, 0);
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
    assert.ok(msgs.length >= 1);
    assert.ok(msgs.some(m => m.contact_name === 'John Smith'));
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

    // Upsert same contact with newer data - should update, not duplicate
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

  it('should handle NULL company in contact lookup', () => {
    upsertContact(db, {
      name: 'No Company Person',
      company: null,
      lastInteractionDate: '2026-03-04',
      status: 'Active'
    });

    const contact = getContactByNameAndCompany(db, 'No Company Person', null);
    assert.ok(contact);
    assert.strictEqual(contact.name, 'No Company Person');
    assert.strictEqual(contact.company, null);
  });

  it('should only update contact if newer', () => {
    upsertContact(db, {
      name: 'Fresh Contact',
      company: 'FreshCo',
      lastInteractionDate: '2026-03-10',
      lastInteractionSummary: 'Latest call',
      status: 'Active'
    });

    // Try to update with OLDER data — should NOT overwrite
    upsertContact(db, {
      name: 'Fresh Contact',
      company: 'FreshCo',
      lastInteractionDate: '2026-03-01',
      lastInteractionSummary: 'Old email',
      status: 'Waiting'
    });

    const contact = getContactByNameAndCompany(db, 'Fresh Contact', 'FreshCo');
    assert.strictEqual(contact.last_interaction_summary, 'Latest call');
    assert.strictEqual(contact.status, 'Active');
  });

  it('should insert and retrieve calls', () => {
    const ts = Date.now();
    insertCall(db, {
      chatId: 'call_chat',
      contactName: 'Call Person',
      phone: '+9876543210',
      timestamp: ts,
      direction: 'incoming'
    });

    const calls = getCallsSince(db, ts - 1000);
    assert.ok(calls.length >= 1);
    assert.ok(calls.some(c => c.contact_name === 'Call Person'));
  });

  it('should upsert companies and track follow-ups', () => {
    upsertCompany(db, {
      company: 'TestCorp',
      contactName: 'Alice',
      status: 'Active',
      lastInteractionDate: '2026-03-10',
      interactionSummary: 'Intro call',
      followUpDate: '2026-03-15',
      followUpAction: 'Send proposal'
    });

    const due = getCompaniesDueForFollowUp(db, '2026-03-15');
    assert.ok(due.some(c => c.company === 'TestCorp'));
  });

  it('should track and return unclassified messages', () => {
    const ts = Date.now() - 1000;
    insertMessage(db, {
      chatId: 'unclass_chat',
      contactName: 'Unclassified Person',
      phone: null,
      body: 'Some new message',
      timestamp: ts,
      direction: 'incoming',
      source: 'whatsapp'
    });

    const unclassified = getUnclassifiedMessages(db, ts - 1);
    assert.ok(unclassified.some(m => m.contact_name === 'Unclassified Person'));

    // Mark as classified
    const ids = unclassified.filter(m => m.contact_name === 'Unclassified Person').map(m => m.id);
    markMessagesClassified(db, ids, true);

    // Should no longer appear as unclassified
    const after = getUnclassifiedMessages(db, ts - 1);
    assert.ok(!after.some(m => m.contact_name === 'Unclassified Person'));
  });
});
