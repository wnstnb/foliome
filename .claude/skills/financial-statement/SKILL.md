---
name: financial-statement
description: Personal Financial Statement built on goals-based wealth planning and the family extended balance sheet. Shows today, goals, today's path vs the plan, monthly actions, long-view odds, and assumptions. Interview, build, check, deliver, review quarterly.
trigger: manual
---

# Financial Statement

**Optional add-on.** Foliome works fully without it, and nothing in the core reads its files. The wiki's goal pages pick up statement numbers only when a statement exists (`node scripts/wiki.js goals`). Never suggest it during onboarding; offer it when the household asks a planning question.

Use this when the user asks for a "personal financial statement", "PFS", "family balance sheet", "financial plan", "where do we stand", "are we on track", a scenario ("what if we retire at 60"), or a quarterly planning review.

## What it produces

A printable statement (HTML + PDF) plus a frozen `snapshot.json` that is the source of truth for that review. The statement answers seven questions in order:

1. Where are we today? → **What we own and what we owe**, **Each month: cash in and cash out** (the full mortgage payment counts as cash out), **Taxes and take-home**
2. Where do we want to go? → **The Goals: Today vs. Plan**: one card per goal
3. If we change nothing, do we get there? → each card's "today's habits" line, and **Today's path vs. the plan**
4. What do we have to do differently? → each card's "each month" and "if we wait"
5. Can we afford it? → **What we need to do each month**: the action plan against real cash flow
6. How sure are we? → **Retirement: how the plan grows** (two outlooks), lifetime spending phases, **The full picture** (family extended balance sheet), **What if…**, **Notes**
7. What do we decide? → **Page 1** (bento: net worth, income, spend, net cash, new money for goals, retirement vs. plan, where the money goes, goals, top decision) and **All decisions for this review**

Section headings carry the structure; there are no "Part N" labels.

It has to be **trusted** (every number shows where it came from, totals tie out, unexplained money gets its own line), **understood** (answer first, plain words, rounded summaries, conventions stated once) and **useful** (every goal tied to a monthly action, today's path next to the plan).

## Files

| Path | Role |
|---|---|
| `scripts/pfs/fetch-market.js` | Public market data at run time: Damodaran (NYU) annual returns 1928+, FRED CPI, TIPS yield, T-bill, breakeven inflation → `data/pfs/market.json` |
| `scripts/pfs/fetch-rates.js` | Risk-free rate and inflation only (lighter; used if market fetch fails) |
| `scripts/pfs/derive.js` | Everything Foliome can work out before asking: accounts and tax-type guesses, holdings mix → returns, paycheck cadence, mortgage payment, property tax, and the list of open questions → `data/pfs/derived.json` |
| `scripts/pfs/profile.js` | Read and write `config/pfs-profile.json` during the interview (`init`, `get`, `set`, `push`, `open`). `--profile <file>` / `PFS_PROFILE` work on another profile |
| `scripts/pfs/build.js` | The engine. Flags: `--scenario <name>`, `--profile <file>`, `--out <dir>`, `--no-pdf`, `--date YYYY-MM-DD` |
| `scripts/pfs/{tax,project,render}.js` | Tax model · projections, Monte Carlo and history replay · print-first renderer |
| `scripts/pfs/assumptions/` | Cited, dated defaults: capital markets, ticker → asset class, tax packs, college costs, household defaults |
| `config/pfs-profile.json` | The household's answers (gitignored). Template: `config-templates/pfs-profile.json` |
| `config/pfs-scenarios/*.json` | Scenario overlays. Examples: `config-templates/pfs-scenarios/` |
| `data/pfs/<date>/` | `snapshot.json`, `statement.html`, `statement.pdf`; scenarios under `scenarios/<name>/` |
| `scripts/pfs/demo/` | Made-up household (`demo-profile.json`, `make-demo-db.js`) and `test.js` (`npm run test:pfs`; `--sample docs/pfs-sample.pdf` refreshes the public sample) |

`PFS_DATA_DIR` moves `data/pfs` (market, rates, derived, statements) for dry runs and tests; every script honors it.

## Procedure

### 1. Refresh inputs
- Check sync freshness (`sync_status`). Offer `/sync` if anything is more than ~3 days old; never refuse to build.
- `node scripts/pfs/fetch-market.js` (falls back to the static pack if offline; the statement then shows the forward outlook only).
- `node scripts/pfs/derive.js`.

### 2. Interview, but only for what the data can't answer
If there's no profile: `node scripts/pfs/profile.js init`. Then `node scripts/pfs/profile.js open` lists what's still unknown.

The template ships sample values, and its `_examples` list names the sections that still hold them. The first `set` or `push` into a section removes it from the list, and `open` drops that section's questions. A build with sections still in `_examples` flags them on page 1 as incomplete, so example numbers never pass for real ones.

Ground rules:
- **Never ask what the data already shows.** Confirm derived values ("I see paychecks twice a month of about $3,550, does that sound right?") rather than asking for them.
- One topic per message, short questions, plain words. Offer choices where possible (college: in-state / private / a share).
- Accept "I don't know" and leave the default; the statement marks it as an assumption.
- Write every answer with `profile.js set <path> <value> --source "<who>, <date>"`. Unsynced accounts go in `offSyncAccounts` (or `manualAccounts`) with an as-of date and show as *stated*.
- Prefer real documents: paystub (pay, periods, deductions), mortgage statement (rate), account statements (registration: IRA vs Roth vs taxable).
- Ask the reasonable question, not the exhaustive one. A rough monthly figure beats a missing one.

Topic order: household (birth month and year for everyone, home state, dependents, which accounts are joint) → pay per earner (structure, periods, bonus, match, pre-tax deductions, how steady) → retirement age → spending outside synced accounts → goals (what, when, must / want / nice) → protection (life and disability cover, will, guardian, beneficiaries) → target investment mix if different from holdings.

**Manual mode:** without synced data (or with `manualOnly: true`), also ask for balances (`manualAccounts`) and a monthly spending estimate (`cashFlow.manual`). Everything else is the same.

### 3. Build
`node scripts/pfs/build.js`. Defaults come from the assumptions pack and the live market data whenever the profile is silent; `assumptionsUsed` in the snapshot lists which.

### 4. Check before sending (read the PDF yourself)
Use the Read tool on the PDF (`pages`). Check:
- **Ties out:** net worth = synced + stated balances. On the cash pages, "not accounted for" or "left over" must be explained. A large unexplained amount is decision #1, never quietly counted as savings.
- **Page 1 matches the detail:** if any what-if or goal falls short, page 1 says so.
- **Layout:** page 1 fits on one page; no page holds only a stray row; goal cards aren't split.
- **Dates:** readers see "Oct 3, 2026" style dates, never ISO; goal horizons show a date plus "in N yrs".
- **No internal crumbs:** the report never names agents, internal tools or file paths a household wouldn't recognize.
- **Labels:** every estimate is marked; stated (unsynced) values show their as-of date.

### 5. Deliver
Send the PDF directly to the person (it holds full financials; never post it to a group). In the message: the headline, the biggest unknown, the top two or three decisions, and what isn't modelled. Ask what's confusing or missing. Offer a scenario if they're weighing a choice.

### 6. Scenarios
Write `config/pfs-scenarios/<name>.json`:
```json
{ "label": "Retire at 60", "description": "...", "set": { "retirement.base": 60 },
  "goalsPatch": [{ "id": "edu-kid1", "selected": "private" }], "addGoals": [], "removeGoals": [] }
```
Run the base statement first, then `build.js --scenario <name>`. Page 1 shows the scenario next to the base. Scenario output never becomes the baseline for a quarterly review.

### 7. Quarterly review
Re-run steps 1, 3, 4 and 5. Ask only what changed since the last snapshot. When a previous snapshot exists, the build adds a **Review** page right after page 1:
- **Net worth change**, split into cash/cards/debt paydown, investments and retirement, and the home estimate, plus the change in lifetime surplus.
- **Activity vs. plan**: the plan plays out over years, so each review compares the quarter's activity with the pace the plan needs. For every action that asked for money last time:
  - goals with a synced `fundedBy` account: deposits into that account
  - the emergency fund: growth of its account
  - debt payoff: mortgage payments above the base payment
  - anything else with a `contributionMatch` regex on the goal: matching payments
  - anything the household told us: `profile.selfReported` entries (`{ goal, amount, asOf, source }`) dated inside the period. These show the amount with ✎ beside the ✓ or ! badge
  - otherwise the row is ✎ self-reported with "to report": ask for the amount and record it with `profile.js push selfReported '{"goal":"<id>","amount":<n>,"asOf":"YYYY-MM-DD"}' --source "<who>, <date>"`
- **Goals then and now**: funded share last time vs now.
Actions behind plan pace become decisions at the top of page 1. Talk through those first.

Schedule it with `/foliome-loop` (for example `7 9 2 1,4,7,10 *`, the 2nd of each quarter, after the morning sync). Set the entry's `lastRun` to the baseline statement's date so startup doesn't fire a catch-up run straight away.

## Look and feel
- **Page 1 is a bento grid:** a dark net worth tile, small tiles for income, spend, net cash and new money for goals, the retirement chart and spending donut side by side, a two-column goals tile, and the top decision in a dark bar. Space Grotesk for headings and figures, Inter for text (Google Fonts; Helvetica if offline).
- **Status badges:** ✓ on track (green), ! behind plan (amber), ✎ self-reported (muted blue). The icon shape carries the meaning, so it reads in black and white. Status colors are only for status; values and chart lines stay in ink.
- **One key per page:** every page that needs a legend gets one shared key under its title, outside the cards (`pageKey()` in render.js).
- **Flows use the statement period** (since the last statement, else the last 3 months), with the longer planning average (default 6 months) beside it, so twice-a-year bills don't distort the plan.

## Page-1 cards
The headline tiles come from a library. Net worth fills the big tile; the default small tiles are total income, total spend and net cash, plus a fixed "new money for goals" tile. A household can pin or swap them with `page1Cards` in the profile, choosing from: `netWorth`, `income`, `spend`, `netCash`, `freeAfterGoals`, `runway`, `surplus`, `portfolioGrowth` (markets only, from the second statement on), `savingsRate`, `goalsOnTrack`, `debtFree`. A card whose data is missing is skipped and the next default fills in.

## Goal types
| Type | Profile shape | Engine |
|---|---|---|
| Retirement | `retirement` block | Accumulate to retirement, fund phased spending to the horizon; Monte Carlo (forward) + history replay; safe spend; extra saving needed if short |
| Education | `goals[]` with `annualOptions`, `selected`, `startsOn: "YYYY-MM"`, `years`, `fundedBy` | Grow to the start, pay N years |
| Emergency fund | `plan.emergencyFundMonths` + `protection.emergencyFund.account` | Months of actual cash out, held in cash |
| Lump sum | `{ type: "lumpSum", amount, by: "YYYY-MM", fundedBy }` | Sinking fund; cash for short horizons |
| Debt payoff | `{ type: "debtPayoff", account, targetAge \| by, rate, payment }` | Amortization: payoff date, interest, payment needed |

Store dates, not "in N years": `born` on each member, `startsOn` / `by` on goals, `spending.phased.childcareEndsOn`. The build converts them against the statement date, so horizons count down between reviews. Relative fields (`inYears`, `startsInYears`) still work but go stale.

## Assumptions
- Real terms (today's dollars) throughout; returns are median compound.
- Market defaults are **built from public data** at run time: stocks = dividend yield + long-run real earnings growth; bonds = 10-year TIPS real yield; cash = T-bill less breakeven inflation. Other asset classes keep fixed spreads to these.
- A household can override any asset class (`assumptionsOverlay.classes`) or any account (`retirement.accounts[].mu/sigma` with a `source`). The statement shows default vs used.
- Taxes: federal + state packs picked from `household.state` (flat fallback for states without one), calibrated against observed paychecks when payroll is synced. Add a `tax` block to the profile only to override the packs.
- Household-specific wording (an unsynced spender's label, a pension's name) comes from the profile (`spending.phased.offSideLabel`, `humanCapital.pension.label`), never from the renderer.

## Known limits (say them, don't hide them)
- Pensions and Social Security aren't valued unless entered; Social Security stays a footnote by default.
- The tax model is an estimate, not a return.
- The history replay uses broad US stocks, bonds and bills; sector bets ride the stock series.
