# Dashboard Design Specification

Design reference mockup: `data/exports/dashboard-mockup.html`

## Overview

A responsive financial dashboard served as a Telegram Mini App. Mobile layout (430px) in Telegram's embedded WebView, wider layout at md (768px+) and lg (1024px+) breakpoints in standalone browser or expanded Telegram windows. Single-user, real-time data from SQLite via API endpoints.

## Architecture

```
React + shadcn/ui SPA (dashboard/) → Vite build → dashboard-server.js serves static app
  + API endpoints for dynamic data (/api/overview, /api/transactions, etc.)
  + Session token auth (Telegram initData HMAC → 30min sliding + 24h absolute max)
Legacy fallback: dashboard.js generates HTML template strings (if dashboard/dist/ missing)
```

The SPA fetches data from `/api/*` endpoints with Bearer token auth. The server validates Telegram initData, issues session tokens, and serves the built SPA from `dashboard/dist/`.

## Design System

### Typography

5 sizes, Inter font family, `font-variant-numeric: tabular-nums` on all monetary values.

| Token | Size | Weight | Use |
|-------|------|--------|-----|
| `t-hero` | 32px | 700 | Net worth (single hero number) |
| `t-value` | 16px | 600 | Balances, amounts, KPI values |
| `t-body` | 14px | 400 | Descriptions, account names |
| `t-caption` | 12px | 500 | Dates, institution names, badges, deltas |
| `t-micro` | 11px | 500 | Section headers, uppercase, letter-spaced |

### Color Palette

**Brand colors (from logo):**
- Primary: `#0D9488` (teal) — tab active, sparkline, chart accent, toggle active
- Light: `#34D399` — secondary chart color
- Accent: `#6EE7B7` — tertiary chart color
- Deep: `#065F46`, Darkest: `#022C22` — chart palette extension

**Semantic colors (theme-aware):**

| Token | Light | Dark | Use |
|-------|-------|------|-----|
| `--bg` | `#FAFCFB` | `#0F1B2D` | Page background |
| `--bg-card` | `#FFFFFF` | `#162236` | Card backgrounds |
| `--bg-hover` | `#F0FDF9` | `#1A3A4A` | Tap/hover states |
| `--text` | `#1A1A2E` | `#ECFDF5` | Primary text |
| `--text-muted` | `#6B7280` | `#94A3B8` | Secondary text, labels |
| `--border` | `#E5E7EB` | `#1E3A4F` | Card borders, dividers |
| `--positive` | `#059669` | `#34D399` | Positive deltas, income |
| `--negative` | `#DC2626` | `#F87171` | Negative deltas, debits |
| `--warning` | `#D97706` | `#FBBF24` | Due dates, budget warnings |

**Chart categorical palette** (diversified, not all-green):
```
#0D9488, #3B82F6, #8B5CF6, #F59E0B, #EC4899, #06B6D4, #EF4444
```

### Number Formatting

**Accounting convention — parentheses replace minus signs:**

| Context | Format | Color |
|---------|--------|-------|
| Liability balance (credit cards, mortgage) | `($2,054.20)` | Normal text (no red) |
| Total liabilities | `($636K)` | Normal text |
| Spending category total | `($2,548)` | Normal text |
| Transaction debit | `($25.00)` | Red — spending is an attention signal |
| Transaction credit/income | `+$3,315.01` | Green |
| Summary outflow | `($844)` | Red |
| Subscription amount | `$83/mo` | Normal text — just informational |
| Budget spent | `$49 / $800` | Normal text — progress bar conveys severity |
| Payment due | `$2,054` | Warning/amber |

**Principle:** Parentheses signal "liability/outflow" structurally. Red is reserved for deltas going the wrong direction and transaction debits. This reduces visual fatigue from constant red/green.

### Liability Delta Wording

Deltas on liabilities use contextual language instead of raw signed numbers:

| Situation | Display | Color |
|-----------|---------|-------|
| Credit card balance decreased (paid down) | `▲ $250 paid down` | Green |
| Credit card balance increased (more charges) | `▼ $1,714 more owed` | Red |
| Mortgage principal decreased | `▲ $2,381 paid down` | Green |
| Asset balance increased | `▲ $4,301` | Green |
| Asset balance decreased | `▼ $4,232` | Red |

### Cards & Spacing

- Card border-radius: 12px
- Card padding: 16px (standard), 12px (compact/`card-sm`)
- Section spacing: 20-24px between major sections, 12px between cards within a section
- Account row height: 48px+ (10px vertical + 12px horizontal padding)
- Transaction row height: 48px+ (12px vertical padding)

### Responsive Layout

| Breakpoint | Container | Behavior |
|------------|-----------|----------|
| `< md` (768px) | `max-w-[430px]` | Mobile layout — single column, compact padding |
| `≥ md` (768px) | `max-w-3xl` | Desktop layout — 2-col account groups, side-by-side charts, 2-col wiki grid |
| `≥ lg` (1024px) | `max-w-5xl` | Wide desktop — more breathing room |

Tab bar text scales up at `md:` (`text-sm`, larger padding). Wiki page view caps at `680px` reading width on desktop.

### Icons

- **Brand logos:** Simple Icons CDN (`cdn.simpleicons.org`) for ~40 common US institutions (Chase, BofA, Wells Fargo, Amex, Discover, Robinhood, Venmo, Cash App, etc.)
- **Fallback:** Colored initial boxes (2-letter abbreviation) in rounded 32px squares with 10% opacity tinted backgrounds
- **UI icons:** Lucide (ships with shadcn) — search, chevron, back arrow, sun/moon

## Navigation Structure

### Main Tabs (7)

| Tab | Content |
|-----|---------|
| **Brief** | Personalized daily financial narrative — net worth headline, goal progress, budget pulse, upcoming payments |
| **Overview** | Hero net worth + sparkline, assets/liabilities/savings KPIs, quick alerts, account list grouped by type (2-col grid on desktop) |
| **Transactions** | Search + date/account/category filters, Spending/Activity sub-tabs (donut + categories side-by-side on desktop) |
| **Budget** | Per-category progress bars, total budget gauge |
| **Portfolio** | Holdings allocation donut + top positions list |
| **Subs** | Subscription tracker with monthly/annual costs, annual total alert |
| **Wiki** | Read-only browser for agent memory wiki — index grouped by type (2-col grid on desktop), secure markdown page viewer |

### Sub-tabs (within Transactions)

| Sub-tab | Content |
|---------|---------|
| **Spending** (default, left) | Category donut chart with total in center, sorted category breakdown with percentages, monthly trend line chart |
| **Activity** (right) | Summary bar (count/inflow/outflow/net), date-grouped transaction list with category badges |

### Drill-down Flows

```
Overview → tap account row     → Transactions tab, Activity sub-tab, account filter set
Spending → tap category row    → Activity sub-tab, category filter set
Any KPI  → tap hero/KPI card   → Financial Health overlay (full-screen)
```

## Interactive Components

### Multi-Select Dropdown

Used for account and category filters. Features:
- "All accounts" / "All categories" toggle at top
- Individual items with teal checkboxes
- Label updates: "All accounts", single name, or "3 accounts"
- Category dropdown includes color dots matching chart colors
- Click outside to close, only one dropdown open at a time

### Date Filter

Select dropdown with presets:
- This month (default for Activity)
- Last month
- Last 30 days (default for Spending)
- Last 60 days
- Last 90 days
- Custom range → reveals two date input fields

### Financial Health Overlay

Full-screen panel opened by tapping any KPI. Features:
- Back arrow to close (slides down on close)
- Metric toggle pills (Net Worth, Assets, Liabilities, Savings Rate) — multi-selectable
- Trend line chart with gradient fill, dual Y-axes (dollars + percentage)
- Monthly breakdown table: month, net worth, change (green/red delta), savings rate
- "How it's calculated" explainer card that updates per selected metric

### Theme Toggle

Shadcn-style pill switch in header:
- Moon icon (left/dark) ↔ Sun icon (right/light)
- Thumb slides with cubic-bezier ease
- Track color: border-gray (dark) → brand teal (light)
- Charts rebuild with correct text/grid colors on toggle

## Transitions & Animations

| Interaction | Animation |
|-------------|-----------|
| Main tab switch | Fade in + 6px translate-Y, 200ms ease |
| Sub-tab switch (Spending ↔ Activity) | Directional slide (8px translate-X), 250ms, scroll position preserved |
| Health panel open | Slide up 20px + fade in, 300ms cubic-bezier(0.4, 0, 0.2, 1) |
| Health panel close | Slide down + fade out, 250ms, panel hidden after transition completes |
| KPI card tap | Scale to 0.97 on press (100ms), instant release |
| Account row tap | Background → `--bg-hover` on `:active` (100ms) |
| Category row tap | Same as account row |

**Scroll preservation:** Switching between Spending and Activity sub-tabs captures `window.scrollY` before the swap and restores it after, preventing the disorienting scroll-reset.

## Charts

All charts use Recharts (React-native chart components). The design spec below describes chart types and styling.

| Chart | Type | Location | Notes |
|-------|------|----------|-------|
| Category spending | Doughnut | Transactions → Spending | `cutout: 75%`, total spending as centered text overlay, no legend (category list below) |
| Monthly trend | Line/area | Transactions → Spending | Gradient fill (brand 30% → transparent), no gridlines, no data points, tooltip on hover |
| Portfolio allocation | Doughnut | Portfolio | `cutout: 65%`, legend on right, diversified color palette |
| Financial health | Line | Health overlay | Multi-line (toggleable), data points shown, dual Y-axes for mixed dollar/percentage, gradient fill on primary metric |

## Data Endpoints (Target API)

The dashboard-server exposes these API endpoints (all require session token via `Authorization: Bearer` header):

| Endpoint | Query params | Returns |
|----------|-------------|---------|
| `GET /api/overview` | — | Balances, net worth, assets, liabilities, statement deltas, sync status |
| `GET /api/transactions` | `from`, `to`, `accounts[]`, `categories[]`, `q` (search) | Filtered transaction list + summary (count, inflow, outflow, net) |
| `GET /api/spending` | `from`, `to`, `accounts[]` | Category breakdown, monthly trend |
| `GET /api/holdings` | — | Current positions, allocation |
| `GET /api/subscriptions` | — | Detected recurring charges |
| `GET /api/health` | — | Monthly net worth, assets, liabilities, savings rate history |
| `GET /api/budgets` | — | Budget config + current month spending per category |
| `GET /api/brief` | — | Daily brief JSON (exists flag + headline, sections) |
| `GET /api/wiki` | — | Wiki index (pages grouped by type, with frontmatter + summary) |
| `GET /api/wiki/page` | `path` | Single wiki page (frontmatter + markdown body) |
| `GET /api/wiki/asset` | `path` | Wiki asset file (images, PDFs — path-confined, extension allowlisted) |

Data comes from SQLite queries via `dashboard-queries.js` (< 100ms each) and wiki files via `wiki-queries.js`. All responses include a `Content-Security-Policy` header. See `docs/dashboard-customization.md` for adding new endpoints.

## Telegram Mini App Integration

- `Telegram.WebApp.expand()` on load — fill the screen
- `Telegram.WebApp.ready()` — signal to Telegram the app is loaded
- `--tg-theme-*` CSS variable fallbacks for native theme matching
- `Telegram.WebApp.HapticFeedback.impactOccurred('light')` on tab switches
- `Telegram.WebApp.BackButton` for Financial Health overlay back navigation
- Safe area padding: `padding-bottom: env(safe-area-inset-bottom, 80px)`
- Theme toggle hidden in Telegram mode (Telegram controls the theme)
