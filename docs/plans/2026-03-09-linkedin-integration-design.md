# LinkedIn DM Integration - Design

## Goal

Add LinkedIn DMs/InMail to the job CRM's daily scan pipeline, alongside Gmail, WhatsApp, and Calendar.

## Approach: Puppeteer + Cookie Extraction + Network Interception

### LinkedIn Scanner (`src/linkedin/scanner.js`)

A Puppeteer-based scanner called directly by `daily-scan.js`. No browser extension, no daemon, no manual exports.

**Flow:**

1. Copy LinkedIn session cookies (`li_at`, `JSESSIONID`) from Chrome's cookie SQLite DB (`~/Library/Application Support/Google/Chrome/Default/Cookies`)
2. Launch headless Chrome with a temporary profile
3. Inject cookies via `page.setCookie()`
4. Set up `page.on('response')` to intercept LinkedIn's internal messaging API (`voyager/api/messaging/*`)
5. Navigate to `linkedin.com/messaging/`
6. Scroll/paginate to load conversations from the last 7 days
7. Parse intercepted JSON responses - extract message body, sender name, timestamp, direction
8. Close browser, return normalized message array

**Output format** (matches other scanners):

```js
[{
  body: "Hi Karthik, we'd love to schedule...",
  contactName: "Jane Doe",
  source: "linkedin",
  direction: "incoming",
  messageDate: "2026-03-05T14:30:00Z"
}]
```

### Integration with Daily Scan

- Add `scanLinkedIn()` to the existing `Promise.all()` in `daily-scan.js`
- Messages flow through the unchanged pipeline: classify (Haiku) -> extract (Sonnet) -> upsert companies
- Stored in existing `messages` table with `source: "linkedin"`
- No new tables, no schema changes

### Cookie Extraction

- Chrome stores cookies in SQLite at `~/Library/Application Support/Google/Chrome/Default/Cookies`
- Scanner reads `.linkedin.com` cookies (specifically `li_at` and `JSESSIONID`)
- LinkedIn session cookies last several months
- If session expires, scanner logs a warning and returns empty array (other sources continue)
- Re-login to LinkedIn in Chrome refreshes the session

### Why This Approach

- **No Chrome extension needed** - Puppeteer is already a dependency pattern (WhatsApp uses whatsapp-web.js)
- **No file handoff** - scanner returns data directly, same as Gmail and WhatsApp scanners
- **No auth flow** - piggybacks on existing Chrome session
- **No new daemon** - runs once daily as part of the scan
- **Chrome can stay open** - cookie copying avoids profile locking conflicts
- **Network interception over DOM scraping** - LinkedIn's API JSON is structured and more stable than DOM selectors

### Failure Modes

- **Expired session:** Scanner returns empty array, logs warning. Fix: log into LinkedIn in Chrome.
- **LinkedIn changes API endpoints:** Scanner returns empty array, logs error. Fix: update endpoint patterns.
- **Chrome cookie DB locked:** Uses a read-only copy. Should not conflict with running Chrome.
- **No messages in 7-day window:** Returns empty array. Normal operation.

### Scope

- **New file:** `src/linkedin/scanner.js`
- **Modified file:** `src/daily-scan.js` (add LinkedIn to scan phase)
- **No changes to:** classifier, extractor, db schema, sheets updater, emailer
