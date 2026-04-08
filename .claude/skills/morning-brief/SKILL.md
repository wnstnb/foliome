---
name: morning-brief
description: Daily financial summary — net worth, recent activity, payment due dates, alerts
trigger: manual
---

# Morning Brief

When the user says "good morning", "daily summary", "morning brief", or "how are my finances" — generate a personalized financial brief.

The brief serves two purposes:
1. **Dashboard Brief tab** — structured JSON at `data/brief/latest.json`, rendered by the React dashboard
2. **Telegram summary** — shorter conversational version sent directly to the user

## Prerequisites

- `data/foliome.db` must exist. If not: "No financial data found. Run /sync first."
- `data/brief/` directory is created automatically if missing.

## Data Sources

The brief draws from three sources:

### 1. Wiki (what matters to the user)

Read the agent's financial memory wiki at `data/wiki/`:
- Read `data/wiki/index.md` to discover all active pages
- Read goal pages (`data/wiki/goals/`) for savings targets, progress, deadlines
- Read preference pages (`data/wiki/preferences/`) for spending intentions
- Read concern pages (`data/wiki/concerns/`) for balance worries, spending alerts
- Read context pages (`data/wiki/context/`) for life events, pay schedule

If the wiki is empty (no pages in index), generate a data-only brief — no warning banner needed. An empty wiki just means the agent hasn't captured any context yet.

### 2. foliome.db (what happened)

Use `dashboard-queries.js` functions via Node.js:

```javascript
const { getOverview, getTransactions, getSpending, getBudgets } = require('./scripts/dashboard-queries.js');
const overview = getOverview();
const txns = getTransactions(undefined, { from: sevenDaysAgo, limit: 20 });
const spending = getSpending(undefined, { from: monthStart });
const budgets = getBudgets();
```

Key data points:
- **Net worth** — `overview.netWorth`, trend from `overview.netWorthTrend`
- **Balances** — latest per account from `overview.balances`
- **Recent transactions** — last 7 days
- **Spending by category** — current month
- **Budget progress** — from `budgets.categories` (spent vs budget per category)
- **Payment alerts** — from `overview.alerts` (credit cards due soon)
- **Sync status** — from `overview.syncStatus`

### 3. config/ (what's set)

- `config/budgets.json` — monthly budget limits per category (already included in `getBudgets()`)
- `config/payment-schedule.json` — credit card due dates (already included in `getOverview()`)

## Brief Composition

### Headline

```json
{
  "netWorth": 142350.00,
  "delta": 1230.00,
  "deltaPeriod": "since last week",
  "sparkline": [138200, 139100, 140500, 141120, 142350],
  "summary": "3 transactions yesterday, $47 spent."
}
```

- `netWorth`: from `overview.netWorth`
- `delta`: compare to previous brief's `headline.netWorth` (read `data/brief/latest.json` before overwriting). If no previous brief, use month-over-month from `netWorthTrend`.
- `sparkline`: last 5 values from `netWorthTrend`
- `summary`: count recent transactions, total spending. One sentence.

### Sections

Include sections based on available data and memories. Order by relevance:

1. **goal_progress** — if wiki has active goal pages. Show savings account balance vs target, pace projection.
2. **budget_pulse** — for each budget category, especially those the user cares about (from wiki preference pages). Include `spent`, `budget`, `progress` (0-1), `pace` ("on_track", "above", "over").
3. **recent_activity** — notable transactions from last 24-48 hours. Not all — just what's worth mentioning.
4. **upcoming** — payments due in the next 7 days from `overview.alerts`. Include `payments` array.
5. **concern** — if wiki has active concern pages and the relevant account balance triggers it.
6. **portfolio** — if investment accounts exist, top-level value change.
7. **account_health** — sync freshness, any warnings.
8. **insight** — any pattern the agent notices (unusual spending, recurring charge changes, etc.)

### Prose Style

- Trajectory, not snapshots: "Up $1,230 since last week" not "Net worth is $142,350"
- Comparisons create meaning: "$80 more than usual by this point in the month"
- Quiet days reframe as positive: "Nothing unusual. Spending is tracking below average."
- Short, direct sentences. Financial newsletter tone. No emojis.

## Output

### Step 1: Write Brief JSON

Write to `data/brief/latest.json` atomically:

```javascript
const fs = require('fs');
const path = require('path');

const briefDir = path.join(__dirname, 'data', 'brief');
fs.mkdirSync(briefDir, { recursive: true });

const brief = { generatedAt, greeting, headline, sections };

// Atomic write: temp file → rename
const tmpPath = path.join(briefDir, '.latest.tmp');
fs.writeFileSync(tmpPath, JSON.stringify(brief, null, 2));
fs.renameSync(tmpPath, path.join(briefDir, 'latest.json'));
```

Also save a dated copy: `data/brief/YYYY-MM-DD.json`.

### Step 2: Respond to User

Send a conversational summary to the user (Telegram or CLI). This is shorter than the JSON — just the highlights:

```
Good morning. Here's your snapshot for April 7.

Net worth: $142,350 (+$1,230 since last week)

Restaurants at $620, 78% of your $800 budget with 8 days left.
Chase Sapphire due in 4 days — balance: $672.

3 transactions yesterday totaling $47. Nothing unusual.
```

## Data Staleness

After querying, check staleness for each institution:
- 24-48h old: note age, suggest /sync
- >48h old: prominent warning in both the JSON and the message
- Never refuse to generate. Always show data with appropriate warnings.

## Example Brief JSON (Empty Wiki)

When the wiki has no pages, the brief is data-only:

```json
{
  "generatedAt": "2026-04-07T08:00:00Z",
  "greeting": "Monday, April 7",
  "headline": {
    "netWorth": 142350.00,
    "delta": 1230.00,
    "deltaPeriod": "since last week",
    "sparkline": [138200, 139100, 140500, 141120, 142350],
    "summary": "3 transactions yesterday, $47 spent."
  },
  "sections": [
    {
      "type": "budget_pulse",
      "title": "Restaurants",
      "body": "Restaurants at $620, 78% of your $800 budget with 8 days left. Tracking above pace.",
      "category": "Restaurants",
      "spent": 620,
      "budget": 800,
      "progress": 0.78,
      "pace": "above"
    },
    {
      "type": "recent_activity",
      "title": "Since Yesterday",
      "body": "3 transactions totaling $47.57. Whole Foods $28.50, Spotify $10.99, parking $8.08."
    },
    {
      "type": "upcoming",
      "title": "Coming Up",
      "body": "Chase Sapphire due in 4 days. Current balance: $671.99.",
      "payments": [
        { "account_id": "chase-sapphire", "account_name": "Chase Sapphire", "balance": -671.99, "days_until": 4 }
      ]
    },
    {
      "type": "account_health",
      "title": "Accounts",
      "body": "All 9 institutions synced within the last 24 hours."
    }
  ]
}
```

## Example Brief JSON (With Wiki Pages)

When the wiki has goals and preferences:

```json
{
  "generatedAt": "2026-04-07T08:00:00Z",
  "greeting": "Monday, April 7",
  "headline": {
    "netWorth": 142350.00,
    "delta": 1230.00,
    "deltaPeriod": "since last week",
    "sparkline": [138200, 139100, 140500, 141120, 142350],
    "summary": "Your third week of growth. 3 transactions yesterday."
  },
  "sections": [
    {
      "type": "goal_progress",
      "title": "House Fund",
      "body": "Your Chase savings is at $42,300 — 53% to your $80k target. At this pace, you'll hit it by November 2027.",
      "progress": 0.53,
      "account": "chase-savings"
    },
    {
      "type": "budget_pulse",
      "title": "Restaurants",
      "body": "Restaurants at $620, 78% of your $800 budget with 8 days left. You mentioned wanting to cut back — this month is tracking above your usual pace.",
      "category": "Restaurants",
      "spent": 620,
      "budget": 800,
      "progress": 0.78,
      "pace": "above"
    },
    {
      "type": "recent_activity",
      "title": "Since Yesterday",
      "body": "3 transactions totaling $47.57. Nothing unusual."
    },
    {
      "type": "upcoming",
      "title": "Coming Up",
      "body": "Chase Sapphire due in 4 days. Current balance: $671.99.",
      "payments": [
        { "account_id": "chase-sapphire", "account_name": "Chase Sapphire", "balance": -671.99, "days_until": 4 }
      ]
    },
    {
      "type": "concern",
      "title": "Credit Card Balance",
      "body": "Your Sapphire balance is $1,247 — above the $1,000 comfort level you mentioned."
    },
    {
      "type": "account_health",
      "title": "Accounts",
      "body": "All institutions synced. Capital One was 26 hours ago — still fresh."
    }
  ]
}
```

## Section Type Reference

| Type | Required Fields | Optional Fields |
|------|----------------|-----------------|
| `goal_progress` | title, body | progress (0-1), account |
| `budget_pulse` | title, body | category, spent, budget, progress (0-1), pace |
| `recent_activity` | title, body | transactions[] |
| `upcoming` | title, body | payments[] |
| `concern` | title, body | account |
| `portfolio` | title, body | — |
| `account_health` | title, body | — |
| `insight` | title, body | — |
