# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

### Reference Docs

Sections below summarize key systems and point to reference docs for detailed procedures. **When a task touches one of these areas, read the referenced doc before acting — do not guess from the summary alone.** The summary tells you *what* and *where*; the reference doc tells you *how*.

| Area | Reference doc |
|------|---------------|
| Credentials, encryption, vault setup | `docs/security.md` |
| Browser reader, login, MFA types, CLI | `readers/README.md` |
| Transaction classification, model, training | `docs/classification.md` |
| Transaction download patterns (A-F) | `readers/tasks/PATTERNS.md` |
| Institution templates, obstacles | `readers/institutions/templates/GUIDE.md` |
| Dashboard customization | `docs/dashboard-customization.md` |
| Telegram bot + Mini App setup | `docs/telegram-setup.md` |

## Project Overview

Foliome is open-source financial data infrastructure for AI agents. It syncs data from financial institutions into local JSON files (Layer 1) and SQLite (Layer 2). An alternative to paid data aggregators and manual CSV downloads — the agent builds its own integrations via Playwright browser automation. It uses Playwright for deterministic bank login/text capture, agent-side extraction for balances, LiteParse for PDF statements, and REST API connectors. Zero paid APIs — the agent harness provides all LLM capabilities.

## Architecture

```
Playwright Browser Reader → CSV/Page Text → JSON Output (with pendingExtraction)
                                           → CSV Parse (transactions) → JSON Output
API Connectors → JSON Output
Real Estate (Playwright → Google/Zillow/Redfin scrape) → JSON Output (with pendingExtraction)
                                                    ↓
                                            data/sync-output/*.json (Layer 1)
                                                    ↓
                                          Agent extracts from pendingExtraction
                                          (balances, PDF transactions, real estate values)
                                                    ↓
                                            sync-engine/import.js (Transform)
                                                    ↓
                                            data/foliome.db (Layer 2 — SQLite)
                                                    ↓
                                        Agent Skills → User (Desktop or Telegram)
```

**Layer 1 (JSON):** Raw sync output per institution. Human-reviewable, schema-agnostic. Each bank's data preserved as-is.

**Layer 2 (SQLite):** Normalized canonical schema. Queryable. Tables: `balances`, `transactions`, `investment_transactions`, `holdings`, `statement_balances`, `sync_status`.

### Key Architectural Principles

- **Agent is the builder, Playwright is the runner.** An LLM agent explores bank websites during setup to discover login flows, MFA patterns, account structures, and download paths. It then writes deterministic Playwright configs. Daily execution uses these configs with zero LLM cost. The agent only returns when something breaks (bank redesign, new MFA flow).
- **Balance extraction uses the agent harness** — dashboard page text is captured during sync and saved as `pendingExtraction`. The agent (Claude Code, etc.) extracts structured balances from the text. Resilient to UI changes since it parses semantic text, not CSS selectors. Zero external API calls.
- **Transaction extraction uses six proven patterns:** (A) CSV download from central dialog, (B) per-account CSV download, (C) PDF statement download + LiteParse + agent extraction, (D) export modal with calendar date picker, (E) direct single-button export, (F) report-based async generation (create report → wait → download). Schema-agnostic — raw bank data preserved as-is.
- **Accounts are matched by last-4 digits** — strongest identifier, survives display name changes. Aliases accumulate in `accounts.json` over time.
- **Failed syncs never destroy good data** — error handling preserves previous successful sync output.

For per-institution details (login types, MFA, download patterns, custom components), see `config/institutions-status.md` (generated during setup — not present until you add institutions).

## Telegram Agent Lifecycle

When running as a Telegram agent (`--channels plugin:telegram`), you are managed by a supervisor that auto-restarts you on exit. Context management is critical — every message at 1M tokens costs 1M input tokens.

**On startup:** A `SessionStart` hook automatically runs `scripts/agent-startup.sh`, which:
1. Starts the dashboard server if not running
2. Injects the contents of `data/agent-handoff.md` (if it exists) into your context
3. Lists enabled schedules from `config/schedules.json` that need CronCreate registration
4. Shows the path to prior conversation transcripts

After processing the injected startup context, delete `data/agent-handoff.md` so you don't re-read stale handoffs. Register any listed schedules via CronCreate immediately.

**Prior conversation transcripts:** Full `.jsonl` transcripts of prior sessions are stored at `~/.claude/projects/-Users-wband-Projects-foliome/`. If you need context from a previous session beyond what the handoff file provides, read the most recent transcript. The startup hook outputs the path to the latest one.

**Context management:** When your conversation is very long and you notice degraded performance, high latency, or the user asks you to restart:
1. Write a handoff file to `data/agent-handoff.md` summarizing: what was the user's last request, any pending work, recent sync results, and anything the next session needs to know.
2. Tell the user you're restarting for a fresh session (they'll see you come back in ~10 seconds).
3. Exit by running: `kill $PPID` (the supervisor will restart you automatically).

**The user should never notice a restart.** Your CLAUDE.md, skills, and institution configs are all persistent. The handoff file bridges the gap. The `SessionStart` hook ensures the next session has context immediately.

**Schedule registration:** After the handoff check, check `config/schedules.json`. If it exists and has entries with `enabled: true`, register each via CronCreate using the entry's `cron` and prompt. Update `cronJobId` values after registration. For missed runs: if an entry's `lastRun` is null or significantly older than its schedule period (e.g., >2x the period — daily = 48h, weekly = 336h), execute it immediately as a catch-up run before registering the recurring schedule.

**Dashboard server:** If the dashboard server is not running, start it: `node scripts/dashboard-server.js &` (it auto-detects the correct bot token). If cloudflared tunnel is not running, start it: `cloudflared tunnel --url http://localhost:3847 &`. Check with `curl -s http://localhost:3847/health`.

**Dashboard menu button:** After establishing the tunnel URL, set the bot's persistent menu button so the user always has one-tap access to the dashboard: `node scripts/telegram-notify.js --menu-button "<chatId>" "<tunnel-url>"`. This replaces the default "/" commands button with a "Dashboard" button next to the text input. Update it whenever the tunnel URL changes.

## Dashboard Presentation (Telegram)

When running as a Telegram agent, the dashboard **must** be opened as a Telegram Mini App — not sent as a URL link. A plain URL won't pass `initData`, so the dashboard can't authenticate the user and will fail silently.

**Persistent access (menu button):** The bot's menu button is set during startup to open the dashboard. The user always has one-tap access next to the text input — no need to scroll or ask. The agent sets this via `--menu-button` after establishing the tunnel (see "Dashboard server" above).

**Contextual access (inline button):** For moments when the dashboard has fresh data, also send an inline `web_app` button:

```bash
node scripts/telegram-notify.js --dashboard "<chatId>" "<text>" "<tunnel-url>"
```

- `chatId` — from the inbound Telegram message's `chat_id`
- `text` — message shown above the button (e.g., "Your brief is ready.")
- `tunnel-url` — the active cloudflared tunnel URL (e.g., `https://xxx.trycloudflare.com`)

**When to send an inline dashboard button:**
- After `/morning-brief` — the Brief tab has the new data
- After `/custom-view` — the user needs to see the new tab
- After `/sync` completes — the Overview tab shows updated numbers

The user can always open the dashboard via the menu button, so inline buttons are supplementary prompts — not the only access path.

**Do NOT send the dashboard URL as a plain text link.** The Claude Code Telegram plugin's `reply` tool does not support `reply_markup`, so use `telegram-notify.js` for dashboard buttons and `reply` for conversational text.

## Telegram Interaction Guide

When the user messages via Telegram (via Claude Code channels), follow these rules:

**During syncs:** Use the `/sync` skill. It handles background execution, MFA polling, code routing, and progress reporting. See `.claude/skills/sync/SKILL.md` for the full orchestration.

**Skills the agent supports (11 total):**

| Category | Skill | Trigger |
|----------|-------|---------|
| Infrastructure | `/sync` | "sync", "update accounts", "refresh" |
| Infrastructure | `/learn-institution` | "add a new bank", "set up [bank]" |
| Infrastructure | `/getting-started` | "get started", "set up", "first bank" |
| Scheduling | `/foliome-loop` | "schedule", "every day at", "recurring", "automate" |
| Awareness | `/morning-brief` | "good morning", "daily summary" |
| Awareness | `/spending-alerts` | "alert me on transactions over $500" |
| Awareness | `/payment-reminders` | "what payments are due?" |
| Query | `/brief-me` | "how much on restaurants?", "spending report", "how's my portfolio?", "show holdings" |
| Management | `/category-override` | "classify X as Shopping" |
| Dashboard | `/custom-view` | "show me...", "add a tab for...", "build me a view of..." |
| Maintenance | `/reflect` | "reflect", "update wiki", "daily maintenance" |

## Agent Memory (Wiki)

The agent has a persistent memory system via interlinked markdown files at `data/wiki/`. Zero external dependencies — just files. Fully visible in any editor. See `data/wiki/schema.md` for full conventions.

**Two operating modes:**

**Active capture (during conversations):** When financial intent is detected mid-conversation, spawn a background subagent to create or update a wiki page. The main conversation continues unblocked. Bias towards creating new pages — better to capture something twice than miss it once. Always update `data/wiki/index.md` and append to `data/wiki/log.md`.

| Signal | Action |
|--------|--------|
| "I'm saving for a house" | Create/update `data/wiki/goals/house-down-payment.md` |
| "I want to spend less on restaurants" | Create/update `data/wiki/preferences/reduce-restaurant-spending.md` |
| "My credit card balance is getting high" | Create/update `data/wiki/concerns/credit-card-balance.md` |
| "Starting new job in May" | Create/update `data/wiki/context/new-job-may-2026.md` |
| "I get paid biweekly on Fridays" | Create/update `data/wiki/context/pay-schedule.md` |

**Active recall (during conversations):** When context is needed to answer a question or compose a response, read `data/wiki/index.md` to find relevant pages, then read those pages directly. No subagent needed — just file reads.

**Do NOT store in wiki:**
- Category corrections ("Zelle to Katie is rent") — use `/category-override` and `config/category-overrides.json`
- Temporary debugging context
- Data already in foliome.db or config/

**Periodic maintenance:** The `/reflect` skill scans all wiki pages, consolidates duplicates, updates goals with real data from foliome.db, discovers patterns, and writes monthly reflections. Run it periodically or after `/morning-brief`.

### Daily Brief

The `/morning-brief` skill generates structured JSON at `data/brief/latest.json`, served to the dashboard's Brief tab via `/api/brief`. The brief draws from three sources:
- **Wiki (`data/wiki/`)** — goals, preferences, concerns (what matters)
- **foliome.db** — transactions, balances, holdings (what happened)
- **config/** — budgets.json, payment-schedule.json (what's set)

The Brief tab is the first tab in the dashboard. It defaults to Overview until a brief exists, then switches to Brief as the landing tab.

## Browser Reader Primitive

Config-driven Playwright module (`readers/browser-reader.js`). Each institution provides a config in `readers/institutions/<bank>.js`. Handles login (iframe-aware, multi-step, adaptive), MFA (SMS, email, push, TOTP, device code, adaptive bridge), transaction downloads (6 patterns), and error recovery. When debugging login, MFA, or download failures, read `readers/README.md` before proceeding — it has the full config shape, all 6 MFA type mechanics, and CLI reference.

## Sync Orchestration

`readers/sync-all.js` runs all institutions:
- **Phase 1:** API connectors in parallel — instant, no browser
- **Phase 2:** All browser banks in parallel — any bank can trigger MFA
- MFA codes collected via bridge (`data/mfa-pending/`) and routed to correct sessions
- Script sends Telegram notification directly via bot API when MFA detected (with retry on failure)
- Adaptive help requests via `data/adaptive-pending/` for unknown page states
- User provides all codes in one message, orchestrator parses and routes
- Real estate skips if last sync <25 days old

## Account Registry

`config/accounts.json` is the enriched account registry:
- Each account has: `accountId` (slug), `bankName`, `accountType`, `last4` (strongest match key), `aliases` (accumulated display names)
- Account matching priority: last-4 digits → exact alias → substring match
- `readers/account-matcher.js` handles matching and auto-enriches aliases on new discoveries
- Account types: `checking`, `savings`, `credit`, `brokerage`, `retirement`, `education`, `mortgage`, `real_estate`

## Transaction Strategy

- **First run:** Download all transaction history ("All transactions" or max date range, capped at 24 months)
- **Subsequent runs:** Incremental — from last known transaction date to today
- **CSV parsing is schema-agnostic:** Raw bank columns preserved as-is in JSON output. Each bank has different schemas — all captured faithfully.
- **PDF parsing:** LiteParse extracts layout-aware text (with Tesseract.js OCR fallback for scanned pages) → raw text saved as `pendingExtraction` → agent extracts structured transactions (amounts as-shown, no sign interpretation — `import.js` normalizes).
- **Dedup (Layer 2):** Natural-key UNIQUE on `(institution, account_id, date, amount, description)` for transactions, plus `symbol` for investment transactions. No synthetic hash column — derived state in the schema is fragile (changing the formula invalidates every historical row). The natural key is stable across re-syncs because date/amount/description are what the bank actually emits per row. On re-sync, the UPSERT refreshes posting_date/status/balance_after/raw; existing values are preserved when the new import omits them. If you have an existing DB with the legacy `dedup_key` column, run `node scripts/migrate-dedup-natural-key.js` once to migrate.

## Data Semantics & Normalization

Each institution has its own conventions for representing debits, credits, and balances. These are documented in `config/data-semantics.json` and discovered during `/learn-institution` (Q9).

- **Extraction** (LLM) captures amounts as they appear in the source document — no sign interpretation
- **Normalization** (`import.js`) is the single owner — reads `data-semantics.json`, applies sign normalization, validates against known anchors
- **Pre-import validation** checks raw data against expected conventions before importing — halts if a platform changed its sign convention
- **Column mapping** in `data-semantics.json` maps raw CSV column names to canonical fields — new institutions just need a mapping entry, no code changes

Target convention (Layer 2): debits negative, credits positive, liability balances negative, asset balances positive.

## Transaction Classification

Pipeline: account-type-implied → merchant rules → sign-prefixed DistilBERT v2 → bank category fallback. Config in `config/category-overrides.json`, model at `data/models/foliome-classifier-v2-onnx/`. Transfer and Income excluded from spending analysis. When modifying classification logic, adding categories, or retraining, read `docs/classification.md` first — it has the full pipeline, all 23 categories, and training methodology.

## SQLite Schema (Layer 2)

Database at `data/foliome.db`. Import via `node sync-engine/import.js`.

- **balances** — balance snapshots per account per sync (historical)
- **transactions** — day-to-day transactions (checking, savings, credit, mortgage). Deduped by key.
- **investment_transactions** — trades, dividends, contributions (brokerage, retirement, education). Deduped by key.
- **holdings** — investment positions per account per sync
- **statement_balances** — period-end closing balances from statements (monthly anchors for "vs. Last Period" dashboard delta)
- **sync_status** — last sync result per institution

Key query: use latest balance per account (not sum of all historical):
```sql
SELECT b.* FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as max_sync FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.max_sync
```

## Statement Balances

Historical period-end closing balances for "vs. Last Period" comparison on the dashboard. Each institution provides statement balances through one of five patterns, discovered during `/learn-institution` Q10-Q15:

| Pattern | Source | Example Institutions |
|---|---|---|
| **S-A: PDF statements** | Parse opening/closing balances from downloaded PDF statements | Banks with downloadable PDF statements |
| **S-B: HTML statement list** | Statement page shows balances inline in page text | Banks with statement history pages |
| **S-C: Dashboard text** | "Last statement balance" label visible on dashboard | Banks showing statement balance on dashboard |
| **S-D: Not available** | No statement balance concept (investment/education accounts) | Brokerage, education, API-only accounts |
| **S-E: CSV balance column** | Running balance in transaction CSV + month-end anchor | Banks with balance column in CSV export |

**Dashboard integration:** Shows `current_balance - most_recent_closing_balance` delta per account. Green if improving, red if worsening.

## Graduated Error Recovery

Task-phase failures (balances, transactions) go through a 4-level recovery system in `readers/recovery.js`:

| Level | What | Who | Escalation trigger |
|---|---|---|---|
| 1. Retry | 3 attempts with 2s/5s/10s backoff | Automatic | All retries fail |
| 2. Self-recover | Dismiss popups, navigate to dashboard, retry | Automatic | Still fails |
| 3. Adaptive bridge | Screenshot + context → agent decides (60s timeout) | Agent-assisted | No response or retry fails |
| 4. Skip + notify | Preserve partial data, screenshot, Telegram alert | User-informed | Terminal |

- Maintenance pages and session expiration skip directly to Level 4
- Tasks run independently — balance failure doesn't block transactions
- `writeOutput()` always called, even on partial failure — previous good data preserved
- `<institution>.result.json` written alongside output with structured status (`ok`/`partial`/`failed`)
- Task-error adaptive requests use `type: 'task-error'` (distinct from `type: 'unknown-state'` for login-phase)

## Data Integrity Safeguards

- Failed syncs never overwrite good data (`writeError` preserves existing file)
- Zero-balance protection (keeps previous data if new sync returns empty)
- Balance sanity check (warns on >50% change from last sync)
- `syncedAt` + `previousSyncedAt` timestamps for staleness tracking
- API token expiry warnings (alerts when <2 days left)
- Real estate staleness (refreshes monthly, 25-day threshold)
- Dedup on import prevents duplicate transactions
- Slug immutability validation (`scripts/validate-slugs.js`) — checks institution slugs are consistent across config files, sync output, accounts.json, data-semantics.json, and credential-map.json. Wired into `readers/run.js` (exit on failure) and `sync-engine/import.js` (skip on failure). Detects orphaned sync output files.
- Data semantics gate — `import.js` blocks transaction import for any institution without a `data-semantics.json` entry and directs the user to run `scripts/discover-semantics.js`. Use `--force` to bypass (imports amounts as-is without sign normalization)

## Key Entry Points

- `readers/run.js` — CLI for single-institution sync (`--balances`, `--transactions`, `--explore`)
- `readers/sync-all.js` — Parallel sync orchestrator (all institutions)
- `readers/explore-interactive.js` — Interactive browser explorer for discovering bank UI patterns
- `readers/explore.js` / `readers/explore-cmd.js` — Explorer primitives and CLI entry point
- `connectors/real-estate.js` — Real estate valuation via Google/Zillow/Redfin scraping
- `sync-engine/import.js` — JSON → SQLite transform with normalization + dedup
- `sync-engine/classify.js` — Transaction classifier
- `scripts/dashboard-server.js` — Telegram Mini App server (auth, API, static serving)
- `scripts/dashboard-queries.js` — All SQL query functions for dashboard API endpoints
- `scripts/telegram-notify.js` — Telegram utility (sendMessage, sendPhoto, sendDashboard, setMenuButton, waitForReply)
- `scripts/credentials.js` — Credential resolution (Bitwarden vault → .env fallback)
- `scripts/vault.js` — Bitwarden vault CLI wrapper (search, map, test, migrate)
- `scripts/gmail-mfa.js` — Gmail API MFA code retrieval for email-based MFA
- `scripts/cleanup-downloads.js` — Remove stale download files after import
- `config/` — All config files (populated from `config-templates/` on setup, gitignored)
- `data/` — All runtime data (gitignored): `sync-output/`, `foliome.db`, `downloads/`, `wiki/`, `brief/`, `models/`
- `.claude/skills/` — Agent skills (discoverable via /slash-commands)

## Credential Management

Resolution order: Bitwarden vault → `.env` fallback. Encrypted at rest by dotenvx. Pre-flight encryption runs automatically before every sync. When setting up credentials, configuring Bitwarden, or troubleshooting auth failures, read `docs/security.md` before proceeding — it has the full credential flows, vault CLI, and .env variable reference.

The `.env` slug convention: `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` where `<SLUG>` is uppercased with hyphens removed (e.g., `chase` → `CHASE`, `capital-one` → `CAPITALONE`). Check with `node scripts/check-env.js --prefix <SLUG>`. Do not read `.env` directly.

**Agent behavior when setting up a new institution:** Before running any vault commands or asking the user to add credentials, silently check what's already configured:

1. Check `.env` for `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` (via `node scripts/check-env.js --prefix <SLUG>`)
2. If not in `.env`, check `config/credential-map.json` for an existing Bitwarden mapping
3. Only if NEITHER exists, ask the user: "You need to set up credentials for this bank." Do not run `vault.js list-banks`, `vault.js search`, or any vault browsing commands unprompted.

## Key Conventions

- **No secrets in repo.** All tokens/keys in `.env` (gitignored). Bank credentials are resolved via Bitwarden vault first, falling back to `.env` env vars. The `.env` convention for credentials is `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` where `<SLUG>` is the institution slug uppercased with hyphens removed (e.g., `chase` → `CHASE`, `capital-one` → `CAPITALONE`, `apple-card` → `APPLECARD`). To check whether credentials are set, use `node scripts/check-env.js CHASE_USERNAME CHASE_PASSWORD` or `node scripts/check-env.js --prefix CHASE`. Do not read `.env` directly.
- **Security gate before credentials.** Domain + HTTPS check before Playwright enters any credentials. Hard abort on failure.
- **Persistent Chrome profiles.** One per institution under `data/chrome-profile/<institution>/`. Sessions survive across runs to reduce MFA frequency.
- **System Chrome preferred.** The browser reader auto-detects system Chrome and uses it over Playwright's Chromium. Real browser fingerprint defeats captchas and bot detection. Falls back to Playwright Chromium if Chrome is not installed.
- **Cookie banner dismissal.** `dismissPopups()` runs before login, after login, and between tasks. Uses a 4-tier selector system: (1) known cookie consent framework IDs, (2) text matching scoped to cookie/consent containers, (3) modal/dialog-scoped dismissals, (4) institution-specific `popupDismissSelectors` from config. No unscoped text matching — prevents accidental clicks on bank actions.
- **Layer 1 first.** All data goes to JSON files. `import.js` transforms to SQLite on demand.
- **Transaction amounts are always signed** from the account holder's perspective (negative = money out). Mortgages and credit card balances are negative.
- **Real estate refreshes monthly.** 25-day staleness threshold. `--force` overrides.
