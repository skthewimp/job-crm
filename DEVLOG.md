# Development Log — Job Hunt CRM

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
