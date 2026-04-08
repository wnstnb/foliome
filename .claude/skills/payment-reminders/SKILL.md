---
name: payment-reminders
description: Track credit card payment due dates and alert before they're due
trigger: manual
---

# Payment Reminders

Check for upcoming credit card payments and alert the user.

## Prerequisites

Check that `data/foliome.db` exists. If not, respond: "No financial data found. Run /sync first to populate your accounts."

## Data Freshness

After querying balances, check staleness:
- Data 24-48h old → note: "[Institution] data is [X] hours old. Balance may not reflect recent payments."
- Data >48h old → prominent warning: "[Institution] data is [X] days old — balance may be outdated."
- Never refuse to answer due to staleness.

## Data Sources

Payment due dates come from two places:

1. **Balance sync data** — some banks include due dates in the dashboard text that the LLM extracts. Check the `raw` JSON in `data/sync-output/*.json` for fields mentioning "payment due", "due date", "minimum payment".

2. **Known payment schedules** — track in `config/payment-schedule.json`:
```json
{
  "bankname-credit-1234": { "due_day": 5, "account_name": "Credit Card A" },
  "bankname-credit-5678": { "due_day": 20, "account_name": "Credit Card B" },
  "bankname-credit-9012": { "due_day": 31, "account_name": "Credit Card C" }
}
```

## Check Logic

For each credit card account:
1. Get the current balance (latest from `balances` table)
2. Get the due date (from payment schedule or extracted from sync data)
3. If due within 5 days → alert
4. If due within 3 days → urgent alert
5. If overdue → critical alert

## Query

```sql
SELECT b.account_id, b.account_name, b.balance
FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.ms
WHERE b.account_type = 'credit'
AND b.balance < 0
```

## Alert Format

```
PAYMENT REMINDERS

⚠ Credit Card A — $850.00 due March 20 (TODAY)
⚠ Credit Card B — $215.00 due March 20 (TODAY)
📅 Credit Card C — $1,200.00 due April 5 (16 days)
📅 Credit Card D — $475.50 due March 31 (11 days)
```

## Via Telegram

- "What payments are due?" → show all upcoming
- "When is my Sapphire payment due?" → show specific card
- User can update due dates: "My Freedom payment is due on the 5th"
