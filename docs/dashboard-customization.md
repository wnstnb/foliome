# Dashboard Customization Guide

The Foliome dashboard is a React SPA served as a Telegram Mini App. Data flows from SQLite through API endpoints into React components. Every tab, chart, and metric is customizable — the agent can build new views on request.

## Architecture

```
SQLite (foliome.db)
    ↓
dashboard-queries.js     ← query functions (getOverview, getTransactions, etc.)
    ↓
dashboard-server.js      ← API endpoints (/api/overview, /api/transactions, etc.)
    ↓
React SPA (dashboard/)   ← tabs, charts, components
    ↓
Telegram Mini App or standalone browser
```

### Key Files

| File | Role |
|------|------|
| `scripts/dashboard-queries.js` | SQL query functions — all data access lives here |
| `scripts/dashboard-server.js` | HTTP server — auth, API routes, static serving |
| `dashboard/src/tabs/` | One React component per tab (Brief, Overview, Transactions, Budget, Portfolio, Subs, Wiki) |
| `dashboard/src/components/shared/` | Reusable components (KPICard, AccountRow, TransactionRow, etc.) |
| `dashboard/src/components/overlays/` | Full-screen overlays (Financial Health) |
| `dashboard/src/lib/format.ts` | Number formatting (accounting parentheses, abbreviations) |
| `dashboard/src/lib/constants.ts` | Colors, palettes, date presets, account type labels |
| `dashboard/src/lib/types.ts` | TypeScript interfaces for all API responses |
| `config/budgets.json` | Budget limits per category |

## Adding a New Tab

### 1. Add a query function in `dashboard-queries.js`

```js
function getMyData(dbPath) {
  const db = openDb(dbPath);
  const results = db.prepare(`
    SELECT description, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    WHERE date >= date('now', '-30 days')
    GROUP BY description
    ORDER BY total ASC
    LIMIT 20
  `).all();
  db.close();
  return { results };
}

module.exports = { ...existing, getMyData };
```

### 2. Add an API endpoint in `dashboard-server.js`

In the API routes section:
```js
if (parsed.pathname === '/api/my-data') {
  sendJson(getMyData());
  return;
}
```

### 3. Create a React component in `dashboard/src/tabs/`

```tsx
// dashboard/src/tabs/MyTab.tsx
import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtAccounting } from '@/lib/format';
import { EmptyState } from '@/components/shared/EmptyState';

interface MyData { results: { description: string; total: number; count: number }[] }

export function MyTab() {
  const [data, setData] = useState<MyData | null>(null);

  useEffect(() => {
    fetchWithAuth<MyData>('/api/my-data').then(setData).catch(console.error);
  }, []);

  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;
  if (data.results.length === 0) return <EmptyState message="No data" />;

  return (
    <div className="animate-fade-in">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        {data.results.map(r => (
          <div key={r.description} className="flex justify-between py-2 border-b border-[var(--border)]/50 last:border-b-0">
            <span className="t-body">{r.description}</span>
            <span className="t-value">{fmtAccounting(r.total)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### 4. Register it in `App.tsx`

Add to the `TABS` array and the tab content switch:
```tsx
import { MyTab } from '@/tabs/MyTab';

const TABS = [
  ...existing,
  { id: 'mytab', label: 'My Tab' },
];

// In the tab content section:
{activeTab === 'mytab' && <MyTab />}
```

### 5. Build and test

```bash
cd dashboard && npm run build
# Server picks up new dist/ automatically
```

## Adding a New Chart

Charts use [Recharts](https://recharts.org/). Import from `recharts` and wrap in `<ResponsiveContainer>`.

### Pie/Donut Chart

```tsx
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { CHART_PALETTE } from '@/lib/constants';

<div className="h-[200px]">
  <ResponsiveContainer>
    <PieChart>
      <Pie data={data} innerRadius="65%" outerRadius="90%" paddingAngle={2} dataKey="value" stroke="none">
        {data.map((_, i) => <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />)}
      </Pie>
    </PieChart>
  </ResponsiveContainer>
</div>
```

### Area/Line Chart

```tsx
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

<div className="h-[200px]">
  <ResponsiveContainer>
    <AreaChart data={data}>
      <defs>
        <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0D9488" stopOpacity={0.3} />
          <stop offset="100%" stopColor="#0D9488" stopOpacity={0} />
        </linearGradient>
      </defs>
      <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
      <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} width={45} />
      <Tooltip contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8 }} />
      <Area type="monotone" dataKey="value" stroke="#0D9488" strokeWidth={2} fill="url(#grad)" dot={false} />
    </AreaChart>
  </ResponsiveContainer>
</div>
```

### Bar Chart

```tsx
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer } from 'recharts';

<ResponsiveContainer height={200}>
  <BarChart data={data}>
    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
    <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
    <Bar dataKey="value" fill="#0D9488" radius={[4, 4, 0, 0]} />
  </BarChart>
</ResponsiveContainer>
```

### Chart color palette

```
#0D9488, #3B82F6, #8B5CF6, #F59E0B, #EC4899, #06B6D4, #EF4444
```

Category-specific colors are in `CATEGORY_COLORS` in `lib/constants.ts`.

## Adding a Filter

The Transactions tab demonstrates the filter pattern:

1. State variables for filter values (`useState`)
2. Pass filters as query params via `fetchWithAuth`
3. Re-fetch data when filters change (`useEffect` with dependency array)

```tsx
const [datePreset, setDatePreset] = useState<DatePreset>('30d');

useEffect(() => {
  const { from, to } = resolveDatePreset(datePreset);
  fetchWithAuth('/api/my-endpoint', { from, to }).then(setData);
}, [datePreset]);
```

Date presets are defined in `lib/constants.ts`: `DATE_PRESETS` and `resolveDatePreset()`.

## Adding a Drill-Down

The drill-down pattern: child component receives a callback, parent handles navigation.

```tsx
// In parent (App.tsx):
const handleAccountClick = (accountId: string) => {
  setFilteredAccount(accountId);
  switchTab('transactions');
};

// In child (Overview.tsx):
<AccountRow onClick={() => onAccountClick(account.account_id)} />
```

Existing drill-downs:
- **Account row click** → Transactions tab, Activity sub-tab, filtered by account
- **Category row click** → Transactions tab, Activity sub-tab, filtered by category
- **KPI card click** → Financial Health overlay

## Customizing the Overview

The Overview tab (`tabs/Overview.tsx`) renders:
1. Hero net worth card with sparkline
2. Secondary KPIs (Assets, Liabilities, Savings Rate)
3. Alert card (nearest credit card due date)
4. Account groups (sorted by type)

To rearrange: reorder the JSX in the component. To add a new KPI:

```tsx
<KPICard
  label="Monthly Spending"
  value={fmtShort(totalSpending)}
  valueClass="text-[var(--negative)]"
  onClick={() => switchTab('transactions')}
/>
```

## Budget Configuration

`config/budgets.json` maps category names to monthly dollar limits:

```json
{
  "Restaurants": 500,
  "Groceries": 400,
  "Shopping": 300,
  "Subscription": 100,
  "Entertainment": 150,
  "Utilities": 200
}
```

The Budget tab reads this config and compares against current month spending. Progress bars turn yellow at 60% and red at 100%.

## SQL Query Reference

### Tables

| Table | Key Columns |
|-------|-------------|
| `balances` | `account_id`, `account_type`, `balance`, `synced_at` |
| `transactions` | `date`, `description`, `amount`, `category`, `user_category` |
| `investment_transactions` | `date`, `symbol`, `type`, `amount`, `quantity`, `price` |
| `holdings` | `symbol`, `name`, `quantity`, `price`, `market_value` |
| `statement_balances` | `account_id`, `period_end`, `closing_balance` |
| `sync_status` | `institution`, `status`, `last_success` |

### Key Query Patterns

**Latest balance per account:**
```sql
SELECT b.* FROM balances b
INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
ON b.account_id = m.account_id AND b.synced_at = m.ms
```

**Spending (exclude transfers and income):**
```sql
WHERE category NOT IN ('Transfer', 'Income') AND amount < 0
```

**Category with user overrides:**
```sql
COALESCE(user_category, category)
```

**Monthly aggregation:**
```sql
SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
FROM transactions GROUP BY month ORDER BY month
```

### Amount conventions

- Negative = money out (debits, spending)
- Positive = money in (credits, income)
- Liability balances (credit cards, mortgages) are negative

### Category list

Restaurants, Groceries, Shopping, Transportation, Entertainment, Utilities, Subscription, Healthcare, Insurance, Housing, Travel, Education, Personal Care, Transfer, Income, Fees.

## Design Tokens

### CSS Variables

| Token | Light | Dark |
|-------|-------|------|
| `--bg` | `#FAFCFB` | `#0F1B2D` |
| `--bg-card` | `#FFFFFF` | `#162236` |
| `--bg-hover` | `#F0FDF9` | `#1A3A4A` |
| `--text` | `#1A1A2E` | `#ECFDF5` |
| `--text-muted` | `#6B7280` | `#94A3B8` |
| `--border` | `#E5E7EB` | `#1E3A4F` |
| `--positive` | `#059669` | `#34D399` |
| `--negative` | `#DC2626` | `#F87171` |
| `--warning` | `#D97706` | `#FBBF24` |
| `--brand` | `#0D9488` | `#0D9488` |

### Typography

| Class | Size | Weight | Use |
|-------|------|--------|-----|
| `t-hero` | 32px | 700 | Hero net worth |
| `t-value` | 16px | 600 | Balances, amounts |
| `t-body` | 14px | 400 | Descriptions, names |
| `t-caption` | 12px | 500 | Dates, labels, deltas |
| `t-micro` | 11px | 500 | Section headers, uppercase |

### Number Formatting

Import from `@/lib/format`:

| Function | Example | Use |
|----------|---------|-----|
| `fmtAccounting(n)` | `($2,054.20)` | Liability balances, totals |
| `fmtShort(n)` | `$1.3M`, `$45K` | KPIs, summaries |
| `fmtDelta(n)` | `+$4,231` | Month-over-month changes |
| `fmtFull(n)` | `$1,234.56` | Transaction amounts |
| `fmtPercent(n)` | `74.6%` | Savings rate |

### Card Pattern

```tsx
<div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">
  {/* content */}
</div>
```

## Telegram-Specific

- Theme: `.tg-theme` class applies Telegram's CSS variables as fallbacks
- Theme toggle is hidden in Telegram (Telegram controls light/dark)
- `haptic('light')` fires on tab switches and taps
- `Telegram.WebApp.BackButton` used for overlay back navigation
- Safe area: `.safe-bottom` class adds `padding-bottom: env(safe-area-inset-bottom, 80px)`
- `tg.ready()` and `tg.expand()` called on mount via AuthContext

## What Users Can Ask the Agent to Build

The agent reads this doc, creates the query + endpoint + component, and builds it:

- "Add a tab that shows my top merchants"
- "Show income vs expenses as a stacked bar chart"
- "Add a cash flow forecast"
- "Change the donut chart to a horizontal bar chart"
- "Add a custom alert when any category exceeds $X"
- "Show my spending by day of week"
- "Add a net worth goal tracker"

The pattern is always: query function → API endpoint → React component → register in App.tsx → build.
