---
name: statement
description: Statement of activity for any period, like a bank statement for the whole household. Builds on-demand statements for any dates, issues frozen monthly statements (on request or on an optional schedule), delivers them, and answers questions from the frozen snapshot.
trigger: manual
---

# Statement of Activity

Use this when the user asks for a "statement", "monthly statement", "statement for September", "Q3 statement", "what happened last month", "activity since Jan 1", or when a monthly statement schedule fires.

A statement is factual and backward-looking: what happened to all the household's money over a period, built only from synced data. No interview, no assumptions, no projections (those belong to `/financial-statement`). Every number comes from the engine; never compute or "fix" a number yourself.

## Kinds

| Kind | When | Command | Frozen |
|---|---|---|---|
| `issued` | The previous calendar month: by schedule, or when the user asks to issue it ("issue September") | `node scripts/statements/build.js --month YYYY-MM --kind issued` | Yes: written once as `rev-N`, read-only |
| `custom` | On demand, any period | `node scripts/statements/build.js --from YYYY-MM-DD --to YYYY-MM-DD --kind custom` | Saved as generated |
| `preview` | Checking before issuing | `... --kind preview --out <scratch dir>` | No, overwritten |

Issued statements are calendar months only. A rebuild of an issued month (after a fix, or a sync that was missing) becomes the next revision; earlier revisions stay. Corrections to an issued month (reclassified transactions, late postings, corrected balances) appear automatically in the next month's "Changed since last statement". Never reissue a month just because a category changed.

## Picking the period

- No period named → the last full calendar month, `custom`.
- "September" / "last month" → that calendar month. If an issued statement already exists for it, deliver that one instead of building a new one.
- "Issue September" → `issued`. Issue a month once it has ended and its late postings have settled (a few days in). Issuing is optional: without it, statements are on demand only.
- "Q3", "this year", "since Jan 1", "last 90 days" → `custom` with explicit `--from`/`--to`.
- A period that starts before Foliome's balance history: build it anyway. The statement marks the accounts it can't open as "not available" and says so; tell the user in one line.

## Steps

1. **Freshness.** The statement uses balances at local midnight on each boundary. Run after a sync and import, so the month's last days are in. Stale institutions are fine: the statement names them as "last updated <date>".
2. **Build.** Run the command for the kind. It prints a JSON summary and exits non-zero, writing nothing, if a consistency check fails (bridge, category totals, account changes, running balances). On failure, report the check that failed and stop. Never work around it.
3. **Check.** Read the summary:
   - `notExplained`: the timing line of the bridge. Under $500, mention it only if asked. Over $500, look at `untracked` and `transit` in the snapshot and say what it is in one sentence.
   - `callouts`: the five things worth knowing. Use them as the message.
4. **Deliver.**
   - Telegram: one short DM in plain sentences: the period, net worth change (and without the home estimate if that line exists), money in / out / left over vs typical, and the top two callouts. Then the dashboard button: `node scripts/telegram-notify.js --dashboard "<chatId>" "Your September statement is ready." "<dashboard-url>"`. The Statements tab shows it as issued, with Download PDF.
   - Attach the PDF only when the user asks for the file.
   - Desktop: print the same summary and the path to `statement.pdf`.
5. **Answer follow-ups from the snapshot.** `data/statements/<kind>/<period>/rev-N/snapshot.json` holds every number on the statement: `bridge`, `cashFlow`, `typical`, `categories`, `recurring`, `cards`, `largest`, `accounts`, `investing`, `goals`, `coverage`, `corrections`, `untracked`, `transit`, `transactions`. Quote from it; don't re-query the database for an issued period, because the database has moved on and the statement hasn't.

## What the numbers mean

- **Money in** = transactions categorized Income. **Money out** = every outflow except transfers and income: card charges when made, the full mortgage payment.
- **Not counted** = card payments and transfers between the household's own accounts. Pairs are matched so they net out, including deposits into brokerage accounts that the broker records as journals.
- **Paid to / received from accounts Foliome doesn't see** = transfers with no matching account (an unsynced card, a person). Its own bridge line.
- **Saved from paychecks** = retirement contributions recorded by the plan (they never touched checking).
- **Market change** = each investment account's change minus money moved in.
- **Home estimate** = its own hatched line, never mixed into market change or callouts.
- **Typical** = median of up to 12 prior periods of the same length. **Budgets** = `config/budgets.json`, category budgets only.
- **Categories** are as in effect on the day the statement was built (user overrides first).
- Posted transactions only.

## Schedule (optional)

Statements need no schedule: the user can ask for one any time. To have each month issued automatically, set it up with `/foliome-loop` (e.g. "issue my monthly statement on the 5th"). Suggest the 5th, when late postings have settled, but any day 1–28 works. Change or stop it with `/foliome-loop` too. The schedule's prompt: run after the morning sync and import, issue the previous month with `--kind issued`, deliver the summary; if a check fails, report it and don't issue.

## Tests

`npm run test:statements` builds the demo household (made-up data) and checks the bridge, freezing, corrections carried forward, custom periods and that nothing is ever cut off. Run it after any change to `scripts/statements/`. The public sample is `docs/statements-sample.pdf`.
