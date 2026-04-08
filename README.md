<p align="center">
  <img src="assets/logo-wordmark.svg" alt="Foliome — Open-Source Agent-Powered Financial Intelligence">
</p>

An open-source alternative to paid data aggregators and manual CSV downloads. Your AI agent logs into your banks, handles MFA, downloads transactions, recovers from errors, and gives you complete financial intelligence. Zero paid APIs. Local-first. You own your data.

## How it works

You give your agent a bank URL. It visually explores the site, discovers the login flow, MFA patterns, and transaction download path, then writes a deterministic Playwright config. After that, daily syncs run automatically — no LLM cost, no screenshots, no API calls. The agent only returns when something breaks.

```
SETUP (one-time per institution)
  Agent explores bank website → discovers login, MFA, download patterns
  → writes deterministic Playwright config (zero LLM cost on future runs)

DAILY SYNC (automated)
  ┌─────────────────────────────────────────────────────────────┐
  │  Browser Reader (Playwright)          API Connectors        │
  │  login → MFA → download CSVs/PDFs    REST API fetch         │
  │  capture dashboard text               (no browser needed)   │
  └──────────────────┬────────────────────────┬─────────────────┘
                     v                        v
              data/sync-output/*.json  (Layer 1 — raw JSON per institution)
                     │
                     v
              sync-engine/import.js  →  classify.js
              normalize + dedup         local DistilBERT model
                     │
                     v
              data/foliome.db  (Layer 2 — SQLite)
              balances · transactions · holdings · statement_balances
                     │
          ┌──────────┼──────────────┐
          v          v              v
       Skills     Dashboard      Wiki
       /sync      React Mini    Agent memory
       /brief-me  App served    (goals, patterns,
       /alerts    via Telegram   preferences)
```

**Layer 1 (JSON):** Raw sync output per institution. Human-reviewable, schema-agnostic.

**Layer 2 (SQLite):** Normalized schema. Tables: `balances`, `transactions`, `investment_transactions`, `holdings`, `statement_balances`, `sync_status`.

## Your agent builds its own integrations

Foliome ships primitives and a skill (`/learn-institution`) that builds integrations with any institution. The agent visually explores the bank's website, identifies the login flow, MFA pattern, and transaction download path, then writes a deterministic Playwright config. Anonymized templates in `readers/institutions/templates/` cover the most common combinations — the agent checks these first, then verifies against the live site.

The system handles the full spectrum of bank website complexity:

- **Login flows** — from simple username/password forms to iframe-embedded logins, multi-step authentication, landing pages that reveal hidden forms, frame-busting iframes, and passkey enrollment interstitials
- **MFA methods** — SMS, email, push notifications, TOTP authenticator apps, device codes with individual digit inputs, and multi-method selection flows. Codes are exchanged via a file-based MFA bridge for background operation
- **Transaction extraction** — CSV downloads (central dialogs, per-account pages, export modals, date pickers, single-button exports, async report generation), PDF statement parsing via LiteParse + agent extraction, and REST API connectors
- **Error recovery** — graduated 4-level system: automatic retry → self-recovery (dismiss popups, navigate to dashboard) → adaptive bridge (agent-assisted via annotated screenshots) → skip with notification

A [pattern guide](readers/institutions/templates/GUIDE.md) provides lookup tables for login flows, MFA types, download patterns, statement balance extraction, custom web components, and common obstacles with their solutions.

## Quick start

### Prerequisites

The `./setup` script checks for all dependencies and installs what it can:

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | 18+ | Runtime |
| Claude Code CLI | latest | Agent runtime |

Playwright Chromium, npm packages, SQLite, and the classifier model are all installed automatically by `./setup`.

### Setup

```bash
git clone <repo-url> && cd foliome
./setup                    # single command — checks everything, installs what it can
# Edit .env with your credentials (setup creates it from template)
```

`./setup` is idempotent — safe to run on first install and after every `git pull`. Use `./setup --yes` to auto-accept all prompts, or `./setup --skip-model` to skip the ~256MB classifier download.

### Add your first bank

```bash
claude                     # start Claude Code in this directory
/getting-started           # guided first-bank setup (or /learn-institution for direct control)
```

The `/getting-started` skill walks you through the entire flow: credentials, bank exploration, first sync, MFA, balance extraction, and import. Takes about 30-45 minutes for the first bank.

### Run

```bash
# Full pipeline: sync all institutions, import to SQLite, classify transactions
node readers/sync-all.js --import --classify

# Single institution
node readers/sync-all.js --bank <name>

# Balances only (faster)
node readers/sync-all.js --balances
```

Or use the `/sync` skill from Claude Code — it handles background execution, MFA polling, and progress reporting automatically.

### Telegram interface (optional)

Requires Bun and the Claude Code Telegram plugin. See [docs/telegram-setup.md](docs/telegram-setup.md) for full setup.

```bash
claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions
```

A Telegram Mini App dashboard is also available — a responsive React SPA with tabs for net worth overview, transaction analysis, budgets, portfolio holdings, subscriptions, and an agent knowledge base wiki. The Brief tab is the landing page — a personalized daily financial narrative powered by agent memory and live data. Responsive layout adapts from mobile (Telegram WebView) to full-page (desktop browser). The server validates requests via Telegram's HMAC-SHA256 initData, issues session tokens for API calls, and auto-detects the correct bot token. See [docs/telegram-setup.md](docs/telegram-setup.md#dashboard-mini-app-optional) for setup.

## What your agent can do with your data

Once the data layer is synced, a library of skills in `.claude/skills/` provides financial intelligence. All skills work from both desktop (terminal) and mobile (Telegram).

- **Infrastructure** — `/sync` runs all institutions in parallel with MFA handling. `/learn-institution` builds new integrations interactively. `/getting-started` walks new users through their first bank.
- **Awareness** — `/morning-brief` generates a daily financial summary. `/spending-alerts` monitors for large charges and low balances. `/payment-reminders` tracks credit card due dates.
- **Query** — `/brief-me` answers on-demand questions about spending, portfolio, and trends with optional CSV export.
- **Dashboard** — `/custom-view` builds new dashboard tabs from natural language requests.
- **Management** — `/category-override` reclassifies transactions via natural language. `/reflect` maintains the agent's knowledge wiki.

## Transaction classification

Local-only pipeline, no API calls. A tiered classification system handles every transaction:

0. **Account-type-implied** — mortgage, auto loan, student loan, etc. skip the model entirely
1. **Merchant rules** — pattern matching on description (user-defined overrides, highest trust)
2. **Fine-tuned DistilBERT** — local classifier trained on synthetic US bank transaction data, with cache for previously seen merchants ([model on HuggingFace](https://huggingface.co/DoDataThings/distilbert-us-transaction-classifier-v2))
3. **Bank category fallback** — if model confidence < 0.70 and the bank provided a usable category

## Statement balances

Historical period-end closing balances for "vs. Last Period" comparison. The dashboard shows `current_balance - statement_closing_balance` per account — green if improving, red if worsening.

Statement balances are extracted from whatever source each institution provides — PDF statements, HTML statement pages, dashboard text, CSV balance columns, or not available (investment/education accounts). The extraction method is discovered automatically during `/learn-institution` setup. No manual configuration needed. See the [pattern guide](readers/institutions/templates/GUIDE.md) for details on each extraction method.

## Security model

Foliome handles bank credentials and financial data. The security model is designed so that credentials are never visible to the agent, never logged, and never stored as plaintext at rest.

- **Credentials encrypted at rest** — bank login credentials in `.env` are automatically encrypted via [dotenvx](https://dotenvx.com) before every sync. Decrypted only in process memory at runtime, then discarded on exit. Optional Bitwarden vault integration fetches credentials at login time so they never touch `.env` at all.
- **Security gate** — domain + HTTPS verification before Playwright enters any credentials. Hard abort on mismatch.
- **Agent never sees credentials** — syncs run as background child processes. The agent only sees status messages in stdout. No credential values are printed, logged, or written to files.
- **Content Security Policy** — all dashboard responses include CSP headers. Wiki markdown rendered without raw HTML. Blocked protocols, no external images, path-confined asset serving.
- **Session security** — Telegram initData validated via HMAC-SHA256 with timing-safe comparison and replay protection.
- **Data integrity** — failed syncs never destroy good data. Zero-balance protection, dedup on import, balance sanity checks.

See [docs/security.md](docs/security.md) for the full security architecture — credential lifecycle, encryption enforcement, browser isolation, content security, session management, and what's gitignored.

## How this differs from Computer Use

Foliome does not use Claude's Computer Use (screenshot-per-action). It uses a hybrid approach: deterministic Playwright configs for 95%+ of daily runs (zero LLM cost), with an agent vision fallback for edge cases. See [docs/how-browser-automation-works.md](docs/how-browser-automation-works.md) for the full architecture comparison.

## Project structure

```
.claude/skills/
  getting-started/              Guided first-bank setup for new users
  sync/                         Full sync orchestration with MFA handling
  learn-institution/            Build new bank integrations interactively
  morning-brief/                Daily financial summary
  brief-me/                     On-demand financial briefing (spending, portfolio, reports)
  spending-alerts/              Large charge and low balance monitoring
  payment-reminders/            Credit card due date tracking
  category-override/            Transaction category overrides
  custom-view/                  Build custom dashboard tabs from natural language
  reflect/                       Wiki maintenance (consolidate, update, discover patterns)
readers/                        Browser automation primitives
  browser-reader.js             Config-driven login/extraction engine
  run.js                        CLI entry point
  sync-all.js                   Parallel sync orchestrator
  mfa-bridge.js                 File-based MFA code exchange
  adaptive-bridge.js            Visual help for unknown page states
  recovery.js                   Graduated error recovery (retry, self-recover, adaptive, skip)
  annotate.js                   Element discovery and numbered labels
  account-matcher.js            Account matching by last-4 + aliases
  sanitize-text.js              Prompt injection defense (hidden element stripping + boundary markers)
  explore-interactive.js        Interactive visual explorer (step-by-step with annotated screenshots)
  institutions/                 Per-bank Playwright configs (created by /learn-institution)
    templates/                  Anonymized pattern templates covering common login/MFA/download combos
      GUIDE.md                  Pattern lookup tables, obstacle cheat sheet, component index
  tasks/
    extract-balances.js         Dashboard text capture for agent extraction
    download-transactions.js    All transaction download patterns + PDF pipeline
    download-statements.js      Statement PDF downloads for balance extraction
    PATTERNS.md                 Visual guide to transaction download patterns
connectors/                     API integrations (no browser)
sync-engine/                    Layer 2 persistence
  import.js                     JSON --> SQLite with normalization + dedup
  classify.js                   Transaction classifier (account-type → rules → model → bank fallback)
  security-gate.js              Domain + HTTPS verification
dashboard/                      React SPA (Vite + TypeScript + Tailwind + shadcn)
  src/tabs/                     Brief, Overview, Transactions, Budget, Portfolio, Subscriptions, Wiki
  src/components/               Shared components + Financial Health overlay
  dist/                         Build output (gitignored), served by dashboard-server
scripts/
  dashboard.js                  Legacy HTML dashboard generator (backward compat)
  dashboard-queries.js          Extracted SQL query functions for API + legacy
  dashboard-server.js           Telegram Mini App server (auth, API routes, static serving)
  wiki-queries.js               Wiki data access (frontmatter parsing, path confinement)
  credentials.js                Credential resolution (Bitwarden vault → .env fallback)
  encrypt-env.js                Pre-flight encryption for sensitive .env values
  validate-data.js              Data validation (semantics, normalization, database invariants)
config/                         Configuration
  institutions-status.md        Per-institution status, MFA details, download patterns
  budgets.json                  Monthly budget limits per category (for Budget tab)
data/                           All gitignored
  sync-output/                  Layer 1 JSON files
  foliome.db                    Layer 2 SQLite database
  brief/                        Daily brief JSON files (latest.json + dated archives)
  wiki/                         Agent memory wiki (goals, preferences, patterns)
  exports/                      Skill-generated CSV exports
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `playwright` | Browser automation |
| `better-sqlite3` | SQLite for Layer 2 |
| `@xenova/transformers` | Local transaction classifier (fine-tuned DistilBERT via ONNX) |
| `node-telegram-bot-api` | Telegram notifications |
| `googleapis` | Gmail API for email MFA |
| `@dotenvx/dotenvx` | Environment variable loading with encryption at rest |

## License

Apache-2.0
