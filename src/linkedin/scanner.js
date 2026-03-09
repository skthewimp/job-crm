// src/linkedin/scanner.js
const puppeteer = require('puppeteer');
const { getLinkedInCookies } = require('./cookies');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_TIMEOUT = 90000;

async function scanLinkedIn() {
  console.log('  LinkedIn: extracting cookies from Chrome...');
  let cookies;
  try {
    cookies = getLinkedInCookies();
  } catch (err) {
    console.error('  LinkedIn: failed to extract cookies:', err.message);
    return [];
  }

  const liAt = cookies.find(c => c.name === 'li_at');
  if (!liAt || !liAt.value) {
    console.error('  LinkedIn: no valid session cookie found. Log into LinkedIn in Chrome.');
    return [];
  }

  console.log('  LinkedIn: launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    const result = await Promise.race([
      (async () => {
        await page.setCookie(...cookies.map(c => ({
          ...c,
          domain: c.domain || '.linkedin.com'
        })));

        const cutoff = Date.now() - SEVEN_DAYS_MS;
        const seen = new Set();
        const messages = [];
        const urnToName = new Map(); // URN -> display name
        const convParticipants = new Map(); // conversation URN -> [participant URNs]
        let selfUrn = null;
        const pending = [];

        page.on('response', (response) => {
          const url = response.url();
          if (!url.includes('voyagerMessagingGraphQL/graphql') &&
              !url.includes('/messaging/')) return;
          if (response.status() !== 200) return;

          const contentType = response.headers()['content-type'] || '';
          if (!contentType.includes('json') && !contentType.includes('graphql')) return;

          const p = response.text()
            .then(text => {
              const json = JSON.parse(text);
              const data = json.data;
              if (!data) return;

              // Extract participant names from conversations
              if (data.messengerConversationsBySyncToken) {
                extractParticipants(data.messengerConversationsBySyncToken, urnToName, convParticipants);
                // Also extract messages embedded in conversations
                for (const conv of (data.messengerConversationsBySyncToken.elements || [])) {
                  if (conv.messages && conv.messages.elements) {
                    extractMessages(conv.messages.elements, messages, cutoff, seen, urnToName, conv.entityUrn);
                  }
                }
                // Detect self URN from participant list
                if (!selfUrn) {
                  selfUrn = detectSelfUrn(urnToName);
                }
              }

              // Extract messages from direct message responses
              if (data.messengerMessagesBySyncToken) {
                extractMessages(data.messengerMessagesBySyncToken.elements || [], messages, cutoff, seen, urnToName, null);
              }
            })
            .catch(() => {}); // Not all responses are parseable
          pending.push(p);
        });

        console.log('  LinkedIn: loading messages...');
        await page.goto('https://www.linkedin.com/messaging/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });

        const currentUrl = page.url();
        if (currentUrl.includes('/login') || currentUrl.includes('/authwall')) {
          console.error('  LinkedIn: session expired. Log into LinkedIn in Chrome to refresh.');
          return [];
        }

        await loadConversations(page);
        await loadMessageDetails(page);

        // Wait for all intercepted responses to be processed
        await Promise.allSettled(pending);

        // Post-process: set direction and fix contactName for outgoing messages
        if (selfUrn) {
          for (const msg of messages) {
            if (msg._senderUrn === selfUrn) {
              msg.direction = 'outgoing';
              // For outgoing messages, contactName should be the OTHER person
              if (msg._convUrn) {
                const participants = convParticipants.get(msg._convUrn) || [];
                const otherUrn = participants.find(u => u !== selfUrn);
                if (otherUrn && urnToName.has(otherUrn)) {
                  msg.contactName = urnToName.get(otherUrn);
                }
              }
            }
          }
        }

        // Remove internal fields and filter out messages still attributed to self
        const filtered = [];
        for (const msg of messages) {
          delete msg._senderUrn;
          delete msg._convUrn;
          filtered.push(msg);
        }

        console.log(`  LinkedIn: captured ${filtered.length} messages from last 7 days (${urnToName.size} participants mapped)`);
        return filtered;
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('LinkedIn scan timed out after 90s')), SCAN_TIMEOUT)
      )
    ]);
    return result;
  } finally {
    await browser.close();
  }
}

function extractParticipants(conversationsData, urnToName, convParticipants) {
  for (const conv of (conversationsData.elements || [])) {
    const participantUrns = [];
    for (const p of (conv.conversationParticipants || [])) {
      const urn = p.hostIdentityUrn;
      if (!urn) continue;

      participantUrns.push(urn);
      const member = p.participantType && p.participantType.member;
      if (member) {
        const firstName = (member.firstName && member.firstName.text) || '';
        const lastName = (member.lastName && member.lastName.text) || '';
        const name = [firstName, lastName].filter(Boolean).join(' ');
        if (name) {
          urnToName.set(urn, name);
        }
      }
    }
    if (conv.entityUrn) {
      convParticipants.set(conv.entityUrn, participantUrns);
    }
  }
}

function detectSelfUrn(urnToName) {
  // Karthik's URN will be the one matching his name
  for (const [urn, name] of urnToName) {
    const lower = name.toLowerCase();
    if (lower.includes('karthik')) {
      return urn;
    }
  }
  return null;
}

function extractMessages(elements, messages, cutoff, seen, urnToName, convUrn) {
  for (const el of elements) {
    try {
      if (el._type && !el._type.includes('Message')) continue;

      const timestamp = el.deliveredAt || el.createdAt;
      if (!timestamp || timestamp < cutoff) continue;

      // Get message body - LinkedIn GraphQL uses body.text (AttributedText)
      const body = extractMessageBody(el);
      if (!body) continue;

      // Get sender URN
      const senderUrn = (el.actor && el.actor.hostIdentityUrn)
        || (el.sender && el.sender.hostIdentityUrn);
      if (!senderUrn) continue;

      // Resolve sender name from URN map
      const senderName = urnToName.get(senderUrn) || null;
      if (!senderName) continue;

      // Dedup
      const msgKey = `${timestamp}-${senderUrn}`;
      if (seen.has(msgKey)) continue;
      seen.add(msgKey);

      // Get conversation URN from message or from caller
      const msgConvUrn = convUrn
        || (el.conversation && el.conversation.entityUrn)
        || null;

      messages.push({
        body,
        contactName: senderName,
        source: 'linkedin',
        direction: 'incoming', // Will be corrected in post-processing using selfUrn
        messageDate: new Date(timestamp).toISOString(),
        _senderUrn: senderUrn,
        _convUrn: msgConvUrn
      });
    } catch (e) {
      // Skip unparseable elements
    }
  }
}

function extractMessageBody(el) {
  if (!el.body) return null;
  if (typeof el.body === 'string') return el.body;
  if (el.body.text) return el.body.text;
  return null;
}

async function loadConversations(page) {
  const scrollAttempts = 5;
  for (let i = 0; i < scrollAttempts; i++) {
    await page.evaluate(() => {
      const list = document.querySelector('.msg-conversations-container__conversations-list')
        || document.querySelector('[class*="conversations"]')
        || document.querySelector('.scaffold-layout__list');
      if (list) list.scrollTop = list.scrollHeight;
    });
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function loadMessageDetails(page) {
  const threadSelectors = [
    '.msg-conversation-listitem__link',
    '.msg-conversation-card__content--selectable',
    '[class*="conversation-list"] li a'
  ];

  for (const selector of threadSelectors) {
    const threads = await page.$$(selector);
    if (threads.length > 0) {
      for (const thread of threads.slice(0, 20)) {
        try {
          await thread.click();
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          // Thread may have gone stale
        }
      }
      break;
    }
  }
}

module.exports = { scanLinkedIn };
