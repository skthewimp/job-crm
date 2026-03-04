# Job Hunt CRM

Automated CRM for job hunting. Scans Gmail, Google Calendar, and WhatsApp daily to track contacts, extract follow-up commitments, and send a morning summary email.

## How It Works

1. **WhatsApp Collector** runs as a background daemon, storing all messages in a local SQLite database
2. **Daily Scanner** (7 AM) scans Gmail (7-day window), Calendar (3 days ahead), and WhatsApp messages
3. **Claude AI** classifies messages as job-related, then extracts contacts, companies, and follow-up commitments
4. **Google Sheet** is updated with new/updated contacts
5. **Summary email** is sent with today's follow-ups, overdue items, and upcoming events

## Prerequisites

- Node.js 18+
- Google Cloud project with Gmail, Calendar, and Sheets APIs enabled
- Anthropic API key
- WhatsApp account

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd job-crm
npm install
```

### 2. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project, enable Gmail API, Calendar API, and Sheets API
3. Create OAuth2 credentials (Desktop app)
4. Download as `auth/google-credentials.json`

### 3. Environment variables

```bash
cp .env.example .env
# Edit .env with your values
```

### 4. Authenticate with Google

```bash
npm run auth:google
```

### 5. Create Google Sheet

Create a new Google Sheet. Copy its ID from the URL and add to `.env` as `GOOGLE_SHEET_ID`.

### 6. Start WhatsApp collector

```bash
npm run whatsapp
# Scan QR code with your phone
```

### 7. Run daily scan manually (to test)

```bash
npm run scan
```

### 8. Install as background services

```bash
bash scripts/install-launchd.sh
```

## Scripts

- `npm run whatsapp` - Start WhatsApp collector
- `npm run scan` - Run daily scan manually
- `npm run auth:google` - Set up Google OAuth
- `npm test` - Run tests
