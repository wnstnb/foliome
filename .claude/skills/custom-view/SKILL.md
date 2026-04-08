---
name: custom-view
description: Build a custom dashboard view from a natural language request — query, API, React component, build, deploy
trigger: manual
---

# Custom View

Build a custom dashboard tab on demand. The user asks a question about their finances in natural language, and this skill creates a new query function, API endpoint, and React component, then builds and deploys the updated dashboard.

## When to activate

- The user says "show me...", "add a tab for...", "I want to see...", "build me a view of..."
- Any request for a custom financial visualization not covered by the existing 6 tabs
- The user says "custom view", "new dashboard tab", or "add to dashboard"
- Also handles removal: "remove the ... tab", "delete custom view ..."

## Prerequisites

- `dashboard/dist/` must exist (run `cd dashboard && npm run build` if not)
- Dashboard server must be running on port 3847
- Database at `data/foliome.db` must have data (run a sync first)

## Removal Flow

If the user asks to remove a custom tab (e.g., "remove the restaurant spending tab"):

1. Read `dashboard/src/App.tsx` and find the TABS entry with a `custom-` prefixed ID matching the request.
2. If not found, tell the user which custom tabs exist and ask which one to remove.
3. Remove the tab entry from the TABS array and the content switch case in `App.tsx`.
4. Delete the component file `dashboard/src/tabs/Custom_*.tsx`.
5. Remove the API route from `dashboard-server.js`.
6. Remove the query function from `dashboard-queries.js`.
7. Run `cd dashboard && npm run build`.
8. Restart the dashboard server.
9. Confirm removal to the user.

## Build Flow

### Step 1: Understand the request

Parse the natural language request. Determine what data is needed using the schema reference in `docs/dashboard-customization.md`.

Key tables and patterns:
- `transactions` — date, description, amount, category, user_category, account_id, institution
- `balances` — account_id, account_type, balance, synced_at (use latest-per-account pattern)
- `holdings` — symbol, name, quantity, price, market_value
- `investment_transactions` — date, symbol, type, amount, quantity, price
- Spending queries: `WHERE category NOT IN ('Transfer', 'Income') AND amount < 0`
- Category with overrides: `COALESCE(user_category, category)`

### Step 2: Check tab limits and generate slug

1. Read `dashboard/src/App.tsx`. Count existing custom tabs (IDs starting with `custom-`).
2. If 8 custom tabs already exist, ask the user which one to replace. Remove it first (see Removal Flow).
3. Generate a tab slug: lowercase, alphanumeric + hyphens only, max 30 chars, derived from key terms in the request. Prefix with `custom-` (e.g., `custom-restaurant-monthly`).
4. Verify no conflict with existing tab IDs in the TABS array. If conflict, append `-2`, `-3`, etc.

### Step 3: Write the query function

Add a new function to `scripts/dashboard-queries.js` following the existing pattern:

```js
function getCustomRestaurantMonthly(dbPath) {
  const db = openDb(dbPath);
  // ... query logic ...
  db.close();
  return { /* results */ };
}
```

Rules:
- Use `openDb(dbPath)` and `db.close()`.
- Use `.prepare()` with parameterized queries for any user-supplied values.
- Named params in the JS object must NOT have `$` prefix (e.g., `params.from` not `params.$from`). The SQL uses `$from` but better-sqlite3 expects `from` in the params object.
- Add the function to the `module.exports` at the bottom of the file.

**Verify the query works** before proceeding:

```bash
node -e "const q = require('./scripts/dashboard-queries.js'); const r = q.getCustomRestaurantMonthly(); console.log(JSON.stringify(r).slice(0, 200));"
```

If it errors, fix the query and test again.

### Step 4: Add the API route

In `scripts/dashboard-server.js`:

1. Add the import to the `require('./dashboard-queries.js')` destructuring at the top.
2. Add a new route in the API routes section (inside the `if (parsed.pathname.startsWith('/api/'))` block), before the 404 fallback:

```js
if (parsed.pathname === '/api/custom-restaurant-monthly') {
  sendJson(getCustomRestaurantMonthly());
  return;
}
```

### Step 5: Restart the dashboard server

New API routes require a server restart. The server is a Node.js process on port 3847.

```bash
# Kill existing server and restart
kill $(lsof -ti:3847) 2>/dev/null
node scripts/dashboard-server.js &
sleep 2
curl -s http://localhost:3847/health
```

Wait for the health check to return "ok" before proceeding.

### Step 6: Create the React component

Write `dashboard/src/tabs/Custom_{PascalSlug}.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { EmptyState } from '@/components/shared/EmptyState';

interface CustomData { /* match the query return shape */ }

export function Custom{PascalSlug}() {
  const [data, setData] = useState<CustomData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<CustomData>('/api/custom-{slug}')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;

  return (
    <div className="animate-fade-in">
      {/* Render the data using Tailwind + CSS variables */}
      {/* Use existing shared components: EmptyState, KPICard, TransactionRow, etc. */}
      {/* Use fmtAccounting, fmtShort, fmtPercent from @/lib/format */}
      {/* Charts: import from recharts (PieChart, AreaChart, BarChart, LineChart) */}
    </div>
  );
}
```

Design guidelines:
- Use raw Tailwind + CSS variables for layout/styling
- Import shared components from `@/components/shared/` as needed
- Import formatting utilities from `@/lib/format`
- For charts, import from `recharts` (already a dependency)
- Follow the card pattern: `<div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">`
- Use typography classes: `t-hero`, `t-value`, `t-body`, `t-caption`, `t-micro`
- Color classes: `text-[var(--positive)]`, `text-[var(--negative)]`, `text-[var(--warning)]`, `text-[var(--brand)]`
- Do NOT import new shadcn dependencies

### Step 7: Register the tab in App.tsx

1. Add the import at the top of `App.tsx`:
   ```tsx
   import { CustomRestaurantMonthly } from '@/tabs/Custom_RestaurantMonthly';
   ```

2. Add to the TABS array:
   ```tsx
   { id: 'custom-restaurant-monthly', label: 'Restaurants' },
   ```

3. Add the content switch case in the tab content section:
   ```tsx
   {activeTab === 'custom-restaurant-monthly' && <CustomRestaurantMonthly />}
   ```

### Step 8: Backup dist/

```bash
cp -r dashboard/dist dashboard/dist-backup 2>/dev/null || true
```

### Step 9: Build

```bash
cd dashboard && npm run build
```

If the build fails:
1. Read the error message.
2. Fix the issue in the component, query, or App.tsx.
3. Retry `npm run build`.
4. Maximum 3 attempts. If all fail, proceed to Step 12 (rollback).

### Step 10: Smoke test

```bash
curl -s http://localhost:3847/api/custom-restaurant-monthly
```

This will return 401 (no auth token), which confirms the route exists. A 404 means the server wasn't restarted or the route wasn't added correctly.

For a full data test, use a dev token if available, or verify the build output:
```bash
ls dashboard/dist/index.html && echo "Build output exists"
```

### Step 11: Report success

Tell the user the new tab is ready. If running as a Telegram agent, send a new message with a `web_app` inline keyboard button so they can tap to see the new tab immediately.

Example response: "Built your 'Restaurant Spending' tab. It shows [brief description of what the view contains]. Tap the dashboard button to see it."

### Step 12: Rollback on failure

If all build retries are exhausted:

1. Revert changes to `dashboard-queries.js` (remove the new function and export).
2. Revert changes to `dashboard-server.js` (remove the API route and import).
3. Delete the component file `dashboard/src/tabs/Custom_*.tsx`.
4. Revert changes to `App.tsx` (remove tab entry and switch case).
5. Restore `dashboard/dist-backup` to `dashboard/dist`.
6. Restart the dashboard server.
7. Tell the user: "I couldn't build that view. Here's what went wrong: [error]. Try rephrasing your request or ask for something simpler."

## Key Principle

The customization doc at `docs/dashboard-customization.md` is the instruction manual. Read it before building. It has the SQL patterns, the React component patterns, the chart patterns, and the design tokens. Follow it.
