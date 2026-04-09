# Config Templates

Starter configuration files. The `setup` script copies these to `config/` on first run (won't overwrite existing files). After copying, `config/` is gitignored — your customizations stay local.

## Files

### accounts.json
Account registry — maps bank accounts to stable identifiers. **Starts empty.** Populated automatically during `/sync` as the agent discovers accounts. Each entry has `accountId`, `bankName`, `accountType`, `last4` (strongest match key), and `aliases` (accumulated display names).

### credential-map.json
Maps institution slugs to Bitwarden vault item IDs. **Starts empty.** Populated by `scripts/vault.js map <slug> <id>` during Bitwarden setup. Safe to commit — item IDs aren't secrets. Not needed if using `.env`-only credentials.

### payment-schedule.json
Credit card payment due dates for the `/payment-reminders` skill. **Starts empty.** Add entries manually or let the agent populate it from conversation ("my Chase card is due on the 15th").

### budgets.json
Monthly spending limits per category for the Budget dashboard tab. Pre-populated with round-number defaults. Edit to match your budget:

```json
{ "Restaurants": 500, "Groceries": 400, "Shopping": 300, ... }
```

### alert-config.json
Thresholds for the `/spending-alerts` skill. Pre-populated with sensible defaults:

| Setting | Default | What it does |
|---------|---------|-------------|
| `large_transaction_threshold` | 500 | Alert on charges over this amount |
| `low_balance_threshold` | 1000 | Alert when any account drops below this |
| `unusual_spending_multiplier` | 3 | Alert on category spending 3x the recent average |
| `stale_data_hours` | 48 | Alert if last sync is older than this |
| `payment_reminder_days` | 5 | Remind this many days before a payment is due |

### category-overrides.json
Transaction classification rules. Pre-populated with common merchant patterns (Starbucks, Amazon, Netflix, etc.) and the default category lists. Add your own merchant rules to override the ML classifier:

```json
"merchant_rules": [
  { "pattern": "ZELLE TO KATIE", "category": "Rent" },
  { "pattern": "VENMO JOHN", "category": "Transfer" }
]
```

### schedules.json
Recurring task schedules for `/foliome-loop`. **Starts empty.** Populated when the user creates recurring tasks (e.g., "sync non-MFA banks every day at 6am"). Each entry has a cron expression, the command/prompt to run, failure tracking, and auto-suspend state. Re-registered via CronCreate on every agent startup.

### data-semantics.json
Per-institution sign conventions and column mappings. **Starts with schema only, no institutions.** Populated by `/learn-institution` (Q9) as each bank's CSV format is discovered. Tells `import.js` how to normalize raw transaction amounts to the canonical convention (debits negative, credits positive).
