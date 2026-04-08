---
name: sync
description: Sync all financial institutions — balances, transactions, MFA handling, import, classify
trigger: manual
---

# Sync

When the user says "sync", "update my accounts", "refresh", or "sync my finances" — run the full sync pipeline.

## Critical Execution Model

**NEVER run sync-all.js as a foreground Bash command.** A foreground command blocks the agent from reading messages. MFA codes from the user will sit unprocessed, bank sessions will time out, and the entire sync will fail. This has happened before — do not repeat it.

## Procedure

1. **Notify user immediately:** "Starting sync for all accounts..."

2. **Start sync in background** with `run_in_background: true`:
   ```
   node readers/sync-all.js --import --classify
   ```
   Flags:
   - `--balances` — balances only (faster)
   - `--bank <name>` — single institution only
   - `--import` — import JSON → SQLite after sync
   - `--classify` — classify transactions after import
   - No flags = full sync (balances + transactions, all institutions)

3. **Immediately begin MFA monitoring loop** — do NOT wait for sync to finish:
   ```
   Loop every 3-5 seconds until background task completes:
     a. Run: ls data/mfa-pending/*.request.json  (check for MFA requests)
     b. If request files exist → read each one, build list of banks needing codes
     c. Notify user: "MFA codes needed: [bank1], [bank2], ..."
     d. Wait for user's reply
     e. Parse codes and submit ALL in parallel (see parsing rules below)
     f. Also check: ls data/adaptive-pending/*.json  (visual help requests)
     g. Check if background task completed (TaskOutput)
   ```

4. **When sync completes**, run the extraction step (see below), then report summary to user.

## Post-Sync Extraction

After the sync background task finishes, the agent handles LLM extraction. The sync scripts capture raw text — the agent extracts structured data from it.

Read each `data/sync-output/*.json` file. For any file with a `pendingExtraction` field:

**Balance extraction** (`pendingExtraction.balanceText`):
- Read the raw dashboard page text
- Read `config/accounts.json` for known accounts (last-4 digits, aliases, types)
- Extract structured balances: account name, account type, balance amount (signed — credit/mortgage negative)
- Match each balance to a known account by last-4 digits or name
- Write extracted balances to the `balances` array in the output JSON
- Remove the `pendingExtraction.balanceText` field

**PDF transaction extraction** (`pendingExtraction.pdfTexts`):
- Each entry has: institution, accountId, accountType, fileName, text (LiteParse output)
- Extract structured transactions: date (YYYY-MM-DD), description, amount, currency
- **Preserve amounts as they appear in the source document.** Do NOT interpret or flip signs. If the PDF shows a purchase as `$99.00` (positive), write `99.00`. If it shows a payment as `-$753.56`, write `-753.56`. Sign normalization is handled by `import.js` using `config/data-semantics.json` — the LLM's job is extraction only.
- If amounts include sign indicators (minus sign, parentheses, CR/DR suffix), include the sign in the extracted number. `($8.38)` → `-8.38`. `$753.56 CR` → `-753.56`.
- Append extracted transactions to the `transactions` array in the output JSON
- **Also extract statement balances** from each PDF:
  - Statement period: start date and end date (YYYY-MM-DD)
  - Opening balance (beginning of period) — if available
  - Closing balance (end of period) — required
  - For mortgages: "Principal Balance" is the closing balance (store as negative — it's a liability)
  - Write to `statementBalances` array in the output JSON: `{ accountId, periodStart, periodEnd, openingBalance, closingBalance, source: 'pdf' }`
  - The import pipeline upserts into the `statement_balances` table (dedup on institution + account_id + period_end)
- Remove the `pendingExtraction.pdfTexts` field

**Statement balance extraction** (`pendingExtraction.statementPdfs`):
- Each entry has: accountId, accountType, fileName, text (LiteParse output), source ('pdf')
- For EACH PDF, extract:
  - Statement period start date (YYYY-MM-DD) — look for "through", "Statement Period", date ranges
  - Statement period end date (YYYY-MM-DD) — the closing date
  - Opening/beginning balance — "Beginning Balance", "Previous Balance"
  - Closing/ending balance — "Ending Balance", "New Balance", "Principal Balance"
- For credit cards: "New Balance" is the closing balance, "Previous Balance" is the opening
- For mortgages: "Principal Balance (Not a Payoff Amount)" is the closing balance — store as NEGATIVE
- Write to `statementBalances` array in the output JSON: `{ accountId, periodStart, periodEnd, openingBalance, closingBalance, source: 'pdf' }`
- Remove the `pendingExtraction.statementPdfs` field

**Real estate extraction** (`pendingExtraction.pageTexts` + `pendingExtraction.address`):
- Each entry has: source (Google/Zillow/Redfin), text (page text)
- Extract the estimated property value from each source
- Average the values
- Write to `balances` array as: accountId "home-residence", accountType "real_estate", balance = average value
- Remove the `pendingExtraction` field

After all extractions, remove the `pendingExtraction` field from each output file. Then run import + classify:
```bash
node sync-engine/import.js
node sync-engine/classify.js
```

Import automatically validates transaction signs against known anchors in `config/data-semantics.json`. If validation warnings appear (e.g., "TARGET is a debit but has positive amount"), the data semantics for that institution may need updating — check `config/data-semantics.json` and verify the platform hasn't changed its sign convention.

## MFA Code Parsing

Users provide codes in flexible formats:
- `BankA 123456, BankB 7654321`
- `banka: 123456 bankb: 7654321`
- `123456 7654321` (in order of request)

Map institution names flexibly — see `config/institutions-status.md` for the name mapping table.

Submit via:
```bash
node -e "require('./readers/mfa-bridge').submitCode('<institution>', '<code>')"
```

**Submit ALL codes in parallel** — do NOT wait between submissions. Bank sessions time out.

## Adaptive Help

When the browser primitive encounters an unknown page state, it writes a help request to `data/adaptive-pending/`. The request includes an annotated screenshot and page URL.

- Read the screenshot and describe what you see to the user
- Ask the user what action to take
- Send instructions back to the adaptive bridge

### Task-Error Requests

When a task (balances or transactions) fails during execution, the graduated recovery system may write a `type: 'task-error'` request to `data/adaptive-pending/`. This is distinct from `type: 'unknown-state'` requests (login-phase).

The request includes:
- `task` — which task failed (`balances` or `transactions`)
- `step` — where in the task it failed (e.g., `extract-dashboard-text`, `download-transactions`)
- `failedSelector` — the Playwright selector that timed out (if applicable)
- `error.category` — classification: `timeout`, `selector-not-found`, `navigation`, `maintenance`, `session-expired`, `unknown`
- `page.url` — current page URL
- `page.textSnippet` — first 2000 chars of visible page text
- `screenshot` — path to annotated screenshot
- `elements` — interactive elements on the page

To respond, submit instructions the same way as unknown-state requests:
```bash
node -e "require('./readers/adaptive-bridge').submitInstruction('<institution>', { actions: [...] })"
```

Actions can include: `click` (with `selector`), `type` (with `selector` + `text`), `evaluate` (with `code`), `navigate` (with `url`), `wait` (with `ms`), `key` (with `key`).

The recovery system has a 60s timeout for Level 3 adaptive requests (vs 300s for login adaptive). If no instruction arrives, it skips the task, preserves partial data, and sends a Telegram notification.

## Sync Script Telegram Backup

The sync script sends its own notification via the bot API when MFA is detected. This is a backup — the agent MUST still poll the bridge directory, because the script notification may fail silently.

## Data Integrity Safeguards

- Failed syncs never overwrite good data — previous balances are preserved
- Balance sanity check: warns if any account balance changed >50% from last sync
- Zero-balance protection: if new sync returns 0 balances but previous had data, previous data is kept
- API token expiry: warns when refresh tokens expire within 2 days
- Each output file has `syncedAt` and `previousSyncedAt` for staleness tracking
- Real estate refreshes monthly (25-day staleness threshold)

## Summary Format

After sync completes, report:
```
SYNC COMPLETE

Institution      Status    Balances  Transactions  Time
─────────────────────────────────────────────────────────
BankA            ✓         4         12            45s
BankB            ✓         2         8             38s
BankC            ✓         1         5             52s
BankD            ✓ (API)   2         15            2s
BankE            ✗ MFA timeout                     —
...

Imported: 24 balances, 40 transactions → SQLite
Classified: 35 new transactions categorized

⚠ BankE: MFA code not received within timeout
✓ All other institutions synced successfully
```

## Key Commands

```
node readers/sync-all.js --import --classify     # full pipeline
node readers/sync-all.js                         # sync only (JSON staging)
node readers/sync-all.js --balances              # balances only (faster)
node sync-engine/import.js                       # import JSON → SQLite (independent)
node sync-engine/classify.js                     # classify transactions (independent)
node sync-engine/classify.js --stats             # classification breakdown
node readers/run.js <bank> --balances            # single bank balances
node readers/run.js <bank> --transactions        # single bank transactions
```
