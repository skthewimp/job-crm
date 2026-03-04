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
      created_at INTEGER DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_source_ts ON messages(source, timestamp);

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
  `);

  return db;
}

function insertMessage(db, { chatId, contactName, phone, body, timestamp, direction, source }) {
  const stmt = db.prepare(`
    INSERT INTO messages (chat_id, contact_name, phone, body, timestamp, direction, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(chatId, contactName, phone, body, timestamp, direction, source);
}

function getMessagesSince(db, source, sinceTimestamp) {
  return db.prepare(`
    SELECT * FROM messages WHERE source = ? AND timestamp >= ? ORDER BY timestamp ASC
  `).all(source, sinceTimestamp);
}

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

  // Map camelCase keys to snake_case
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
  upsertContact, getContactByNameAndCompany, getContacts, getContactsDueForFollowUp
};
