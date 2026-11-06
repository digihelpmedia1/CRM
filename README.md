# Digi Help Media — Lead CRM

A lightweight CRM for managing **Meta Ads leads** for Digi Help Media.
Leads land in a Google Sheet (from Meta Lead Ads) → the CRM imports them automatically → the admin assigns them to telecallers → telecallers call, send WhatsApp templates, add notes, set follow-ups and update status.

No installation, no server, no build step: open `index.html` in Chrome / Edge, or host the folder on any static host (GitHub Pages, Netlify, Vercel).

## Features

| Area | What it does |
|---|---|
| **Dashboard** | KPIs (total, new today, untouched, unassigned, follow-ups due, conversions & conversion %), 14-day lead trend, pipeline by status, leads by platform / source / campaign, team performance, latest leads |
| **Google Sheet sync** | Paste the sheet URL → leads are fetched automatically every _N_ minutes. Meta column names (`full_name`, `phone_number`, `platform`, `campaign_name`, `ad_name`, `form_name`, `created_time`, `id`…) are auto-detected. Extra form questions are stored on the lead. Duplicates are skipped by Meta lead ID / phone number. |
| **Leads** | Search, filter by status / team member / source / platform / date / follow-up, sortable columns, inline status & assignment, bulk assign (incl. round-robin), bulk status, CSV export, manual "Add lead" |
| **Team assignment** | Add telecallers / managers / admins, auto-assign new leads round-robin, "distribute unassigned leads" button, per-member stats |
| **Customer status** | Fully customisable pipeline (name, colour, "closed" flag, order) — default: New, Contacted, Not Picked, Interested, Follow-up, Meeting Scheduled, Converted, Not Interested, Invalid / Junk |
| **Lead source & platform** | Editable lists (Meta Ads, Google Ads, Website… / Facebook, Instagram, Messenger…) |
| **Lead profile** | One-click call, WhatsApp, email; status chips; follow-up date with quick buttons (+1h, tomorrow, +2 days, +1 week); notes / call remarks; full activity timeline; Meta form answers |
| **Follow-ups** | Overdue / Today / Upcoming board |
| **WhatsApp templates** | Create templates with variables `{{name}} {{first_name}} {{agent}} {{agent_phone}} {{company}} {{campaign}} {{city}}…`, live WhatsApp-style preview. Telecaller picks a template, edits, sends via **wa.me** (WhatsApp Web/App) **or** via **n8n → WhatsApp Business API**. Every message is logged on the lead. |
| **n8n webhooks** | Webhook URL + optional secret header, choose events: `lead.created`, `lead.assigned`, `lead.status_changed`, `lead.updated`, `lead.note_added`, `lead.followup_set`, `whatsapp.sent`, `lead.deleted`. Test button + delivery log. |
| **Roles** | Admin/Manager see everything; Telecallers see only their own leads |
| **Team Cloud Sync** | Optional free Google Apps Script backend so all team computers share the same leads in near real time |
| **Backup** | JSON backup / restore, CSV export, demo data |

## Quick start

1. Open `index.html` in a browser (or deploy the folder to GitHub Pages).
2. **Settings** → check company name and country code (`91`).
3. **Team** → add your telecallers. Turn on round-robin if you want automatic assignment.
4. **Integrations → Google Sheet**
   - In your Meta leads sheet: **Share → General access → Anyone with the link → Viewer**.
   - Paste the sheet URL → **Save & sync now**.
5. **WhatsApp Templates** → edit the templates to your wording.
6. *(Recommended for teams)* **Integrations → Team Cloud Sync** → follow the steps below.

## Team Cloud Sync (shared database)

By default, data is stored in the browser (`localStorage`). For several telecallers on different computers:

1. Create a blank Google Sheet, e.g. **DHM CRM Database** (keep it private).
2. **Extensions → Apps Script**, paste [`apps-script/Code.gs`](apps-script/Code.gs), save.
3. **Deploy → New deployment → Web app** — Execute as **Me**, Who has access **Anyone** → Deploy → authorise.
4. Paste the `/exec` URL in **Integrations → Team Cloud Sync** on every computer and enable it.

Leads, team, templates and settings are then synced every 30 seconds (last-write-wins per lead).

## n8n setup

1. In n8n add a **Webhook** node → HTTP Method **POST** → copy the **Production URL**.
2. Options → **Allowed Origins (CORS)** = `*` (needed when the CRM runs from a file or another domain).
3. Paste the URL in **Integrations → n8n Automation**, tick the events, enable, and **Send test event**.
4. Use a **Switch** node on `{{$json.body.event}}` to route events.

Example payload:

```json
{
  "event": "lead.assigned",
  "timestamp": "2026-11-07T10:15:00.000Z",
  "company": "Digi Help Media",
  "actor": { "id": "m_admin", "name": "Admin", "role": "Admin" },
  "lead": {
    "id": "L_xxx", "metaId": "123456", "name": "Rahul Sharma",
    "phone": "+919876543210", "phoneIntl": "919876543210", "email": "rahul@example.com",
    "status": "New", "source": "Meta Ads", "platform": "Instagram",
    "campaign": "Diwali Offer", "assignedTo": { "id": "m_1", "name": "Priya", "phone": "..." },
    "extra": { "what_is_your_budget?": "25k" }
  }
}
```

Ideas: notify the telecaller on WhatsApp when a lead is assigned, send WhatsApp via Cloud API when `whatsapp.sent` arrives in API mode, add converted leads to Google Contacts / invoicing, create a Google Calendar event on `lead.followup_set`.

## Project structure

```
index.html            App shell
css/styles.css        Styles
js/store.js           Data model, defaults, localStorage persistence
js/integrations.js    Google Sheets import, n8n webhooks, WhatsApp, Team Cloud Sync
js/app.js             UI: views, lead drawer, forms, handlers
apps-script/Code.gs   Optional Google Apps Script backend for team sync
```

## Notes & limitations

- The **"Logged in as"** selector is a convenience switch, not secure authentication. Use Team Cloud Sync with trusted staff only. For strict per-user login, the next step is moving the backend to Supabase/Firebase with auth.
- The Google Sheet must be viewable by link for the CRM to read it.
- Auto-sync from the sheet runs on Admin/Manager browsers while the CRM is open.
