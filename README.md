# Personal CRM

Automated CRM that scans Gmail, Google Calendar, LinkedIn, and WhatsApp daily to track contacts, extract follow-up commitments, and send a morning summary email.

## How It Works

1. **WhatsApp Collector** runs on a schedule, fetching recent messages (DMs and optionally group chats)
2. **Daily Scanner** (7 AM) scans Gmail, Calendar (past + upcoming), LinkedIn, and WhatsApp messages
3. **Claude AI** classifies messages as CRM-relevant, then extracts contacts, companies, follow-ups, and waiting states
4. **Regex fallbacks** catch outbound commitments ("I'll send this tomorrow") that the LLM misses
5. **Cross-referencing** clears follow-ups when meetings, calls, or outgoing emails satisfy them
6. **Google Sheet** is updated with new/updated companies
7. **Summary email** is sent with overdue items, today's to-dos, waiting states, upcoming meetings, and recent interactions
8. **Email feedback** — reply to the summary to drop contacts, postpone follow-ups, or update statuses

## Prerequisites

- Node.js 18+
- Google Cloud project with Gmail, Calendar, and Sheets APIs enabled
- Anthropic API key
- WhatsApp account (optional, for WhatsApp scanning)

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd job-crm
npm install
```

### 2. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use an existing one)
3. Enable these APIs: **Gmail API**, **Google Calendar API**, **Google Sheets API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop app** as the application type
6. Download the JSON file and save it as `auth/google-credentials.json`

### 3. Environment variables

```bash
cp .env.example .env
```

Edit `.env` with your values. Required fields:
- `ANTHROPIC_API_KEY` — get one at [console.anthropic.com](https://console.anthropic.com)
- `GOOGLE_SHEET_ID` — create a Google Sheet, copy the ID from its URL (the long string between `/d/` and `/edit`)
- `GMAIL_SELF_EMAIL` — your Gmail address
- `CRM_OWNER_NAME` — your name (used to identify you in messages)

### 4. Authenticate with Google

```bash
npm run auth:google
```

This opens a browser window for OAuth consent. Authorize with the same Google account that owns the Sheet.

### 5. Validate setup

```bash
npm run setup:check
```

This verifies all required config, auth files, and dependencies are in place.

### 6. Run daily scan (test it)

```bash
npm run scan
```

### 7. WhatsApp setup (optional)

```bash
npm run whatsapp
# Scan the QR code with your phone's WhatsApp
```

The first run authenticates via QR code. Subsequent runs use cached auth.

### 8. Install as background services (macOS)

```bash
bash scripts/install-launchd.sh
```

This installs two launchd agents:
- WhatsApp collector at 6:50 AM
- Daily scan at 7:00 AM

## Optional Features

### Multi-Gmail scanning

Scan additional Gmail accounts (read-only):

```bash
# Add to .env:
# GMAIL_EXTRA_ACCOUNTS=personal@gmail.com,work@company.com

# Authorize each account:
npm run auth:gmail-extra -- personal@gmail.com
```

### WhatsApp group scanning

Monitor specific WhatsApp groups for CRM-relevant messages:

```bash
# Add to .env:
# WHATSAPP_SCAN_GROUPS=Startup Founders,College Alumni
```

### WhatsApp batch backfill

Fetch last 24h of DMs + 3 days of group messages in one shot:

```bash
npm run whatsapp:backfill
```

### Debug classifier

See which messages the classifier rejected:

```bash
DEBUG_CLASSIFIER=1 npm run scan
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run scan` | Run daily scan manually |
| `npm run whatsapp` | Start WhatsApp collector |
| `npm run whatsapp:backfill` | Batch fetch recent WhatsApp messages |
| `npm run auth:google` | Set up Google OAuth |
| `npm run auth:gmail-extra -- email` | Authorize an extra Gmail account |
| `npm run setup:check` | Validate configuration |
| `npm test` | Run tests |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `GOOGLE_SHEET_ID` | Yes | Google Sheet ID for CRM data |
| `GMAIL_SELF_EMAIL` | Yes | Your primary Gmail address |
| `CRM_OWNER_NAME` | Recommended | Your name (for message classification) |
| `CRM_OWNER_EMAIL` | Optional | Falls back to GMAIL_SELF_EMAIL |
| `CRM_TIMEZONE` | Optional | Timezone for email timestamps (default: system timezone) |
| `SHEET_TAB` | Optional | Google Sheet tab name (default: CRM) |
| `WHATSAPP_SCAN_GROUPS` | Optional | Comma-separated WhatsApp group names to monitor |
| `GMAIL_EXTRA_ACCOUNTS` | Optional | Comma-separated extra Gmail addresses to scan |
| `DEBUG_CLASSIFIER` | Optional | Set to `1` to log classifier misses |
