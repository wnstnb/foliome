---
name: brief-me
description: On-demand financial briefing — spending, balances, portfolio, transactions, reports, CSV export
trigger: manual
---

# Brief Me

When the user asks about their finances — spending, balances, transactions, portfolio, holdings, categories, cash flow — query SQLite and brief them. This is the on-demand counterpart to `/morning-brief`: the morning brief is a proactive daily narrative; `/brief-me` is reactive, answering whatever financial question the user has right now.

Covers the full range from quick Q&A ("how much on restaurants?") to structured reports ("spending breakdown for March with CSV export") to portfolio deep-dives ("what's in my 401k?").

## Prerequisites

Check that `data/foliome.db` exists. If not, respond: "No financial data found. Run /sync first to populate your accounts."

## Data Freshness

After querying, check staleness for relevant accounts:
- Data 24-48h old → note: "[Institution] data is [X] hours old. Run /sync to refresh."
- Data >48h old → prominent warning: "[Institution] data is [X] days old — last sync may have failed. Results may be inaccurate."
- Never refuse to answer due to staleness. Show data with warnings.

## Spending Questions

**"How much did I spend on X?"**
```sql
SELECT SUM(ABS(amount)) as total, COUNT(*) as cnt
FROM transactions
WHERE user_category = '{category}'
AND date >= '{start_date}'
AND amount < 0
```

**"Show me my restaurant spending this month"**
```sql
SELECT date, description, amount, institution
FROM transactions
WHERE user_category = 'Restaurants'
AND date >= date('now', 'start of month')
ORDER BY date DESC
```

**"What's my biggest expense this week?"**
```sql
SELECT date, description, amount, user_category, institution
FROM transactions
WHERE date >= date('now', '-7 days')
AND amount < 0
ORDER BY amount ASC
LIMIT 5
```

**"How much did I earn this month?"**
```sql
SELECT SUM(amount) as total, COUNT(*) as cnt
FROM transactions
WHERE amount > 0
AND date >= date('now', 'start of month')
AND user_category = 'Income'
```

**"Show me all Amazon transactions"**
```sql
SELECT date, description, amount, user_category
FROM transactions
WHERE description LIKE '%AMAZON%'
ORDER BY date DESC
LIMIT 20
```

**"What's my cash flow this month?"**
```sql
SELECT
  SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as income,
  SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as expenses,
  SUM(amount) as net
FROM transactions
WHERE date >= date('now', 'start of month')
```

**"How much do I owe on credit cards?"**
```sql
SELECT account_name, balance FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.ms
WHERE account_type = 'credit'
```

## Structured Spending Reports

When the user asks for a breakdown, report, or analysis — "break down my spending for March", "monthly spending report", "compare this month to last month" — produce a structured report.

### Excluded Categories

**Transfer** and **Income** are excluded from spending analysis by default:
- **Transfer** — credit card autopays, mortgage payments, savings transfers, Zelle sends. Money movement between accounts, not discretionary spending.
- **Income** — payroll deposits, refunds, interest. Not spending. If negative-amount transactions appear categorized as "Income", flag them as likely miscategorized and suggest /category-override.

If the user explicitly asks to include transfers or income, add them back.

### Category Breakdown

Spending by category for the requested period (default: last 30 days):
```sql
SELECT user_category, SUM(amount) as total, COUNT(*) as txn_count,
  ROUND(SUM(amount) * 100.0 / (SELECT SUM(amount) FROM transactions WHERE amount < 0 AND user_category NOT IN ('Transfer', 'Income') AND date >= '{start}' AND date <= '{end}'), 1) as pct
FROM transactions
WHERE amount < 0
AND user_category NOT IN ('Transfer', 'Income')
AND date >= '{start_date}'
AND date <= '{end_date}'
GROUP BY user_category
ORDER BY total ASC
```

### Top Merchants

```sql
SELECT description, SUM(amount) as total, COUNT(*) as txn_count, user_category
FROM transactions
WHERE amount < 0
AND user_category NOT IN ('Transfer', 'Income')
AND date >= '{start_date}' AND date <= '{end_date}'
GROUP BY description
ORDER BY total ASC
LIMIT 10
```

### Period-over-Period Comparison

Compare current period to previous period of same length:
- This month vs. last month
- This week vs. last week
- Custom: any date range vs. the equivalent prior period

Show: category, current total, previous total, change ($), change (%)

### Grouping Options

If user requests grouping by institution or by week/month, adjust the `GROUP BY` accordingly.

### Report Output Format

```
SPENDING ANALYSIS: March 1 - March 26, 2026

TOTAL SPENDING: -$2,847.32 (48 transactions)

BY CATEGORY
  Category         Amount      Txns    % of Total
  ─────────────────────────────────────────────────
  Restaurants      -$485.20     12     17.0%
  Shopping         -$412.50      8     14.5%
  Groceries        -$380.00     15     13.3%
  Subscription     -$245.99      6      8.6%
  ...

TOP MERCHANTS
  1. WHOLE FOODS     -$245.00  (5 txns)
  2. AMAZON          -$198.50  (3 txns)
  3. UBER EATS       -$156.80  (4 txns)

vs. LAST MONTH (Feb 1-26)
  Total: -$2,615.80 (+$231.52, +8.9%)
  Restaurants:  -$320.00 → -$485.20 (+51.6%)
  Shopping:     -$510.00 → -$412.50 (-19.1%)

UNCATEGORIZED: 3 transactions (-$89.50)
  → Run /category-override to classify these
```

### CSV Export (opt-in)

If user says "export", "save CSV", "download", or "export as CSV":

Write to `data/exports/transactions-{start}-to-{end}.csv`. Create the `data/exports/` directory if it doesn't exist. Confirm: "Exported 48 transactions to data/exports/transactions-2026-03-01-to-2026-03-26.csv"

## Investment Briefing

When the user asks about their portfolio — "how's my portfolio?", "show me my holdings", "investment summary", "what's in my 401k?", "dividend income" — present the investment picture.

### Investment Account Balances

```sql
SELECT b.institution, b.account_id, b.account_name, b.account_type, b.balance, b.synced_at
FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.ms
WHERE b.account_type IN ('brokerage', 'retirement', 'education')
ORDER BY b.balance DESC
```

### Holdings Breakdown

Latest holdings per account:
```sql
SELECT h.institution, h.account_id, h.symbol, h.name, h.quantity, h.price, h.market_value, h.cost_basis
FROM holdings h
INNER JOIN (SELECT account_id, symbol, MAX(synced_at) as ms FROM holdings GROUP BY account_id, symbol) m
ON h.account_id = m.account_id AND h.symbol = m.symbol AND h.synced_at = m.ms
ORDER BY h.market_value DESC
```

If no holdings data exists (institution doesn't provide it), fall back to balance-only view and note: "Holdings detail not available for [institution] — showing balance only."

### Asset Allocation

From holdings data, compute:
- Total market value across all holdings
- Per-holding percentage of total
- Group by asset type if possible (stocks, bonds, cash, other)

### Recent Investment Activity

Last 30 days of trades, dividends, and contributions:
```sql
SELECT date, institution, account_id, description, type, symbol, quantity, amount
FROM investment_transactions
WHERE date >= date('now', '-30 days')
ORDER BY date DESC
```

### Investment Output Format

```
INVESTMENT SUMMARY

Total Investment Value: $185,000

ACCOUNTS
  Brokerage Account      $110,000  (brokerage)
  401k                    $55,000  (retirement)
  529 Education           $20,000  (education)

HOLDINGS (Brokerage Account)
  Symbol   Name                    Shares    Price     Value      % Port
  VTI      Vanguard Total Market   150.0     $280.00   $42,000    22.7%
  VXUS     Vanguard Intl Stock     200.0     $60.50    $12,100     6.5%
  ...

RECENT ACTIVITY (last 30 days)
  3/20  Brokerage  DIVIDEND  VTI        +$95.00
  3/15  401k       CONTRIBUTION          +$500.00
  3/10  Brokerage  BUY       VTI    1.8  -$504.00
```

### Filtering

If user asks about a specific account ("what's in my 401k?", "show my brokerage holdings"):
- Filter all queries by `account_id` or `institution`
- Show deeper detail for the filtered account

## Guidelines

- Default time range: current month unless specified
- Always show amounts with $ and proper sign
- Group by category when showing spending breakdowns
- Show top 10 transactions unless user asks for more
- For investment queries, use `investment_transactions` and `holdings` tables
- Map user language flexibly: "food" → Restaurants + Groceries, "subscriptions" → Subscription

## Edge Cases

- **Uncategorized transactions:** Group as "Uncategorized" with count and total. Suggest running /category-override.
- **No transactions in range:** "No transactions found between [start] and [end]. Check the date range, or run /sync if data may be missing."
- **Single category filter with zero results:** "No [category] transactions in this period. Did you mean [similar category]?"
- **No holdings data:** Fall back to balance-only view with explanation.

## Database

SQLite at `data/foliome.db`. Use `better-sqlite3` to query.
