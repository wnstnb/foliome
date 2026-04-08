# Sync Engine (Layer 2)

Transforms raw JSON sync output (Layer 1) into a normalized SQLite database (Layer 2). Three files, run in order:

## Pipeline

```
data/sync-output/*.json  →  import.js  →  classify.js  →  data/foliome.db
```

1. **`import.js`** — Reads all institution JSON files, normalizes amounts via `config/data-semantics.json`, deduplicates transactions, and upserts into SQLite. Also imports balances, holdings, investment transactions, and statement balances.

2. **`classify.js`** — Assigns categories to unclassified transactions. Pipeline: account-type-implied → merchant rules → sign-prefixed DistilBERT model → bank category fallback. See `docs/classification.md` for full details.

3. **`security-gate.js`** — Domain + HTTPS verification called by the browser reader before entering credentials. Not part of the import pipeline — used at login time.

## Usage

```bash
node sync-engine/import.js                    # import all institutions
node sync-engine/import.js --bank chase       # import one institution
node sync-engine/import.js --init             # create database schema only

node sync-engine/classify.js                  # classify unclassified transactions
node sync-engine/classify.js --force          # reclassify everything
node sync-engine/classify.js --stats          # show classification breakdown
```

## Database Tables

| Table | Contents |
|-------|----------|
| `balances` | Balance snapshots per account per sync (historical) |
| `transactions` | Day-to-day transactions (checking, savings, credit, mortgage) |
| `investment_transactions` | Trades, dividends, contributions (brokerage, retirement, education) |
| `holdings` | Investment positions per account per sync |
| `statement_balances` | Period-end closing balances from statements |
| `sync_status` | Last sync result per institution |

## Key Conventions

- **Dedup key:** `institution + account_id + raw_transaction_id` (API sources) or `institution + account_id + date + amount + description_hash` (CSV sources)
- **Amount signs:** Debits negative, credits positive, liability balances negative, asset balances positive
- **Latest balance query:** Use `MAX(synced_at)` per account, not `SUM` of all historical snapshots
