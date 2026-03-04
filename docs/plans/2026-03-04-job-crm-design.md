# Job Hunt CRM - Design Doc

**Date:** 2026-03-04
**Status:** Approved

## Problem

Track job hunt conversations across email, WhatsApp, and calendar. Automate follow-up detection and surface daily to-dos via email. Maintain a Google Sheet as the CRM.

## Architecture

Monolith Node.js project with two entry points:

1. **WhatsApp collector** - persistent daemon via macOS launchd
2. **Daily scanner** - cron job (launchd) running at 7 AM

Both share a common codebase and local SQLite database.

## Components

### 1. WhatsApp Collector (daemon)

- `whatsapp-web.js` maintains a WhatsApp Web session
- Stores messages in local SQLite: `messages` table (id, chat_id, contact_name, phone, message_body, timestamp, direction)
- Runs via macOS launchd as a background service
- First run authenticates via QR code scan

### 2. Daily Scanner (cron, 7 AM)

Scans three sources in parallel:

**Gmail:**
- Gmail API fetches emails from last 7 days (rolling window)
- Claude Haiku: binary classification ("job-hunt related?")
- Claude Sonnet: extract contact name, company, role, commitments/follow-ups with dates, relationship type

**Google Calendar:**
- Calendar API fetches today + next 3 days
- Haiku classifies job-related events
- Flags interviews, coffee chats, networking calls

**WhatsApp:**
- Queries local SQLite for messages from last 7 days
- Same two-stage LLM pipeline (Haiku classify, Sonnet extract)

### 3. CRM Updater

- Upserts extracted data into Google Sheet via Sheets API
- Fuzzy match on contact name + company to avoid duplicates
- Updates: last interaction date, next follow-up, status changes

### 4. Daily Email Summary

Sent via Gmail API to self, contains:
- Today's follow-ups (commitments due today)
- Overdue follow-ups (past due)
- Upcoming this week (interviews, calls)
- New contacts added today

### 5. Google Sheet Schema

| Column | Description |
|--------|-------------|
| Contact Name | Person's name |
| Company | Company they're at |
| Role/Title | Their role |
| Relationship Type | Recruiter / Hiring Manager / Referral / Network contact |
| Source | How connected (LinkedIn, intro, cold email, etc.) |
| Channel | Primary channel (Email / WhatsApp / Both) |
| First Contact Date | First interaction |
| Last Interaction Date | Most recent interaction |
| Last Interaction Summary | One-line summary of last exchange |
| Next Follow-up Date | Committed follow-up date |
| Follow-up Action | What was promised |
| Status | Active / Waiting / Interview Scheduled / Offer / Closed |
| Notes | Free-form |
| Role Discussed | Specific job role if applicable |

## Tech Stack

- **Runtime:** Node.js 18+
- **WhatsApp:** whatsapp-web.js + better-sqlite3
- **Google APIs:** googleapis (Gmail, Calendar, Sheets)
- **LLM:** @anthropic-ai/sdk (Haiku for classification, Sonnet for extraction)
- **Scheduling:** macOS launchd (2 plist files)
- **Auth:** Google OAuth2 with offline refresh token

## Cost Estimate

- Claude Haiku: ~$0.01-0.05/day
- Claude Sonnet: ~$0.10-0.50/day
- Total: under $5/month
