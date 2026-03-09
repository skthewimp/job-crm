// src/linkedin/cookies.js
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_COOKIES_PATH = path.join(
  os.homedir(),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

function getChromeDecryptionKey() {
  const rawKey = execSync(
    'security find-generic-password -s "Chrome Safe Storage" -w',
    { encoding: 'utf8' }
  ).trim();
  return crypto.pbkdf2Sync(rawKey, 'saltysalt', 1003, 16, 'sha1');
}

function decryptValue(encryptedValue, key) {
  if (!encryptedValue || encryptedValue.length === 0) return '';
  const prefix = encryptedValue.slice(0, 3).toString('utf8');
  if (prefix !== 'v10') {
    return encryptedValue.toString('utf8');
  }
  const iv = Buffer.alloc(16, ' ');
  const data = encryptedValue.slice(3);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  let decrypted = decipher.update(data);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString('utf8');
}

function getLinkedInCookies() {
  if (!fs.existsSync(CHROME_COOKIES_PATH)) {
    throw new Error(`Chrome cookies DB not found at ${CHROME_COOKIES_PATH}. Is Chrome installed?`);
  }

  const tmpPath = path.join(os.tmpdir(), `chrome-cookies-${Date.now()}.sqlite`);
  fs.copyFileSync(CHROME_COOKIES_PATH, tmpPath);

  try {
    const key = getChromeDecryptionKey();
    const db = new Database(tmpPath, { readonly: true });

    const rows = db.prepare(
      `SELECT name, encrypted_value, host_key, path, is_secure, is_httponly
       FROM cookies
       WHERE host_key LIKE '%linkedin.com%'
         AND name IN ('li_at', 'JSESSIONID', 'li_rm')`
    ).all();

    db.close();

    return rows.map(row => ({
      name: row.name,
      value: decryptValue(row.encrypted_value, key),
      domain: row.host_key.startsWith('.') ? row.host_key : `.${row.host_key}`,
      path: row.path,
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
    }));
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

module.exports = { getLinkedInCookies };
