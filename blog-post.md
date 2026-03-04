# I Built a CRM for My Job Hunt (Because I Keep Forgetting to Follow Up)

A couple of weeks into my job search, I realised I had a problem. I was talking to a bunch of people - recruiters, hiring managers, friends of friends who knew someone at some company - across email, WhatsApp, and the occasional text. And I was making commitments. "I'll send you my resume by Friday." "Let me follow up next week." "I'll ping you after the long weekend."

The problem is I wasn't following up. Not because I didn't want to, but because these commitments were scattered across three different platforms and my brain isn't built to be a CRM. I'd remember the Microsoft conversation but forget about the one with the recruiter at KPMG. Or I'd follow up with someone two days late and feel terrible about it.

So I did what any self-respecting data person would do. I built a system.

## What it does

The basic funda is simple. Every morning at 7 AM, a script runs on my Mac and does the following:

1. Scans my Gmail for the last 7 days of emails
2. Checks my Google Calendar for the next 3 days
3. Pulls recent WhatsApp messages from a local database (more on this in a bit)
4. Sends all of this through Claude - first Haiku to classify what's job-related, then Sonnet to extract the actual commitments and contact details
5. Updates a Google Sheet with all the contacts, companies, follow-up dates
6. Emails me a summary - what's overdue, what's due today, what's coming up

The whole thing runs in about 3 minutes and costs maybe 30-40 cents a day in API calls.

## The WhatsApp bit

This was the trickiest part. WhatsApp doesn't have a proper API for personal accounts (the Business API is a different thing entirely). I ended up using whatsapp-web.js, which is essentially a Node.js library that runs a headless Chrome instance connected to WhatsApp Web. You scan a QR code once, and it stays connected, storing every message - incoming and outgoing - into a local SQLite database.

It runs as a background daemon on my Mac via launchd, so as long as my laptop is on (and it usually is), it's capturing everything.

## The two-stage LLM pipeline

I didn't want to send every email and WhatsApp message through an expensive model. On any given week I get maybe 100+ emails, and only 20-30% of those are job-related. So there's a two-stage approach:

First, Claude Haiku (the cheap, fast model) classifies messages in batches of 20. "Is this job-related? Yes or no." At $0.25 per million input tokens, this costs basically nothing.

Only the messages that pass the filter go to Claude Sonnet, which does the expensive work - extracting the contact name, their company, what role we discussed, whether there's a follow-up date, what I committed to doing. This is where the structured data comes from.

The rate limits were an issue at first (I'm on the basic API tier - 50 requests per minute). The initial version was making one API call per email, which meant it would hit the limit after 50 emails and crash. Batching 20 messages into a single API call fixed that.

## What the CRM looks like

It's just a Google Sheet. Fourteen columns - Contact Name, Company, Role/Title, Relationship Type, Source, Channel, First Contact Date, Last Interaction Date, and so on. Nothing fancy. The script creates a "CRM" tab in your existing sheet and manages everything there.

The upsert logic matches on name + company. So if I have three email threads with the same recruiter, it updates the existing row rather than creating duplicates. First contact date is preserved, last interaction date gets updated, notes get appended.

## The daily email

This is arguably the most useful part. Every morning I get an email that looks like:

- **Overdue**: These are the people I said I'd follow up with and didn't
- **Due Today**: These are today's commitments
- **Upcoming**: Calendar events for the next few days that look job-related

It's the guilt-driven productivity system I needed.

## The stack

All Node.js (because whatsapp-web.js is Node-only and I didn't want to maintain two languages). The key dependencies:

- whatsapp-web.js for WhatsApp capture
- googleapis for Gmail, Calendar, and Sheets
- @anthropic-ai/sdk for Claude
- better-sqlite3 for local storage
- macOS launchd for scheduling

The whole thing is about 10 source files and maybe 600 lines of code. Claude Code wrote most of it.

## Would I recommend this approach?

If you're in a job search and talking to more than 5-6 people, yes. The setup takes about 30 minutes (mostly Google Cloud Console stuff - enabling APIs, OAuth consent screens, that kind of thing). After that it just runs.

The one caveat is the WhatsApp piece - it requires your laptop to be running for the daemon to capture messages. If you're not a heavy WhatsApp user for job conversations, you could skip that part entirely and just use the email + calendar scanning, which works without any always-on requirement.

The code is at [github.com/skthewimp/job-crm](https://github.com/skthewimp/job-crm) if you want to try it yourself.
