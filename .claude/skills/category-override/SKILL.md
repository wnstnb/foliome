---
name: category-override
description: Override transaction categories via natural language — update rules, reclassify
trigger: manual
---

# Category Override

When the user wants to change how transactions are categorized, update the override rules and reclassify.

## Prerequisites

Check that `data/foliome.db` exists before querying transactions. If not, respond: "No financial data found. Run /sync first to populate your accounts."

## User Intents

**Override a specific merchant:**
- "Classify Whole Foods as Groceries"
- "Netflix should be Subscription"
- "Anything from Planet Fitness is Personal Care"

→ Add to `config/category-overrides.json` under `merchant_rules`:
```json
"merchant_rules": {
  "WHOLE FOODS": "Groceries",
  "NETFLIX": "Subscription",
  "PLANET FITNESS": "Personal Care"
}
```
→ Run `node sync-engine/classify.js --force` to reclassify

**Override a specific transaction:**
- "That Amazon charge on March 14 is a gift, not Shopping"

→ Update the specific transaction in SQLite:
```sql
UPDATE transactions
SET user_category = 'Shopping', category_source = 'user_override'
WHERE description LIKE '%AMAZON%' AND date = '2026-03-14'
```

**Show unclassified or low-confidence:**
- "Show me transactions you're not sure about"

```sql
SELECT date, description, amount, user_category, category_confidence
FROM transactions
WHERE category_confidence IS NOT NULL AND category_confidence < 0.5
ORDER BY category_confidence ASC
LIMIT 20
```

**Show category breakdown:**
- "What categories do I have?"
- "Show me classification stats"

→ Run `node sync-engine/classify.js --stats`

**Rename a category:**
- "Rename 'Personal Care' to 'Self Care'"

→ Update `default_categories` in overrides JSON
→ Update all transactions with that category
→ Update the merchant cache

## Available Categories

Default day-to-day:
Restaurants, Groceries, Shopping, Transportation, Entertainment, Utilities, Subscription, Healthcare, Insurance, Housing, Travel, Education, Personal Care, Transfer, Income, Fees

Investment:
Buy, Sell, Dividend, Interest, Contribution, Withdrawal, Fee, Rebalance, Distribution, Rollover

Users can add custom categories by telling the agent.

## Files

- `config/category-overrides.json` — merchant rules, category lists, investment type rules
- `data/merchant-category-cache.json` — cached model classifications (auto-generated)
- `data/foliome.db` — transactions table with user_category column

## Reclassification

After any override change:
```bash
node sync-engine/classify.js --force
```
This reclassifies all transactions except those with `category_source = 'user_override'` (user overrides are never auto-overwritten).
