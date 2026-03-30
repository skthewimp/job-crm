// src/linkedin/scanner.js
const puppeteer = require('puppeteer');
const { getLinkedInCookies } = require('./cookies');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SCAN_TIMEOUT = 180000;
const MAX_RETRIES = 3;

async function scanLinkedIn() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await scanLinkedInAttempt();
      return result;
    } catch (err) {
      console.error(`  LinkedIn: attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log('  LinkedIn: retrying in 5s...');
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  console.error('  LinkedIn: all retries exhausted, skipping.');
  return [];
}

async function scanLinkedInAttempt() {
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
        const urnToHeadline = new Map(); // URN -> headline/occupation
        const urnToProfileUrl = new Map(); // URN -> profile URL
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
                extractParticipants(data.messengerConversationsBySyncToken, urnToName, urnToHeadline, urnToProfileUrl, convParticipants);
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
          timeout: 60000
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

        // Collect URNs of contacts we need profile info for
        const urnToCompany = new Map(); // URN -> current company name
        const contactUrnsNeedingProfile = new Set();
        for (const msg of messages) {
          let otherUrn = null;
          if (msg._senderUrn === selfUrn) {
            if (msg._convUrn) {
              const participants = convParticipants.get(msg._convUrn) || [];
              otherUrn = participants.find(u => u !== selfUrn);
            }
          } else {
            otherUrn = msg._senderUrn;
          }
          if (otherUrn && urnToProfileUrl.has(otherUrn) && !urnToCompany.has(otherUrn)) {
            contactUrnsNeedingProfile.add(otherUrn);
          }
        }

        // Visit profiles to scrape headline and current company
        if (contactUrnsNeedingProfile.size > 0) {
          console.log(`  LinkedIn: visiting ${contactUrnsNeedingProfile.size} profile(s) for company info...`);
          for (const urn of contactUrnsNeedingProfile) {
            const profileUrl = urnToProfileUrl.get(urn);
            if (!profileUrl) continue;
            try {
              await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
              const profileData = await page.evaluate(() => {
                // Scrape headline
                const headlineEl = document.querySelector('.text-body-medium.break-words')
                  || document.querySelector('[data-generated-suggestion-target]')
                  || document.querySelector('.pv-top-card--list .text-body-medium');
                const headline = headlineEl ? headlineEl.textContent.trim() : null;

                // Scrape current company from the top card "experience" line
                // LinkedIn shows "Company Name" in the top card under the headline
                let company = null;

                // Method 1: Top card experience section (most reliable)
                const expButton = document.querySelector('button[aria-label*="Current company"]')
                  || document.querySelector('button[aria-label*="current company"]');
                if (expButton) {
                  company = expButton.textContent.trim().split('\n')[0].trim();
                }

                // Method 2: Look for the experience list item with "Present" in duration
                if (!company) {
                  const expItems = document.querySelectorAll('.pvs-list__paged-list-item, li.artdeco-list__item');
                  for (const item of expItems) {
                    const text = item.textContent || '';
                    if (text.includes('Present') || text.includes('present')) {
                      // The company name is typically in a span with specific classes
                      const spans = item.querySelectorAll('span[aria-hidden="true"]');
                      for (const span of spans) {
                        const t = span.textContent.trim();
                        // Company names are usually short and don't contain date patterns
                        if (t && t.length > 1 && t.length < 80 && !/\d{4}/.test(t) && !/^\d+/.test(t)) {
                          company = t;
                          break;
                        }
                      }
                      if (company) break;
                    }
                  }
                }

                // Method 3: Top card company link
                if (!company) {
                  const companyLink = document.querySelector('a[href*="/company/"] .text-body-small')
                    || document.querySelector('.pv-top-card--experience-list-item .text-body-small');
                  if (companyLink) {
                    company = companyLink.textContent.trim();
                  }
                }

                return { headline, company };
              });

              if (profileData.headline && !urnToHeadline.has(urn)) {
                urnToHeadline.set(urn, profileData.headline);
              }
              if (profileData.company) {
                urnToCompany.set(urn, profileData.company);
              }
            } catch (e) {
              // Profile visit failed, skip
            }
          }
          console.log(`  LinkedIn: scraped ${urnToCompany.size} company names from profiles`);
        }

        // Attach headline to messages as linkedinHeadline
        const filtered = [];
        for (const msg of messages) {
          // Find the OTHER person's URN for this message
          let otherUrn = null;
          if (msg._convUrn) {
            const participants = convParticipants.get(msg._convUrn) || [];
            otherUrn = participants.find(u => u !== selfUrn);
          }
          if (!otherUrn && msg._senderUrn !== selfUrn) {
            otherUrn = msg._senderUrn;
          }

          if (otherUrn && urnToHeadline.has(otherUrn)) {
            msg.linkedinHeadline = urnToHeadline.get(otherUrn);
          }
          if (otherUrn && urnToCompany.has(otherUrn)) {
            msg.linkedinCompany = urnToCompany.get(otherUrn);
          }

          delete msg._senderUrn;
          delete msg._convUrn;
          filtered.push(msg);
        }

        console.log(`  LinkedIn: captured ${filtered.length} messages from last 7 days (${urnToName.size} participants, ${urnToHeadline.size} with headlines)`);
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

function extractParticipants(conversationsData, urnToName, urnToHeadline, urnToProfileUrl, convParticipants) {
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

        // Extract headline/occupation - LinkedIn includes this in participant data
        const headline = (member.headline && member.headline.text)
          || (member.occupation)
          || null;
        if (headline) {
          urnToHeadline.set(urn, headline);
        }

        // Extract profile URL if available
        const profileUrl = member.publicIdentifier
          ? `https://www.linkedin.com/in/${member.publicIdentifier}`
          : null;
        if (profileUrl) {
          urnToProfileUrl.set(urn, profileUrl);
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
