# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

For per-institution details (login types, MFA, download patterns, custom components), see `config/institutions-status.md`.

## Telegram Agent Lifecycle

When running as a Telegram agent (`--channels plugin:telegram`), you are managed by a supervisor that auto-restarts you on exit. Context management is critical — every message at 1M tokens costs 1M input tokens.

**On startup:** Check for `data/agent-handoff.md`. If it exists, read it — it contains context from your previous session (what was happening, pending tasks, recent user requests). After reading, delete the file so you don't re-read stale handoffs.

**Context management:** When your conversation is very long and you notice degraded performance, high latency, or the user asks you to restart:
1. Write a handoff file to `data/agent-handoff.md` summarizing: what was the user's last request, any pending work, recent sync results, and anything the next session needs to know.
2. Tell the user you're restarting for a fresh session (they'll see you come back in ~10 seconds).
3. Exit by running: `kill $PPID` (the supervisor will restart you automatically).

**The user should never notice a restart.** Your CLAUDE.md, skills, and institution configs are all persistent. The handoff file bridges the gap.

**Dashboard server:** If the dashboard server is not running, start it: `node scripts/dashboard-server.js &` (it auto-detects the correct bot token). If cloudflared tunnel is not running, start it: `cloudflared tunnel --url http://localhost:3847 &`. Check with `curl -s http://localhost:3847/health`.

## Telegram Interaction Guide

When the user messages via Telegram (via Claude Code channels), follow these rules:

**During syncs:** Use the `/sync` skill. It handles background execution, MFA polling, code routing, and progress reporting. See `.claude/skills/sync/SKILL.md` for the full orchestration.

**Skills the agent supports (12 total):**

| Category | Skill | Trigger |
|----------|-------|---------|
| Infrastructure | `/sync` | "sync", "update accounts", "refresh" |
| Infrastructure | `/learn-institution` | "add a new bank", "set up [bank]" |
| Infrastructure | `/getting-started` | "get started", "set up", "first bank" |
| Awareness | `/morning-brief` | "good morning", "daily summary" |
| Awareness | `/spending-alerts` | "alert me on transactions over $500" |
| Awareness | `/payment-reminders` | "what payments are due?" |
| Query | `/brief-me` | "how much on restaurants?", "spending report", "how's my portfolio?", "show holdings" |
| Management | `/category-override` | "classify X as Shopping" |
| Management | `/readiness-check` | "check if ready to sync", "readiness check" |
| Dashboard | `/custom-view` | "show me...", "add a tab for...", "build me a view of..." |
| Maintenance | `/reflect` | "reflect", "update wiki", "daily maintenance" |
| Session | `/wrap-it-up` | "wrap it up", end-of-session doc freshness check |

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

Config-driven Playwright module (`readers/browser-reader.js`). Each institution provides a config in `readers/institutions/<bank>.js`.

**What the config contains:**
- Entry URL + dashboard URL + security gate (domain + HTTPS verification)
- Login selectors (supports iframes via `frameLocator`, landing pages, method selection)
- MFA detection patterns (SMS, email, push, device code) + handler selectors + initiation buttons
- Transaction download dialog selectors (six patterns + PDF pipeline)
- Text capture function (page text saved for agent-side balance extraction)
- Interstitial handlers (passkey enrollment, promo pages)
- WebAuthn/passkey disable via CDP virtual authenticator (`disableWebAuthn`)
- System Chrome auto-detection (`executablePath` to real Chrome binary)
- Institution-specific popup dismiss selectors (`popupDismissSelectors`)
- Dashboard URL for post-login recovery (`dashboardUrl`)

**What the primitive handles:**
- Credential resolution via Bitwarden vault or `.env` fallback (`scripts/credentials.js`)
- Persistent Chrome profile per institution (session reuse across runs)
- Security gate before any credentials
- Cookie banner dismissal before login
- Landing page login (click "Sign In" to reveal form)
- Iframe-aware login (via `frameLocator`)
- Multi-step login with method selection
- Adaptive login (detects if password already visible on return visits)
- SPA session detection (retries state detection when no login form found — handles cached sessions that redirect away from login)
- MFA detection → initiation → signal to caller → code entry (single field or individual digits) or push wait
- MFA bridge (file-based code exchange for background operation)
- Adaptive bridge (visual help for unknown page states via annotated screenshots)
- Post-login interstitial handling (passkey enrollment → skip to dashboard)
- Pop-up/modal dismissal via 4-tier system: framework IDs → container-scoped consent → modal-scoped → institution-specific
- Dashboard URL recovery for unknown post-login pages
- CDP virtual authenticator for WebAuthn/passkey bypass
- CSV download with file capture
- PDF statement download + LiteParse + agent extraction
- Backdrop overlay bypass via `page.evaluate()` clicks

**CLI:**
```
node readers/run.js <bank>                          # balances + transactions
node readers/run.js <bank> --balances               # balances only
node readers/run.js <bank> --transactions           # transactions only
node readers/run.js <bank> --transactions --all     # full history (first run)
node readers/run.js <bank> --transactions --from 2026-02-01 --to 2026-03-19  # date range
node readers/run.js <bank> --explore                # dump page structure
node readers/explore-interactive.js <bank> <url> <userEnv> <passEnv>  # interactive visual explorer
node readers/explore-cmd.js <bank> <action> [args]  # send commands to interactive explorer
node readers/explore.js <url> --profile <name>      # explore any login page
node readers/sync-all.js                            # sync all institutions in parallel
node readers/sync-all.js --bank <name>              # sync single institution only
```

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

## MFA Handling

MFA is detected from page text patterns (including iframe content) and routed to handlers. Code exchange uses the MFA bridge (`readers/mfa-bridge.js`) for background operation.

- **SMS** — Click initiation button ("Text me", "Send code") → wait for code input to appear → enter code → click submit
- **Email** — Gmail API auto-polls, regex-extracts code, enters automatically. Falls back to SMS.
- **Push** — Click push option, confirm, poll for clearance (up to 180s)
- **Device code** — Code sent to trusted devices. Uses individual digit input fields (6 separate `input[type="tel"]`). Same bridge flow as SMS.
- **TOTP** — Authenticator app (Google Authenticator, Authy, etc.) generates a 6-digit code. Single input field, no initiation button needed. Config uses `totp: true` and `totpPatterns` for detection.
- **Adaptive bridge** — When `_detectState()` returns `'unknown'` (page not recognized as login, dashboard, or MFA), `run.js` enters adaptive mode: takes an annotated screenshot, writes a help request to `data/adaptive-pending/`, and waits for the agent to send instructions. After resolution, discovered patterns are saved so the next run is deterministic.

## Transaction Strategy

- **First run:** Download all transaction history ("All transactions" or max date range, capped at 24 months)
- **Subsequent runs:** Incremental — from last known transaction date to today
- **CSV parsing is schema-agnostic:** Raw bank columns preserved as-is in JSON output. Each bank has different schemas — all captured faithfully.
- **PDF parsing:** LiteParse extracts layout-aware text (with Tesseract.js OCR fallback for scanned pages) → raw text saved as `pendingExtraction` → agent extracts structured transactions (amounts as-shown, no sign interpretation — `import.js` normalizes).
- **Dedup (Layer 2):** Key = `institution + account_id + raw_transaction_id` when the source provides a stable ID (API connectors), falling back to `institution + account_id + date + amount + description_hash` for CSV sources. ID-based dedup prevents duplicates from pending→posted date shifts. Pending transactions update to posted status via upsert.

## Data Semantics & Normalization

Each institution has its own conventions for representing debits, credits, and balances. These are documented in `config/data-semantics.json` and discovered during `/learn-institution` (Q9).

- **Extraction** (LLM) captures amounts as they appear in the source document — no sign interpretation
- **Normalization** (`import.js`) is the single owner — reads `data-semantics.json`, applies sign normalization, validates against known anchors
- **Pre-import validation** checks raw data against expected conventions before importing — halts if a platform changed its sign convention
- **Column mapping** in `data-semantics.json` maps raw CSV column names to canonical fields — new institutions just need a mapping entry, no code changes

Target convention (Layer 2): debits negative, credits positive, liability balances negative, asset balances positive.

## Transaction Classification

Classification pipeline in `classify.js`:

```
Phase 0: Account-type-implied   — mortgage, auto_loan, student_loan, personal_loan, heloc, cd
Tier 1:  Merchant rules         — pattern match on description (e.g., "Zelle payment to" → Transfer)
Tier 2:  Model (cache or infer) — sign-prefixed DistilBERT v2 ([debit]/[credit] + full description)
Tier 3:  Bank category fallback — if model confidence < 0.70 and bank has a mappable category
```

Account-type-implied categories skip the model entirely — all transactions on a mortgage account are Mortgage by definition. For checking, savings, and credit card accounts, the model runs with a `[debit]`/`[credit]` sign prefix derived from the normalized transaction amount.

**17 model-classified categories:** Restaurants, Groceries, Shopping, Transportation, Entertainment, Utilities, Subscription, Healthcare, Insurance, Mortgage, Rent, Travel, Education, Personal Care, Transfer, Income, Fees.

**6 account-type-implied categories:** Mortgage (mortgage accounts), Transportation (auto_loan), Education (student_loan), Transfer (personal_loan, heloc), Income (cd).

"Business" is not a transaction-level category — whether a transaction is a business expense depends on which account it's charged to, not the description. Account-level annotations are a separate layer.

**Transfer and Income are excluded from spending analysis** (`/brief-me`) by default — transfers are money movement between accounts, income is money coming in. Neither represents discretionary spending.

**Classification config:** `config/category-overrides.json` contains merchant rules and the category lists. The fine-tuned model is at `data/models/foliome-classifier-v2-onnx/`.

**Retraining:** Synthetic training data (68k samples, 8 bank formats) generated by `scripts/generate-training-data.js`. Fine-tuning via `scripts/finetune-classifier-v3.py`. Model and dataset published on HuggingFace at `DoDataThings/distilbert-us-transaction-classifier-v2` and `DoDataThings/us-bank-transaction-categories-v2`.

**Data validation:** `scripts/validate-data.js` checks data semantics, sign normalization, database invariants, and account-type-implied classifications.

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

**Statement PDF downloads** (`readers/tasks/download-statements.js`): Config-driven module that downloads and parses PDF statements per institution. Reads `config.statementBalances` per account type (checking, savings, credit, mortgage) — the same schema written by `/learn-institution` Q10-Q15. Each type with `source: 'pdf'` provides three hooks: `beforeDownloads(page, accountId)` for setup, `download(page, accountId, rowIdx)` to download one statement (returns Playwright Download), and `afterDownloads(page, accountId)` for cleanup. The generic wrapper handles navigation, page readiness, iteration over accounts and months, file saving, PDF parsing via LiteParse, and error handling.

**Dashboard integration** (`scripts/dashboard.js`): Shows `current_balance - most_recent_closing_balance` delta per account. Green if improving, red if worsening.

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

## File Structure

```
readers/                     — Playwright browser reader primitive
  browser-reader.js          — Config-driven login/extraction engine
  tasks/extract-balances.js  — Dashboard text capture for agent-side extraction
  annotate.js                — Shared annotation primitives (element discovery, numbered labels)
  account-matcher.js         — Account matching by last-4 + aliases
  mfa-bridge.js              — File-based MFA code exchange for background operation
  adaptive-bridge.js         — File-based adaptive help for unknown page states + task errors
  sanitize-text.js           — Layer 1+2 prompt injection defense (hidden element stripping + boundary markers)
  recovery.js                — 4-level graduated error recovery for task-phase failures
  run.js                     — CLI entry point with --balances/--transactions/--explore flags
  sync-all.js                — Parallel sync orchestrator for all institutions
  explore-interactive.js     — Interactive visual explorer (step-by-step with annotated screenshots)
  explore-cmd.js             — CLI helper to send commands to interactive explorer
  explore.js                 — Generic page explorer (any URL)
  institutions/              — Per-bank configs (one file per institution)
    templates/               — Anonymized pattern templates for new institution setup
  tasks/                     — Gated task modules
    extract-balances.js      — Dashboard text → LLM → balances JSON
    download-transactions.js — 6 download patterns (A-F) + PDF pipeline
    download-statements.js — Statement PDF downloads for balance extraction (Chase)
    PATTERNS.md              — Visual guide to all 6 transaction download patterns
connectors/                  — API integrations (no browser needed)
  real-estate.js             — Real estate value tracking (Zillow/Redfin/Google scrape)
sync-engine/                 — Layer 2 persistence
  import.js                  — JSON → SQLite transform with normalization + dedup
  classify.js                — Transaction classifier (account-type → rules → sign-prefixed DistilBERT v2 → bank fallback)
  security-gate.js           — Domain + HTTPS verification
.claude/skills/              — Agent skills (12 total, discoverable via /slash-commands)
  sync/                       — Full sync orchestration with MFA handling
  learn-institution/          — Visual exploration skill for building new bank integrations (15 questions including data semantics and statement balances)
  getting-started/            — First-time setup walkthrough for new users
  morning-brief/              — Daily financial summary (net worth, activity, due dates)
  brief-me/                   — On-demand financial briefing (spending, portfolio, reports, CSV export)
  spending-alerts/            — Large charge, low balance, and unusual activity monitoring
  payment-reminders/          — Credit card payment due date tracking
  category-override/          — Transaction category overrides via natural language
  custom-view/                — On-demand dashboard tab generation from natural language
  reflect/                    — Wiki maintenance (consolidate, update goals, discover patterns, monthly reflections)
  readiness-check/            — Pre-sync environment and credential verification (dev only)
  wrap-it-up/                 — End-of-session doc freshness check
dashboard/                   — React SPA (Vite + TypeScript + Tailwind + shadcn)
  src/context/               — AuthContext (Telegram init + session tokens), ThemeContext
  src/lib/                   — format.ts (accounting numbers), api.ts, telegram.ts, types.ts, constants.ts, utils.ts
  src/components/shared/     — KPICard, AccountRow, TransactionRow, InstitutionIcon, Sparkline, MarkdownRenderer, CategoryBadge, EmptyState
  src/components/overlays/   — FinancialHealth full-screen overlay
  src/tabs/                  — Brief, Overview, Transactions, Budget, Portfolio, Subscriptions, Wiki
  dist/                      — Build output (gitignored), served by dashboard-server.js
scripts/                     — Shared helpers
  dashboard.js               — Legacy HTML dashboard generator (backward compat)
  dashboard-queries.js       — Extracted SQL query functions for API + legacy
  wiki-queries.js            — Wiki data access (frontmatter parsing, path confinement, index generation)
  dashboard-server.js        — Telegram Mini App server (auth, API routes, static serving)
  credentials.js             — Credential resolution (Bitwarden vault → .env fallback)
  vault.js                   — CLI helper for Bitwarden mapping, migration, and testing
  check-env.js               — Check if env vars are set without revealing values
  telegram-notify.js         — Send-only Telegram utility + waitForReply for MFA
  generate-training-data.js  — Synthetic transaction data generator (68k samples, 17 categories, 8 bank formats) (dev only)
  finetune-classifier-v3.py  — DistilBERT + LoRA fine-tuning script (dev only)
  validate-data.js           — Data validation (semantics, normalization, database invariants, account-type checks) (dev only)
  gmail-mfa.js               — Gmail API poller for email MFA codes
config/                      — Configuration files
  accounts.json              — Enriched account registry with last-4, aliases, types
  credential-map.json        — Institution slug → Bitwarden vault item ID mapping (safe to commit)
  institutions-status.md     — Per-institution status, MFA details, download patterns (personal, not in public repo)
  category-overrides.json    — Transaction classification rules, bank category mappings, merchant overrides
  data-semantics.json        — Per-institution sign conventions, column mappings, validation anchors
  payment-schedule.json      — Credit card payment due dates for reminder skill
  alert-config.json          — Spending alert thresholds and rules
  budgets.json               — Monthly budget limits per category (for Budget tab)
data/                        — All gitignored
  sync-output/               — Layer 1 JSON files per institution
  foliome.db               — Layer 2 SQLite database
  chrome-profile/            — Persistent Chrome profiles per institution
  downloads/                 — Downloaded CSVs and PDFs
  mfa-pending/               — MFA bridge request/code files
  adaptive-pending/          — Adaptive bridge requests/instructions/screenshots
  explore/                   — Screenshots from exploration
  exports/                   — Skill-generated CSV exports (opt-in via /brief-me)
  brief/                     — Daily brief JSON files (latest.json + dated archives)
  wiki/                      — Agent memory wiki (goals, preferences, concerns, context, patterns, reflections)
  models/                    — ML models (fine-tuned classifier v2 ONNX, sign-prefixed)
  training/                  — Synthetic training data CSVs
docs/                        — Architecture documents
  dashboard-customization.md — How to customize the React dashboard (add tabs, charts, filters)
  dashboard-design.md        — Design spec: colors, typography, animations, component specs
  how-browser-automation-works.md — Technical deep-dive on browser automation approach
  telegram-setup.md          — Telegram bot and Mini App setup guide
  architecture-flow.png      — Architecture flow diagram
  browser-automation.png     — Browser automation diagram
  computer-use-comparison.png — Comparison with computer-use approaches
```

## Credential Management

### How Credentials Work

Bank login credentials (usernames + passwords) are never stored as plaintext at rest. Two layers protect them:

1. **Encryption at rest** — sensitive values in `.env` are encrypted via [dotenvx](https://dotenvx.com). The `.env` file contains `encrypted:...` blobs. A separate `.env.keys` file (gitignored) holds the decryption key. At runtime, `dotenvx` decrypts values transparently when the process starts.

2. **Bitwarden vault** (optional, recommended) — bank credentials are fetched from an encrypted Bitwarden vault at login time, so they never touch `.env` at all. Only the Bitwarden API key and master password are in `.env` (encrypted by dotenvx).

### What the Agent Sees

During normal operation, the agent never sees raw credentials:
- `.env` on disk contains `encrypted:...` blobs — unreadable without `.env.keys`
- Vault helper commands (`vault.js list-banks`, `vault.js test`) show only item names, first 3 characters of usernames, and password lengths — never full values

**What "in memory" means:** When a sync runs, `dotenvx` decrypts `.env` values into JavaScript variables inside the Node.js process. Those variables are used by the code (e.g., Playwright types them into a bank login form) and discarded when the process exits. The agent does not see these values because the sync runs as a background child process, and the agent only sees what the process prints to stdout. The codebase never prints credentials to stdout — only status messages like `[chase] Login submitted`. The same applies to Bitwarden: credentials flow from `bw get item` → JavaScript variable → Playwright `.fill()` → process exits. No logging, no output, no file written.

### Flow 1: New User With .env Credentials

For users who put bank credentials directly in `.env`:

```
1. User clones repo, creates .env:
   CHASE_USERNAME=myuser
   CHASE_PASSWORD=mypassword

2. User talks to the agent ("sync my accounts", "add a new bank", etc.)

3. Pre-flight runs automatically (scripts/encrypt-env.js):
   - Scans .env for sensitive keys (*_USERNAME, *_PASSWORD, BW_*)
   - Detects CHASE_USERNAME and CHASE_PASSWORD are plaintext
   - Encrypts them via dotenvx → values become encrypted:BKJx...
   - .env.keys created with decryption key (gitignored)

4. .env now looks like:
   CHASE_USERNAME="encrypted:BKJxjW6op8dk..."
   CHASE_PASSWORD="encrypted:BGdMHM+J3s35..."

5. At sync time:
   - dotenvx loads .env, decrypts using .env.keys
   - process.env.CHASE_USERNAME has the plaintext (in memory only)
   - browser-reader.js types it into the login form
   - Process exits, plaintext gone
```

The user never needs to run encryption manually. The pre-flight runs before every sync and catches any new plaintext credentials.

**Important:** All credentials (usernames and passwords) must be single-quoted in `.env` (e.g., `PASSWORD='my#pa$$word'`). Single quotes prevent `#` truncation, `$` interpolation, and backtick expansion. The pre-flight encryption script (`encrypt-env.js`) enforces this automatically, wrapping unquoted values in single quotes before encrypting.

### Flow 2: Setting Up Bitwarden

For users who want credentials in an encrypted vault instead of `.env`:

```
1. User gets Bitwarden API key from vault settings, adds to .env:
   BW_CLIENTID=user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   BW_CLIENTSECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   BW_PASSWORD="MyMasterPassword"

2. User talks to the agent.

3. Pre-flight encrypts all three BW_* values automatically.
   .env now has encrypted blobs — master password is not readable on disk.

4. User asks agent to set up vault mapping:
   - Agent runs: node scripts/vault.js list-banks
   - Output shows item names + first 3 chars of username + Bitwarden item IDs
   - Agent asks user to confirm which items map to which institutions

5. Agent maps each institution:
   - node scripts/vault.js map chase <item-id>
   - node scripts/vault.js map capital-one <item-id>
   - Writes to config/credential-map.json (safe to commit — IDs are not secrets)

6. User removes *_USERNAME/*_PASSWORD from .env (no longer needed).

7. At sync time:
   - sync-all.js unlocks Bitwarden once, shares session with all child processes
   - Each bank's login calls getCredentials(institution, config)
   - getCredentials checks credential-map.json → finds Bitwarden item ID
   - Fetches that specific item from vault → returns { username, password }
   - browser-reader.js types credentials into login form
   - Credentials never logged, never printed, never touch disk
```

### Credential Resolution Order

When `getCredentials(institution, credentials)` is called at login time:

1. Check `config/credential-map.json` for a Bitwarden vault item ID mapped to this institution
2. If found → `bw get item <id>` to fetch credentials from vault
3. If not found or Bitwarden unavailable → fall back to `process.env` (decrypted by dotenvx)

**Agent behavior when setting up a new institution:** Before running any vault commands or asking the user to add credentials, silently check what's already configured:

1. Check `.env` for `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` (via `node scripts/check-env.js --prefix <SLUG>`)
2. If not in `.env`, check `config/credential-map.json` for an existing Bitwarden mapping
3. Only if NEITHER exists, ask the user: "You need to set up credentials for this bank." Do not run `vault.js list-banks`, `vault.js search`, or any vault browsing commands unprompted.

### Vault Scoping

The runtime credential module (`scripts/credentials.js`) can ONLY fetch item IDs explicitly listed in `credential-map.json`. It never runs `bw list`, `bw search`, or browses the vault. Each institution must be explicitly mapped by the user. The vault helper (`scripts/vault.js`) is the only place that searches the vault, and it only runs during setup — never during syncs.

### Pre-flight Encryption

`scripts/encrypt-env.js` runs automatically before every sync. It can also be run manually:

```
node scripts/encrypt-env.js          # encrypt any raw sensitive values
node scripts/encrypt-env.js --check  # check only, exit 1 if raw values found
```

Sensitive key patterns: `*_USERNAME`, `*_PASSWORD`, `BW_PASSWORD`, `BW_CLIENTID`, `BW_CLIENTSECRET`.

API keys (`TELEGRAM_BOT_TOKEN`, `<SLUG>_API_KEY`, etc.) are NOT encrypted — they're revocable tokens, not bank login credentials.

### Vault CLI Helper

`scripts/vault.js` — used during setup only, never during syncs:

```
node scripts/vault.js status              # check bw CLI installed, logged in, vault unlocked
node scripts/vault.js list-banks          # search vault for bank login items (masked output)
node scripts/vault.js search <term>       # search vault for any login item by keyword
node scripts/vault.js map <slug> <id>     # add institution → Bitwarden item mapping
node scripts/vault.js test <slug>         # verify credentials can be fetched (masked output)
node scripts/vault.js migrate             # interactive: match institutions to vault items
```

### Required .env Variables

**For Bitwarden (optional, recommended):**
- `BW_CLIENTID` — Bitwarden API client ID
- `BW_CLIENTSECRET` — Bitwarden API client secret
- `BW_PASSWORD` — Bitwarden master password (must be quoted if it contains `#`)

**For .env-only mode (no Bitwarden):**
- `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` per institution (e.g., `CHASE_USERNAME`, `CHASE_PASSWORD`)

All sensitive values are encrypted at rest by dotenvx. The `.env.keys` file holds the decryption key and is gitignored.

**For Dashboard Mini App (optional):**
- `DASHBOARD_BOT_TOKEN` — only needed if the bot sending the `web_app` button differs from `TELEGRAM_BOT_TOKEN`. Auto-detected from the Claude Code Telegram plugin if installed. See `docs/telegram-setup.md` for details.

## Key Conventions

- **No secrets in repo.** All tokens/keys in `.env` (gitignored). Bank credentials are resolved via Bitwarden vault first, falling back to `.env` env vars. The `.env` convention for credentials is `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` where `<SLUG>` is the institution slug uppercased with hyphens removed (e.g., `chase` → `CHASE`, `capital-one` → `CAPITALONE`, `apple-card` → `APPLECARD`). To check whether credentials are set, use `node scripts/check-env.js CHASE_USERNAME CHASE_PASSWORD` or `node scripts/check-env.js --prefix CHASE`. Do not read `.env` directly.
- **Security gate before credentials.** Domain + HTTPS check before Playwright enters any credentials. Hard abort on failure.
- **Persistent Chrome profiles.** One per institution under `data/chrome-profile/<institution>/`. Sessions survive across runs to reduce MFA frequency.
- **System Chrome preferred.** The browser reader auto-detects system Chrome and uses it over Playwright's Chromium. Real browser fingerprint defeats captchas and bot detection. Falls back to Playwright Chromium if Chrome is not installed.
- **Cookie banner dismissal.** `dismissPopups()` runs before login, after login, and between tasks. Uses a 4-tier selector system: (1) known cookie consent framework IDs, (2) text matching scoped to cookie/consent containers, (3) modal/dialog-scoped dismissals, (4) institution-specific `popupDismissSelectors` from config. No unscoped text matching — prevents accidental clicks on bank actions.
- **Layer 1 first.** All data goes to JSON files. `import.js` transforms to SQLite on demand.
- **Transaction amounts are always signed** from the account holder's perspective (negative = money out). Mortgages and credit card balances are negative.
- **Real estate refreshes monthly.** 25-day staleness threshold. `--force` overrides.
