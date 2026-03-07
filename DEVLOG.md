# Development Log — Job Hunt CRM

---

## 2026-03-07 — WhatsApp call tracking, calendar cross-referencing, company-level CRM

### User prompts this session

> "What model is this using right now? I want this to use either [Haiku] or Sonnet 4.6."
>
> "ok now rerun today's"
>
> "Right now, this is a bit useless. There's way too much information in the sheets and the email and all that. What I really want is, in the daily email, I want a list of to-do's for today [...] Then, in the sheet, in the Google Sheet, all I need is one roster company, not multiple roster company."
>
> "Okay, several problems with today's email. That connect for call at 8:30 and stuff is from 3 days ago, and we already had that call. You could have seen that call in my calendar."
>
> "And this also means that there will be some old emails where I would have said, 'Hey, I will ping you next week' [...] this Monday it should be popping up in my alerts"
>
> "The other thing is that if I have already followed up on something, you don't need to follow up. Let's say somebody says, 'Let's talk tomorrow.' Now, based on the data sources that you are using, you have absolutely no clue whether we have spoken or not."
>
> "There is another problem with the WhatsApp thing. Sometimes I would have said, 'Can you help me with something?' and you will interpret it as the other person has asked me"
>
> "Can you make it better by also cross-referencing any WhatsApp calls that have been made or received?"

### What changed

**Model upgrade to Sonnet 4.6** — Updated `src/llm/extractor.js` from `claude-sonnet-4-20250514` to `claude-sonnet-4-6`. The date-suffixed IDs (`claude-sonnet-4-6-20250514`) return 404; the correct ID has no suffix. SDK was already at v0.78.0.

**Company-level CRM** — Rewrote from one-row-per-contact to one-row-per-company. Added `companies` table in `src/db.js` with `upsertCompany` (merges contacts into comma-separated list, "latest wins" for interaction details, keeps most-future follow-up date). `src/sheets/updater.js` now has 11 columns keyed by company name. Built `scripts/migrate-to-companies.js` for one-time migration from contacts table.

**Simplified daily email** — `src/summary/emailer.js` now sends just a to-do list: overdue follow-ups, today's follow-ups, and upcoming calendar meetings. Subject: "Job Hunt: N to-dos for YYYY-MM-DD". Format: action-first (`**Send resume to [person]** - Company (contacts)`).

**Date resolution fix** — Relative dates in messages ("let's talk tomorrow", "ping you Monday") were resolving against today instead of the message date. Fixed by passing `messageDate` through the entire pipeline to the extractor, which now resolves all relative dates against the message timestamp.

**Follow-up date preservation** — Past follow-up dates are now kept as overdue reminders instead of being nulled out. The DB and Sheet upsert logic only overwrites follow-up dates if the new date is later than the existing one.

**Actionable follow-ups only** — Rewrote extractor prompt to only create follow-ups for things [user] committed to doing (sending resumes, following up, etc.). Meeting proposals ("let's talk tomorrow") are excluded since we can't verify if they happened.

**Message direction/sender attribution** — Added `direction` (incoming/outgoing) to the extraction pipeline. The extractor prompt now has a WHO IS WHO section that explicitly states who sent the message, fixing misattribution of outgoing messages.

**Calendar cross-referencing** — Added `scanPastEvents(daysBack=7)` to `src/calendar/scanner.js`. `daily-scan.js` now cross-references calendar attendees (past events + today's events) against company contacts and automatically clears follow-ups when meetings have occurred or are scheduled today.

**WhatsApp call tracking** — Added `calls` table in `src/db.js` with `insertCall` and `getCallsSince`. Updated `src/whatsapp/collector.js` to capture `call_log` message types and real-time `call` events. Updated `scripts/backfill-whatsapp.js` to capture historical call records (uses `chat.name` directly since `getContact()` fails for call_log messages). `daily-scan.js` now cross-references WhatsApp calls in addition to calendar events to clear follow-ups.

### Key bugs fixed

- **`getContact()` crashes on call_log messages** — Returns undefined `_serialized`. Fixed by using `chat.name` directly for call_log types.
- **Backfill error handling** — One failed `getContact()` call would skip the entire chat. Wrapped individual message processing in try/catch so one bad message doesn't lose the rest.
- **Calendar date comparison** — `eventDate >= followUpDate` meant a March 5 meeting couldn't clear a March 9 follow-up. Removed the date comparison entirely - any meeting with the company clears the follow-up.
- **Today's events ignored** — `if (!a.isPast) continue` skipped today's upcoming meetings. Added `|| a.eventDate === today`.
- **Duplicate company entries** — LLM extracted "kaigentic.com" and "kAIgentic" as separate companies. Manually deduped.

### Files modified

| File | Change |
|------|--------|
| `src/db.js` | Added `calls` table, `companies` table, `insertCall`, `getCallsSince`, `upsertCompany`, `getCompaniesDueForFollowUp` |
| `src/llm/extractor.js` | Sonnet 4.6, messageDate param, direction awareness, follow-up rules |
| `src/daily-scan.js` | Calendar + WhatsApp call cross-referencing, company-level upserts |
| `src/sheets/updater.js` | Company-level (11 columns), contact merging |
| `src/summary/emailer.js` | Simplified to-do list format |
| `src/calendar/scanner.js` | Added `scanPastEvents()` |
| `src/whatsapp/collector.js` | `call_log` + `call` event capture, group chat filtering |
| `scripts/backfill-whatsapp.js` | Call capture, per-message error handling |
| `scripts/migrate-to-companies.js` | One-time contacts→companies migration |

---

## 2026-03-04 — WhatsApp backfill and group chat filtering

### User prompts this session

> "i think i've done that. can you check? and also do a test run with whatsapp. based on last 3 weeks of messages, tell me about any pending followups etc. in the email. this is just a one time exercise"
>
> "ok i need you to ignore group chats on whatsapp."
>
> "update repo etc."

### What changed

**WhatsApp 3-week backfill** — The live collector only captures messages from when it starts. Built a one-time `scripts/backfill-whatsapp.js` that stops the daemon, connects with the same auth session, calls `chat.fetchMessages({ limit: 500 })` on all 975 chats, stores everything from the last 21 days, then restarts the daemon. Pulled 2,291 messages.

**Group chat filtering** — Group chats added massive noise (2,069 of 2,803 WhatsApp messages were from groups). Added `if (chat.isGroup) return` to the collector's `message_create` handler, and `if (chat.isGroup) continue` to the backfill script's chat loop. Purged existing group messages from SQLite (`DELETE WHERE chat_id LIKE '%@g.us'`). 734 individual messages remained.

**Backfill processing results** — Ran the full classify→extract→CRM pipeline on 3 weeks of WhatsApp messages. 3,113 messages classified in 156 batches (Haiku), 221 flagged as job-related, all extracted by Sonnet. Added 87 new contacts and updated 85 existing ones. 42 self-references filtered out. Hit Sheets API read quota on a few upserts (SQLite had everything; daily scan will catch the Sheet gaps).

**Follow-up report email** — Sent a one-time backfill report: 190 total contacts (13 email + 177 WhatsApp), 2 overdue, 4 due today, 13 upcoming follow-ups.

### Scripts added

| Script | Purpose |
|--------|---------|
| `scripts/backfill-whatsapp.js` | One-time: fetch 3 weeks of WhatsApp history into SQLite |
| `scripts/whatsapp-followup-report.js` | One-time: classify + extract + CRM update + email report |
| `scripts/send-wa-report.js` | One-time: send follow-up report from existing DB data |

---

## 2026-03-04 — Setup, debugging, and first successful run

### User prompts this session (continued)

> "ok i need you to help me with all this"
>
> "i've named the app as 'Daily CRM'. the json is at ~/Downloads/client_secret*"
>
> "[gmail address and Google Sheet URL shared]"
>
> "don't write into this. write into a new tab"
>
> "a few things - we have multiple lines here by company. almost like the DB was dumped there. also my name appears twice"
>
> "ok let's do whatsapp"

### What changed

**Google OAuth auth flow** - The credentials JSON had `http://localhost` as redirect URI (port 80), but our server was on port 3000, and port 80 requires sudo. Fixed by using a dynamic port - the server listens on port 0 (OS picks a free port), then uses that port in the OAuth redirect URI. Desktop app credentials allow any `localhost:PORT` redirect.

**Batch classification** - The original classifier made one API call per email (100 emails = 100 calls). Hit the 50 req/min rate limit on Tier 1. Fixed by batching 20 messages into a single API call with numbered responses. 100 emails now takes 5 API calls instead of 100.

**Self-filtering** - The LLM extractor was returning [name]'s own name as a contact (from outgoing emails). Two fixes: (1) updated the extractor prompt to explicitly say "extract info about the OTHER person, not [name]", and (2) added a name-based filter in the orchestrator to skip any contacts matching the user's name.

**Sheet tab name** - The user's Google Sheet had tabs named "2026", "2020", etc. - no "Sheet1". Added `SHEET_TAB` env var (defaults to "CRM"), and `initSheet` now auto-creates the tab if it doesn't exist via the Sheets batchUpdate API.

**Node path for Apple Silicon** - launchd plists had `/usr/local/bin/node` but Homebrew on Apple Silicon installs to `/opt/homebrew/bin/node`.

**Model ID** - `claude-sonnet-4-6-20250514` doesn't exist on the API. Fixed to `claude-sonnet-4-20250514`.

### First successful run results

- 100 emails scanned (7-day window)
- 26 classified as job-related by Haiku
- 12 unique contacts extracted and added to CRM sheet
- Daily summary email sent successfully
- Total runtime: ~3 minutes
- WhatsApp collector connected and capturing messages

---

## 2026-03-04 — Initial build

### User prompts this session

> "I need to build a CRM for my ongoing job hunt. I have lots of conversations with people, and I'll say that I'll follow up on this day or that day and things like that. Now, a lot of these conversations are on emails; some are on text (very few). A lot of them are also on WhatsApp. How do I sort of build this CRM to automate? Maybe it should be a daily script that runs to look through emails, calendar, and WhatsApp and all that to tell me what I need to follow up on that particular day at the start."
>
> "For the WhatsApp bit, use the ideas in this repo: https://github.com/fahadhasin/whatsapp-crm ; I have a Google Sheet where the CRM needs to be updated, along with a daily email on the to dos for the day."

Design choices made via Q&A:
- WhatsApp: whatsapp-web.js server (always-on, real-time capture) over manual export
- Email scope: All emails, AI filters (scan everything, let Claude classify)
- Google Sheet: Design schema from scratch (14 columns)
- LLM: Claude API (Haiku for classification, Sonnet for extraction)
- Daily email: Via Gmail API (same credentials as scanning)
- Hosting: This Mac via launchd
- Stack: All Node.js (since whatsapp-web.js is Node-only)

### What was built

**Architecture:** Monolith Node.js project with two entry points:
1. WhatsApp collector daemon (persistent, via launchd KeepAlive)
2. Daily scanner cron job (7 AM, via launchd StartCalendarInterval)

**Components (10 source files):**

| File | Purpose |
|------|---------|
| `src/db.js` | SQLite layer — messages + contacts tables, upsert logic |
| `src/google-auth.js` | Shared Google OAuth2 client (Gmail, Calendar, Sheets scopes) |
| `src/whatsapp/collector.js` | whatsapp-web.js daemon with LocalAuth, stores all messages |
| `src/llm/classifier.js` | Claude Haiku binary classifier ("is this job-related?") |
| `src/llm/extractor.js` | Claude Sonnet structured data extractor (contacts, commitments, dates) |
| `src/gmail/scanner.js` | Gmail API — fetches last 7 days, extracts body from multipart |
| `src/calendar/scanner.js` | Google Calendar API — fetches next 3 days of events |
| `src/sheets/updater.js` | Google Sheets API — upserts rows matching on name + company |
| `src/summary/emailer.js` | Builds and sends HTML daily summary email via Gmail |
| `src/daily-scan.js` | Orchestrator — ties all modules together in the daily pipeline |

**Pipeline flow:** Gmail + Calendar + WhatsApp scanned in parallel -> Haiku classifies all messages -> Sonnet extracts structured data from job-related ones -> upsert into SQLite + Google Sheet -> send daily summary email.

**Google Sheet schema:** 14 columns — Contact Name, Company, Role/Title, Relationship Type, Source, Channel, First Contact Date, Last Interaction Date, Last Interaction Summary, Next Follow-up Date, Follow-up Action, Status, Notes, Role Discussed.

### Decisions rejected

- **Microservices architecture** — overkill for a personal tool. One project, two entry points is simpler.
- **Manual WhatsApp export** — too much friction for daily use. whatsapp-web.js is more automated.
- **Local Ollama for LLM** — Claude API is faster, more accurate, and the user already has an Anthropic key. Cost is under $5/month.
- **Python stack** — would've required two languages anyway (whatsapp-web.js is Node-only). All-Node keeps it simple.
- **Specific Gmail label filtering** — AI classification is more flexible. No manual labeling required.

### Technical choices

**Two-stage LLM pipeline.** Haiku ($0.25/1M input) for binary classification keeps costs low on high-volume message scanning. Only job-related messages (typically 5-15% of total) go to Sonnet ($3/1M input) for expensive structured extraction. This keeps daily cost under $0.50 even with 100+ messages.

**SQLite with WAL mode.** The WhatsApp daemon and daily scanner both write to the same DB. WAL (Write-Ahead Logging) allows concurrent reads during writes without blocking.

**Contact upsert on (name, company).** Fuzzy matching would be better (people's names vary across email/WhatsApp) but exact match is good enough for v1. The upsert preserves existing fields — only non-null incoming fields overwrite.

**launchd over cron.** macOS-native, supports KeepAlive for the daemon, and runs missed jobs when the Mac wakes from sleep (cron doesn't).
