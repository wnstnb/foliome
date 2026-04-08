---
name: reflect
description: Wiki maintenance — consolidate pages, update goals with real data, discover patterns, write monthly reflections
trigger: manual
---

# Reflect

Periodic maintenance of the agent's financial memory wiki at `data/wiki/`. Consolidates messy active-mode captures, updates goals with real data, discovers patterns from foliome.db, and writes monthly reflections.

## When to activate

- User says "reflect", "update wiki", "daily maintenance"
- After `/morning-brief` if wiki has pages and last reflect was >24h ago (check `data/wiki/log.md` for last date)

## Procedure

### Step 1: Discover existing pages

Read `data/wiki/index.md` to find all pages. Then read each linked page to understand current state.

If the wiki is empty (no pages linked from index), tell the user: "The wiki is empty — nothing to reflect on yet. As we talk about your finances, I'll start capturing goals, preferences, and context here."

### Step 2: Query financial data

Use `dashboard-queries.js` to get current state:

```javascript
const { getOverview, getTransactions, getSpending, getBudgets } = require('./scripts/dashboard-queries.js');
const overview = getOverview();
const spending = getSpending(undefined, { from: monthStart });
const budgets = getBudgets();
```

Key data points: latest balances per account, net worth + trend, spending by category this month, budget progress.

### Step 3: Consolidate

Scan all pages for overlapping or duplicate content created by active mode captures:
- Two pages about the same goal → merge into one, keep the richer content
- Duplicate context entries → combine into a single page
- Near-identical preferences → merge

Delete the redundant page after merging its content.

### Step 4: Update goals

For each active goal page:
- Find the linked account's current balance from `overview.balances`
- Calculate progress: `current_balance / target_amount`
- Calculate pace: is the user on track to hit the deadline?
- Update the page with current numbers and projection

### Step 5: Resolve concerns

For each active concern page:
- Check if the triggering condition has cleared (e.g., credit card balance below threshold, spending category back to normal)
- If resolved: set `status: resolved`, note the resolution date and what changed
- If still active: update with current numbers

### Step 6: Check preferences

For each active preference page:
- Compare current month's spending in the relevant category vs the stated preference
- Note trajectory: improving, stable, or worsening
- Update the page with current data

### Step 7: Discover patterns

Look for notable data patterns that don't have wiki pages yet:
- **Spending spikes:** category spending >50% above the 3-month average
- **New recurring charges:** transactions appearing monthly that weren't there 3 months ago
- **Milestone crossings:** net worth crossing round numbers, account balances hitting new highs/lows
- **Subscription price changes:** same merchant, different amount vs previous months
- **Category shifts:** significant change in spending distribution

Create a new page in `patterns/` for each discovery with data evidence.

### Step 8: Cross-reference

Add links between related pages:
- Goals that reference specific accounts → link to context about those accounts
- Concerns about spending → link to relevant preference pages
- Patterns that relate to goals → link both directions

### Step 9: Monthly reflection

Check if `reflections/YYYY-MM.md` exists for the current month. If not, create one:

```markdown
---
type: reflection
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
tags: [monthly, YYYY-MM]
---

# Month Year Reflection

## Net Worth
Current: $X. Change: +/- $Y since last month.

## Top Spending Categories
1. Category — $X (vs $Y budget)
2. ...

## Goal Progress
- Goal name: X% → Y% this month

## Notable Patterns
- ...

## Resolved Concerns
- ...
```

### Step 10: Update index and log

- Rebuild `index.md` with all current pages, organized by section, with one-line summaries and status
- Append to `log.md` with a dated entry listing all changes made during this reflect session

### Step 11: Report

Tell the user what was done:
- Pages consolidated (merged N → M)
- Goals updated (with current progress)
- Concerns resolved or still active
- Patterns discovered
- Monthly reflection created/updated
