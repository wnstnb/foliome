# Connectors

API integrations that sync financial data without browser automation. Each connector outputs JSON to `data/sync-output/` in the same format as browser readers — Layer 2 import treats them identically.

## When to Use a Connector vs Browser Reader

Use a **connector** when the institution provides a REST API or the data can be fetched programmatically without logging into a web UI. Use a **browser reader** when the only access is through a bank's website.

## Existing Connectors

| File | Institution | What it does |
|------|------------|-------------|
| `real-estate.js` | Zillow / Redfin | Scrapes property value estimates for home value tracking |

## Output Format

Connectors write the same JSON structure as browser readers:

```json
{
  "institution": "slug-name",
  "syncedAt": "ISO timestamp",
  "balances": [{ "accountId": "...", "balance": 123.45, ... }],
  "transactions": [{ "accountId": "...", "date": "...", "amount": -50.00, ... }]
}
```

The file goes to `data/sync-output/{institution}.json`. `sync-engine/import.js` handles the rest.

## Adding a New Connector

1. Create `connectors/{institution}.js`
2. Fetch data via API (use `@dotenvx/dotenvx` for credentials)
3. Write output to `data/sync-output/{institution}.json`
4. Add the institution to `config/accounts.json` and `config/data-semantics.json`
5. `readers/sync-all.js` runs connectors in Phase 1 (before browser readers) — add yours to the connector list there
