function normalizeLower(value) {
  return (value || '').trim().toLowerCase();
}

function getOwnerProfile() {
  const email = (process.env.CRM_OWNER_EMAIL || process.env.GMAIL_SELF_EMAIL || '').trim();
  const name = (process.env.CRM_OWNER_NAME || '').trim();

  return { name, email };
}

function getGmailSelfEmail() {
  return getOwnerProfile().email;
}

function getCrmTimezone() {
  return (process.env.CRM_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').trim();
}

function getOwnerAliases() {
  const { name, email } = getOwnerProfile();
  const aliases = new Set();

  if (name) {
    aliases.add(normalizeLower(name));
    for (const part of name.split(/\s+/)) {
      if (part) aliases.add(normalizeLower(part));
    }
  }

  if (email) {
    aliases.add(normalizeLower(email));
    const localPart = email.split('@')[0];
    if (localPart) aliases.add(normalizeLower(localPart));
  }

  return Array.from(aliases).filter(Boolean);
}

function isOwnerName(value) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;

  return getOwnerAliases().some(alias => normalized.includes(alias));
}

function isOwnerEmail(value) {
  const normalized = normalizeLower(value);
  if (!normalized) return false;

  const { email } = getOwnerProfile();
  const emailLower = normalizeLower(email);
  const localPart = emailLower.split('@')[0];

  return Boolean(
    (emailLower && normalized.includes(emailLower)) ||
    (localPart && normalized.includes(localPart))
  );
}

module.exports = {
  getCrmTimezone,
  getGmailSelfEmail,
  getOwnerAliases,
  getOwnerProfile,
  isOwnerEmail,
  isOwnerName,
};
