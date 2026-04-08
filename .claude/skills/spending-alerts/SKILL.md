---
name: spending-alerts
description: Monitor transactions for large charges, low balances, and unusual activity
trigger: manual
---

# Spending Alerts

Check for alert conditions after each sync. Report if any trigger.

## Prerequisites

Check that `data/foliome.db` exists. If not, respond: "No financial data found. Run /sync first to populate your accounts."

## Alert Conditions

**Large transaction:** Any single transaction over $500 (configurable)
```sql
SELECT date, description, ABS(amount) as amount, institution, user_category
FROM transactions
WHERE ABS(amount) > 500
AND date >= date('now', '-1 day')
AND amount < 0
```

**Low balance:** Checking account drops below $1,000
```sql
SELECT b.account_name, b.balance FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.ms
WHERE b.account_type = 'checking' AND b.balance < 1000
```

**Unusual spending:** Daily spend exceeds 3x the 30-day average
```sql
WITH daily AS (
  SELECT date, SUM(ABS(amount)) as day_total
  FROM transactions WHERE amount < 0
  GROUP BY date
),
avg30 AS (
  SELECT AVG(day_total) as avg_daily FROM daily
  WHERE date >= date('now', '-30 days')
)
SELECT d.date, d.day_total, a.avg_daily
FROM daily d, avg30 a
WHERE d.date = date('now') AND d.day_total > a.avg_daily * 3
```

**Sync failure:** Any institution failed to sync
```sql
SELECT institution, status, last_error, last_attempt
FROM sync_status WHERE status = 'failed'
```

**Stale data:** Any institution not synced in 48+ hours
```sql
SELECT institution, last_success
FROM sync_status
WHERE last_success < datetime('now', '-48 hours')
```

## When to Run

After each `sync-all.js --import` completes. The Telegram agent should check these conditions and proactively message if any trigger.

## User Configuration

Users can set thresholds via Telegram:
- "Alert me on transactions over $1,000" → update large transaction threshold
- "Warn me if checking drops below $2,000" → update low balance threshold

Store thresholds in `config/alert-config.json`.
