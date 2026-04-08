# Scripts

Shared helpers organized by function. Some run automatically during syncs, others are invoked by the agent or user.

## Runtime (used during syncs)

| Script | Purpose |
|--------|---------|
| `credentials.js` | Credential resolution — Bitwarden vault → `.env` fallback |
| `encrypt-env.js` | Pre-flight encryption for sensitive `.env` values (runs automatically before every sync) |
| `dashboard-server.js` | Telegram Mini App server — auth, API routes, static serving |
| `dashboard-queries.js` | SQL query functions shared by the API server and legacy dashboard |
| `wiki-queries.js` | Wiki data access — frontmatter parsing, path confinement, index generation |
| `telegram-notify.js` | Telegram utility — sendMessage, sendPhoto, sendDashboard (web_app button), setMenuButton, waitForReply |
| `gmail-mfa.js` | Gmail API poller for email MFA code auto-extraction |
| `dashboard.js` | Legacy HTML dashboard generator (backward compat) |

## Setup (run once or during configuration)

| Script | Purpose |
|--------|---------|
| `vault.js` | Bitwarden CLI helper — list banks, map institutions, test credentials (masked output) |
| `check-env.js` | Check if env vars are set without revealing values |

## Validation (dev / diagnostics)

| Script | Purpose |
|--------|---------|
| `validate-data.js` | Check data semantics, sign normalization, database invariants |
| `validate-slugs.js` | Check institution slug consistency across all config surfaces |
| `discover-semantics.js` | Inspect CSV or JSON sync-output to suggest a `data-semantics.json` entry |
| `cleanup-downloads.js` | Delete download files older than 30 days (dry run by default) |
