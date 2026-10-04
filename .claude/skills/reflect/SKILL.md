---
name: reflect
description: Wiki maintenance — check coverage, refresh goals, re-check findings, consolidate (re-status, never delete), write monthly reflections, regenerate the index
trigger: manual
---

# Reflect

Periodic maintenance of the agent's financial memory wiki at `data/wiki/`. Consolidates messy active-mode captures, updates goals with real data, discovers findings from foliome.db, and writes monthly reflections. Rules: docs/wiki.md.

## When to activate

- User says "reflect", "update wiki", "daily maintenance"
- After `/morning-brief` if wiki has pages and last reflect was >24h ago (check `data/wiki/log.md` for last date)

## Procedure

### Step 0: Coverage check — is the data complete?

**Run this before any analysis. Every other step in this skill reads what is in the
database; none of them asks whether what is in the database is all there is.**

```bash
node scripts/check-coverage.js
```

It checks every account that reports a balance against **its own** transaction rhythm
(the 90th-percentile gap between its own transactions, floored at 21 days), so a
monthly mortgage and a daily card are held to different bars. It exits non-zero when
something is missing.

States it reports:

| State | Meaning | Action |
|---|---|---|
| `NO_TRANSACTIONS` | Balance **moves** but no ledger rows explain it | Reader coverage gap — investigate |
| `STALE` | Last transaction older than this account's own normal gap | Reader coverage gap — investigate |
| `QUIET` | Silent, but not synced since either | Note; usually an upstream sync issue |
| `EMPTY` | Zero balance, or a balance that has **never moved** | Correct — an unused account should have no transactions |
| `OK` | Producing on its own rhythm | — |

**If anything is `NO_TRANSACTIONS` or `STALE`:**

1. **Say so in the report, always** — even when the analysis looks fine. It looked fine
   on 2026-09-05 too.
2. **State the affected figures as floors, not measurements.** Name the bound
   ("understated by roughly $X/mo") rather than implying precision the data cannot carry.
3. **File it as a defect, not a caveat.** See below.

> **Why this step exists.** On 2026-09-05 a full reflect ran over 48 pages, reported
> improving trends, and never noticed that Capital One had been downloading
> transactions for 1 of its 5 accounts since May — including the account the household
> utilities are paid from. Every sync had reported `ok`. The gap was found later that
> night only because the user happened to remember a utility bill.
>
> Worse: the gap had been **found and written down that same morning**, in
> `data/wiki/log.md`, as the reason an analysis window was Apr–Aug. Two more coverage
> signals sat in the same entry. All three were spent as caveats justifying a decision
> instead of reported as defects.
>
> 📌 **When you write a data limitation as a caveat, you have found a defect. A sentence
> beginning "I can only measure X because…" is a bug report with the wrong grammar.**
> See [[reference-writing-durable-findings]] rule 8, and
> [[capital-one-per-account-download-silent]].


### Step 1: Discover existing pages

The wiki's rules are in `docs/wiki.md` (kinds, header, statuses, page shape). Read `data/wiki/index.md` to find all pages, then read the pages you'll touch. Edit in place: never overwrite a page you haven't read this session.

If the wiki is empty, tell the user: "The wiki is empty — nothing to reflect on yet. As we talk about your finances, I'll start capturing goals, decisions and what I learn here."

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

Scan for pages that make the same claim (active capture writes twice rather than miss once):
- Merge into the richer page and keep its slug.
- **Never delete the other page.** Set it to `superseded` (findings) or `closed` (other kinds), add `superseded_by: <slug>`, and add one line saying where the content went. Links to it keep working, and nobody re-proposes it.

### Step 4: Update goals

- `node scripts/wiki.js goals` refreshes every goal page linked to the personal financial statement (`pfs_goal` in its header) from the latest snapshot, and creates pages for new statement goals. It rewrites only the `<!-- auto:start -->…<!-- auto:end -->` block and the `headline`, `progress`, `on_track` and `updated` fields.
- For goal pages not tied to the statement: compute progress against the linked account's balance from `overview.balances`, check pace against the deadline, and update `headline` (the key number) plus `progress` (0–1) and `on_track` (yes / no).
- A goal that's reached or dropped becomes `closed`; one put on hold becomes `parked`.

### Step 5: Re-check findings

For each `standing` finding:
- Is it still true? Check the newest data. A fixed defect or a pattern that no longer holds becomes `superseded` (with `superseded_by` if a newer page replaces it). A claim the data now contradicts becomes `refuted`, with a line saying why.
- Still true: refresh its key number and `updated`.
- Work its `## Open` checklist: tick items that are done.

### Step 6: Check decisions

For each `active` decision that sets a spending rule (e.g. "Restaurants under $500"), compare this month's spending against it and note the trajectory (improving, stable, worsening) on the page.

### Step 7: Discover findings

Look for things the data shows that no page covers yet:
- **Spending spikes:** category spending >50% above the 3-month average
- **New recurring charges:** transactions appearing monthly that weren't there 3 months ago
- **Milestone crossings:** net worth crossing round numbers, account balances hitting new highs/lows
- **Subscription price changes:** same merchant, different amount vs previous months
- **Category shifts:** significant change in spending distribution
- **Data defects:** anything Step 0 or the numbers above expose

Create a page in `findings/` for each, in the shape `docs/wiki.md` sets: the title is the claim, the first paragraph is the answer with its key number, then Evidence (with sources), What it means, Caveats, `## Open` (a checklist) and Related.

### Step 8: Cross-reference

Add `[[slug]]` links between related pages, in both directions where the relation runs both ways (`node scripts/wiki.js check --one-way` lists one-way links):
- Goals ↔ the context and decisions that shape them
- Findings ↔ the goals or decisions they affect

### Step 9: Monthly reflection

Check if `reflections/YYYY-MM.md` exists for the current month. If not, create one and set last month's page to `closed`:

```markdown
---
type: reflection
status: active
title: Month YYYY
short: Month YYYY
topic: planning
created: YYYY-MM-DD
updated: YYYY-MM-DD
tags: [monthly, YYYY-MM]
sources: [balances, transactions]
---

# Month YYYY

One or two sentences: the month's headline numbers.

## Net Worth
Current: $X. Change: +/- $Y since last month.

## Top Spending Categories
1. Category — $X (vs $Y budget)
2. ...

## Goal Progress
- Goal name: X% → Y% this month

## Notable Findings
- ...

## Resolved
- Findings superseded or refuted this month, goals closed
```

### Step 10: Index, check and log

- `node scripts/wiki.js index` regenerates `index.md` from page headers. Never hand-edit it.
- `node scripts/wiki.js check` must report no problems (broken links, missing header fields, statuses that don't fit the kind). Fix what it finds.
- Append to `log.md` a dated entry (`## [YYYY-MM-DD] reflect`) listing all changes made during this session.

### Step 11: Report

Tell the user what was done:
- **Coverage** — findings from Step 0, or explicitly that coverage is clean. **Never
  omit this section.** If any figure below is affected by a gap, say which, and give
  the bound.
- Pages consolidated (merged N → M, re-statused)
- Goals updated (with current progress)
- Findings re-statused (superseded / refuted) and still standing
- New findings
- Monthly reflection created/updated
