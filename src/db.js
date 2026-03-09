const Database = require('better-sqlite3');
const path = require('path');

function initDb(dbPath = './data/crm.sqlite') {
  const dir = path.dirname(dbPath);
  require('fs').mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      contact_name TEXT,
      phone TEXT,
      body TEXT,
      timestamp INTEGER,
      direction TEXT,
      source TEXT,
      classified INTEGER,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_source_ts ON messages(source, timestamp);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(source, timestamp, contact_name);

    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT,
      role TEXT,
      relationship_type TEXT,
      source TEXT,
      channel TEXT,
      first_contact_date TEXT,
      last_interaction_date TEXT,
      last_interaction_summary TEXT,
      next_follow_up_date TEXT,
      follow_up_action TEXT,
      status TEXT DEFAULT 'Active',
      notes TEXT,
      role_discussed TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000),
      UNIQUE(name, company)
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT,
      contact_name TEXT,
      phone TEXT,
      timestamp INTEGER,
      direction TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(timestamp);

    CREATE TABLE IF NOT EXISTS companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL UNIQUE,
      contacts TEXT,
      role_discussed TEXT,
      status TEXT DEFAULT 'Active',
      channel TEXT,
      first_contact_date TEXT,
      last_interaction_date TEXT,
      last_interaction_summary TEXT,
      next_follow_up_date TEXT,
      follow_up_action TEXT,
      notes TEXT,
      created_at INTEGER DEFAULT (unixepoch() * 1000),
      updated_at INTEGER DEFAULT (unixepoch() * 1000)
    );
  `);

  // Migration: add classified column if missing
  const cols = db.prepare("PRAGMA table_info(messages)").all();
  if (!cols.some(c => c.name === 'classified')) {
    db.exec('ALTER TABLE messages ADD COLUMN classified INTEGER');
  }

  // Migration: add dedup index if missing (ignore errors if it already exists)
  try {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(source, timestamp, contact_name)');
  } catch (e) {
    // Index may fail on existing duplicate data - that's ok, new inserts will still dedup
  }

  return db;
}

function insertCall(db, { chatId, contactName, phone, timestamp, direction }) {
  const stmt = db.prepare(`
    INSERT INTO calls (chat_id, contact_name, phone, timestamp, direction)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(chatId, contactName, phone, timestamp, direction);
}

function getCallsSince(db, sinceTimestamp) {
  return db.prepare(`
    SELECT * FROM calls WHERE timestamp >= ? ORDER BY timestamp ASC
  `).all(sinceTimestamp);
}

function insertMessage(db, { chatId, contactName, phone, body, timestamp, direction, source }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages (chat_id, contact_name, phone, body, timestamp, direction, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(chatId, contactName, phone, body, timestamp, direction, source);
}

function getUnclassifiedMessages(db, sinceTimestamp) {
  return db.prepare(`
    SELECT id, body, contact_name, direction, timestamp, source
    FROM messages
    WHERE timestamp >= ? AND classified IS NULL AND body IS NOT NULL
    ORDER BY timestamp ASC
  `).all(sinceTimestamp);
}

function markMessagesClassified(db, ids, isJobRelated) {
  const stmt = db.prepare('UPDATE messages SET classified = ? WHERE id = ?');
  const run = db.transaction((ids, value) => {
    for (const id of ids) {
      stmt.run(value, id);
    }
  });
  run(ids, isJobRelated ? 1 : 0);
}

function getMessagesSince(db, source, sinceTimestamp) {
  return db.prepare(`
    SELECT * FROM messages WHERE source = ? AND timestamp >= ? ORDER BY timestamp ASC
  `).all(source, sinceTimestamp);
}

function upsertCompany(db, data) {
  const company = (data.company || '').trim();
  if (!company) return null;

  const existing = db.prepare('SELECT * FROM companies WHERE company = ?').get(company);

  if (existing) {
    // Merge contact name into existing list
    const existingContacts = (existing.contacts || '').split(',').map(s => s.trim()).filter(Boolean);
    const newName = (data.contactName || '').trim();
    if (newName && !existingContacts.some(n => n.toLowerCase() === newName.toLowerCase())) {
      existingContacts.push(newName);
    }

    const fields = [];
    const values = [];

    fields.push('contacts = ?');
    values.push(existingContacts.join(', '));

    // Only update interaction details if this message is newer than what's stored
    const incomingDate = data.lastInteractionDate || '';
    const storedDate = existing.last_interaction_date || '';
    const isNewer = incomingDate >= storedDate;

    if (isNewer) {
      const updatable = {
        role_discussed: data.roleDiscussed,
        status: data.status,
        channel: data.channel,
        last_interaction_date: data.lastInteractionDate,
        last_interaction_summary: data.interactionSummary,
      };

      for (const [field, val] of Object.entries(updatable)) {
        if (val) {
          fields.push(`${field} = ?`);
          values.push(val);
        }
      }
    }

    // For follow-up: keep the LATEST (most future) follow-up date
    // If incoming has a follow-up date, only overwrite if it's later than existing
    if (data.followUpDate) {
      const existingFollowUp = existing.next_follow_up_date || '';
      if (!existingFollowUp || data.followUpDate > existingFollowUp) {
        fields.push('next_follow_up_date = ?');
        values.push(data.followUpDate);
        fields.push('follow_up_action = ?');
        values.push(data.followUpAction || existing.follow_up_action || '');
      }
    }

    if (data.notes) {
      fields.push('notes = ?');
      values.push(existing.notes ? `${existing.notes}\n${data.notes}`.trim() : data.notes);
    }

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(existing.id);

    db.prepare(`UPDATE companies SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return existing.id;
  } else {
    const stmt = db.prepare(`
      INSERT INTO companies (company, contacts, role_discussed, status, channel,
        first_contact_date, last_interaction_date, last_interaction_summary,
        next_follow_up_date, follow_up_action, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      company,
      data.contactName || null,
      data.roleDiscussed || null,
      data.status || 'Active',
      data.channel || null,
      data.firstContactDate || new Date().toISOString().split('T')[0],
      data.lastInteractionDate || null,
      data.interactionSummary || null,
      data.followUpDate || null,
      data.followUpAction || null,
      data.notes || null
    );
    return result.lastInsertRowid;
  }
}

function getCompaniesDueForFollowUp(db, date) {
  return db.prepare(`
    SELECT * FROM companies
    WHERE next_follow_up_date IS NOT NULL
      AND next_follow_up_date <= ?
      AND status NOT IN ('Closed', 'Offer')
    ORDER BY next_follow_up_date ASC
  `).all(date);
}

// Keep old functions for backward compat during migration
function upsertContact(db, contact) {
  const keyMap = {
    relationshipType: 'relationship_type',
    lastInteractionDate: 'last_interaction_date',
    lastInteractionSummary: 'last_interaction_summary',
    nextFollowUpDate: 'next_follow_up_date',
    followUpAction: 'follow_up_action',
    roleDiscussed: 'role_discussed',
    firstContactDate: 'first_contact_date'
  };

  for (const [jsKey, dbKey] of Object.entries(keyMap)) {
    if (contact[jsKey] !== undefined) {
      contact[dbKey] = contact[jsKey];
    }
  }

  const existing = getContactByNameAndCompany(db, contact.name, contact.company);

  if (existing) {
    const fields = [];
    const values = [];
    const updatable = [
      'role', 'relationship_type', 'source', 'channel',
      'last_interaction_date', 'last_interaction_summary',
      'next_follow_up_date', 'follow_up_action', 'status',
      'notes', 'role_discussed'
    ];

    for (const field of updatable) {
      if (contact[field] !== undefined) {
        fields.push(`${field} = ?`);
        values.push(contact[field]);
      }
    }

    if (fields.length > 0) {
      fields.push('updated_at = ?');
      values.push(Date.now());
      values.push(existing.id);
      db.prepare(`UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }
    return existing.id;
  } else {
    const stmt = db.prepare(`
      INSERT INTO contacts (name, company, role, relationship_type, source, channel,
        first_contact_date, last_interaction_date, last_interaction_summary,
        next_follow_up_date, follow_up_action, status, notes, role_discussed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      contact.name, contact.company || null, contact.role || null,
      contact.relationship_type || null, contact.source || null, contact.channel || null,
      contact.first_contact_date || null, contact.last_interaction_date || null,
      contact.last_interaction_summary || null, contact.next_follow_up_date || null,
      contact.follow_up_action || null, contact.status || 'Active',
      contact.notes || null, contact.role_discussed || null
    );
    return result.lastInsertRowid;
  }
}

function getContactByNameAndCompany(db, name, company) {
  return db.prepare('SELECT * FROM contacts WHERE name = ? AND company = ?').get(name, company || null);
}

function getContacts(db) {
  return db.prepare('SELECT * FROM contacts ORDER BY last_interaction_date DESC').all();
}

function getContactsDueForFollowUp(db, date) {
  return db.prepare(`
    SELECT * FROM contacts
    WHERE next_follow_up_date IS NOT NULL
      AND next_follow_up_date <= ?
      AND status NOT IN ('Closed', 'Offer')
    ORDER BY next_follow_up_date ASC
  `).all(date);
}

module.exports = {
  initDb, insertMessage, getMessagesSince,
  getUnclassifiedMessages, markMessagesClassified,
  insertCall, getCallsSince,
  upsertContact, getContactByNameAndCompany, getContacts, getContactsDueForFollowUp,
  upsertCompany, getCompaniesDueForFollowUp
};
