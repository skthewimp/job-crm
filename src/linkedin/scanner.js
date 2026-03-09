// src/linkedin/scanner.js
const puppeteer = require('puppeteer');
const { getLinkedInCookies } = require('./cookies');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

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

    await page.setCookie(...cookies.map(c => ({
      ...c,
      domain: c.domain || '.linkedin.com'
    })));

    const messages = [];
    const cutoff = Date.now() - SEVEN_DAYS_MS;

    page.on('response', async (response) => {
      const url = response.url();
      if (!url.includes('/messaging/') || response.status() !== 200) return;

      try {
        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('json')) return;

        const json = await response.json();
        extractMessagesFromResponse(json, messages, cutoff);
      } catch (e) {
        // Not all responses are parseable
      }
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

    console.log(`  LinkedIn: captured ${messages.length} messages from last 7 days`);
    return messages;
  } finally {
    await browser.close();
  }
}

function extractMessagesFromResponse(json, messages, cutoff) {
  const elements = findElements(json);

  for (const el of elements) {
    try {
      const timestamp = el.deliveredAt || el.createdAt || el.lastActivityAt;
      if (!timestamp || timestamp < cutoff) continue;

      const body = extractMessageBody(el);
      if (!body) continue;

      const sender = extractSenderName(el);
      if (!sender) continue;

      const isSelf = isSelfMessage(el);

      messages.push({
        body,
        contactName: sender,
        source: 'linkedin',
        direction: isSelf ? 'outgoing' : 'incoming',
        messageDate: new Date(timestamp).toISOString()
      });
    } catch (e) {
      // Skip unparseable elements
    }
  }
}

function findElements(obj) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findElements(item));
    }
  } else {
    if (obj.deliveredAt || obj.createdAt || obj.body || obj.eventContent) {
      results.push(obj);
    }
    for (const key of ['elements', 'events', 'results', 'included', 'data']) {
      if (obj[key]) {
        results.push(...findElements(obj[key]));
      }
    }
  }
  return results;
}

function extractMessageBody(el) {
  if (typeof el.body === 'string') return el.body;
  if (el.body?.text) return el.body.text;
  if (el.eventContent?.messageEvent?.body) return el.eventContent.messageEvent.body;
  if (el.eventContent?.messageEvent?.attributedBody?.text) {
    return el.eventContent.messageEvent.attributedBody.text;
  }
  return null;
}

function extractSenderName(el) {
  const participant = el.from || el.sender || el.actor;
  if (!participant) {
    const member = el.from?.['com.linkedin.voyager.messaging.MessagingMember']
      || el.from?.messagingMember;
    if (member?.miniProfile) {
      const p = member.miniProfile;
      return [p.firstName, p.lastName].filter(Boolean).join(' ');
    }
    return null;
  }

  if (typeof participant === 'string') return null;

  if (participant.firstName || participant.lastName) {
    return [participant.firstName, participant.lastName].filter(Boolean).join(' ');
  }

  if (participant.miniProfile) {
    const p = participant.miniProfile;
    return [p.firstName, p.lastName].filter(Boolean).join(' ');
  }

  if (participant.messagingMember?.miniProfile) {
    const p = participant.messagingMember.miniProfile;
    return [p.firstName, p.lastName].filter(Boolean).join(' ');
  }

  return participant.name || null;
}

function isSelfMessage(el) {
  const participant = el.from || el.sender || el.actor;
  if (!participant) return false;
  return false; // Conservative default - will be refined during testing
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
