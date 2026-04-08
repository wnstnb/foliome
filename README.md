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
       /brief-me  App (7 tabs)  (goals, patterns,
       /alerts    via Telegram   preferences)
```

**Layer 1 (JSON):** Raw sync output per institution. Human-reviewable, schema-agnostic.

**Layer 2 (SQLite):** Normalized schema. Tables: `balances`, `transactions`, `investment_transactions`, `holdings`, `statement_balances`, `sync_status`.

## Your agent builds its own integrations

Foliome ships primitives and a skill (`/learn-institution`) that builds integrations with any institution. The agent visually explores the bank's website, identifies the login flow, MFA pattern, and transaction download path, then writes a deterministic Playwright config. Anonymized templates in `readers/institutions/templates/` cover the most common combinations — the agent checks these first, then verifies against the live site. A [pattern guide](readers/institutions/templates/GUIDE.md) provides lookup tables for every pattern below, plus common obstacles and their solutions.

**Login patterns** — how the agent gets in:

| Pattern | Description |
|---------|-------------|
| Direct login | Username + password on the main page |
| Iframe login | Login form inside an `<iframe>` (common with banking frameworks) |
| Multi-step login | Email → Continue → method selection → password |
| Landing page login | "Sign In" button on marketing page reveals the actual form |
| Frame-busting iframe | Iframe login where the parent page navigates away after submit |
| WebAuthn/passkey bypass | Skip passkey enrollment interstitials via CDP virtual authenticator |

**MFA patterns** — how the agent handles second factors:

| Pattern | Description |
|---------|-------------|
| SMS / Email | Click initiation button → wait for code → enter via MFA bridge |
| Push notification | Select push option → poll for clearance (up to 180s) |
| Device code | 6-digit code sent to trusted device → individual digit input fields |
| TOTP | Authenticator app code → single input field |
| Multi-method | Method selection tiles (SMS / push / call) → route to appropriate handler |
| Email auto-poll | Gmail API extracts code automatically, falls back to SMS |

**Transaction download patterns** — how the agent gets data out:

| Pattern | Description |
|---------|-------------|
| A | CSV from central download dialog with account dropdown |
| B | Per-account CSV download (navigate to each account) |
| C | PDF statements + LiteParse text extraction + agent parsing |
| D | Export modal with calendar date picker |
| E | Direct single-button export |
| F | Report-based async generation (create, wait, download) |

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

A Telegram Mini App dashboard is also available — a React SPA with 7 tabs (Brief, Overview, Transactions, Budget, Portfolio, Subscriptions, Wiki), interactive filters, category drill-downs, a Financial Health overlay, and a read-only wiki browser for the agent's knowledge base. The Brief tab is the landing page — a personalized daily financial narrative powered by agent memory and live data. The server validates requests via Telegram's HMAC-SHA256 initData, issues session tokens for API calls, and auto-detects the correct bot token. See [docs/telegram-setup.md](docs/telegram-setup.md#dashboard-mini-app-optional) for setup.

## What your agent can do with your data

Once the data layer is synced, 10 skills provide financial intelligence:

| Category | Skill | What it does |
|----------|-------|-------------|
| **Infrastructure** | `/sync` | Sync all institutions — background execution, MFA handling, import, classify |
| **Infrastructure** | `/learn-institution` | Build a new bank integration by visually exploring the login flow |
| **Infrastructure** | `/getting-started` | Guided first-bank setup for new users |
| **Awareness** | `/morning-brief` | Daily summary — net worth, recent activity, due dates, alerts |
| **Awareness** | `/spending-alerts` | Detect large charges, low balances, unusual spending |
| **Awareness** | `/payment-reminders` | Credit card payment due dates with tiered alerts |
| **Query** | `/brief-me` | On-demand financial briefing — spending, portfolio, reports, CSV export |
| **Dashboard** | `/custom-view` | Build a custom dashboard tab from a natural language request |
| **Management** | `/category-override` | Reclassify transactions via natural language |
| **Maintenance** | `/reflect` | Wiki maintenance — consolidate, update goals, discover patterns |

All skills work from both desktop (terminal) and mobile (Telegram).

## Transaction classification

Local-only pipeline, no API calls. 17 transaction-level categories plus 6 account-type-implied categories:

0. **Account-type-implied** — mortgage, auto loan, student loan, etc. skip the model entirely
1. **Merchant rules** — pattern matching on description (user-defined overrides, highest trust)
2. **Fine-tuned DistilBERT** — local classifier trained on synthetic US bank transaction data, with cache for previously seen merchants ([model on HuggingFace](https://huggingface.co/DoDataThings/distilbert-us-transaction-classifier-v2))
3. **Bank category fallback** — if model confidence < 0.70 and the bank provided a usable category

## Statement balances

Historical period-end closing balances for "vs. Last Period" comparison. The dashboard shows `current_balance - statement_closing_balance` per account — green if improving, red if worsening. Five extraction patterns:

| Pattern | Source | How |
|---------|--------|-----|
| S-A | PDF statements | Parse opening/closing balances from downloaded PDFs |
| S-B | HTML statement list | Statement page shows balances inline in page text |
| S-C | Dashboard text | "Last statement balance" label on dashboard |
| S-D | Not available | No statement concept (investment/education accounts) |
| S-E | CSV balance column | Running balance in transaction CSV + month-end anchor |

Discovered automatically during `/learn-institution` (Q10-Q15). No manual configuration needed.

## Security model

- All credentials in `.env` (gitignored) — the agent never needs to see credential values
- Security gate: domain + HTTPS verification before entering credentials
- Persistent Chrome profiles reduce MFA frequency
- Graduated error recovery: retry, self-recover, adaptive bridge, skip + notify
- Parameterized SQL for all database writes
- 4-tier popup dismissal (no unscoped text matching)
- Transient MFA bridge files cleaned up after use

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
    templates/                  Anonymized pattern templates (9 proven patterns)
      GUIDE.md                  Pattern lookup tables, obstacle cheat sheet, component index
  tasks/
    extract-balances.js         Dashboard text capture for agent extraction
    download-transactions.js    6 download patterns (A-F) + PDF pipeline
    download-statements.js      Statement PDF downloads for balance extraction
    PATTERNS.md                 Visual guide to all 6 transaction download patterns
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
