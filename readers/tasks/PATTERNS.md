# Transaction Download Patterns

Six proven patterns for downloading transaction data from financial institutions. Each pattern is implemented as a function in `download-transactions.js` and selected via the institution config's `transactions` section.

> **Quick lookup:** For a symptom-based pattern index ("I see X on the page, which pattern is this?"), see [`readers/institutions/templates/GUIDE.md`](../institutions/templates/GUIDE.md). This file provides the detailed reference for each pattern.

---

## Pattern A: Central Dialog

A single download dialog serves all accounts. One entry point, dropdowns to select account/format/date range, one download button.

```
┌─────────────────────────────────────────────┐
│  Dashboard                                   │
│                                              │
│   [Download Activity ↓]  ← entry point       │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  Download Dialog                         │ │
│  │                                          │ │
│  │  Account:    [Checking ...1234 ▼]        │ │
│  │  File type:  [CSV / Spreadsheet ▼]       │ │
│  │  Activity:   [All transactions  ▼]       │ │
│  │  Date from:  [mm/dd/yyyy]                │ │
│  │  Date to:    [mm/dd/yyyy]                │ │
│  │                                          │ │
│  │         [ Download ]                     │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  After download:                             │
│  "Download other activity" → cycle back      │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  downloadButtonSelector,      // entry point button
  accountDropdownButton,       // account selector trigger
  fileTypeDropdownButton,      // file format selector (dropdown)
  fileTypeLabel,               // string — label to select in file type dropdown (default: 'Spreadsheet (Excel, CSV)')
  activityDropdownButton,      // activity/date range selector
  allTransactionsLabel,        // string — label for "all transactions" option in activity dropdown (default: 'All transactions')
  dateRangeLabel,              // string — label for "date range" option in activity dropdown (default: 'Choose a date range')
  fromDateSelector,            // date input (from)
  toDateSelector,              // date input (to)
  downloadSubmitSelector,      // submit button
  // --- Extended options (Pattern A variants) ---
  postNavigateWaitMs,          // wait after clicking entry point (default: 2000, use 5000+ for page navigation)
  selectFileFormat,            // async fn(page) — custom file format selection (replaces fileTypeDropdownButton)
  fillDateInputs,              // async fn(page, from, to) — custom date filling (replaces fromDateSelector/toDateSelector)
  maxHistoryMonths,            // months of history for --all mode when no activity dropdown (default: 18)
  csvColumns,                  // string[] — column names for headerless CSVs (replaces parsing line 0 as header)
}
```

**Flow:** Open dialog → select account → select CSV → select date range → download → cycle back for next account.

**Variant: Central Download Page.** Some banks navigate to a separate download page (not a dialog overlay). The same config keys apply, but use `postNavigateWaitMs: 5000` for the page load. If the page uses radio buttons instead of a dropdown for file format, provide `selectFileFormat`. If date inputs are readonly, provide `fillDateInputs` with JS value setting. If the CSV has no header row, provide `csvColumns`. See `direct-login-central-download-page` template.

**Watch for:** Custom shadow DOM dropdowns (`<mds-select>`, etc.) that require `page.evaluate()` to interact. Readonly date inputs that need `removeAttribute('readonly')` + native value setter + event dispatch. Radio buttons for file format that need `aria-checked` verification before clicking.

---

## Pattern B: Per-Account

Navigate to each account's detail page individually, then download from there. No central dialog — each account has its own download flow.

```
┌─────────────────────────────────────────────┐
│  Dashboard                                   │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Checking  │  │ Savings   │  │ Credit    │  │
│  │ ...1234   │  │ ...5678   │  │ ...9012   │  │
│  └─────┬────┘  └──────────┘  └──────────┘  │
│        │                                     │
│        ▼                                     │
│  ┌─────────────────────────────────────────┐ │
│  │  Account Detail: Checking ...1234        │ │
│  │                                          │ │
│  │  Recent Transactions                     │ │
│  │  ├─ 03/27 GROCERY STORE    -$87.50      │ │
│  │  ├─ 03/26 GAS STATION      -$45.00      │ │
│  │  └─ ...                                  │ │
│  │                                          │ │
│  │  Time period: [Last 90 days ▼]           │ │
│  │  [Download Transactions]                 │ │
│  │                                          │ │
│  │  ← Back to accounts                     │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  perAccount: true,
  downloadLinkSelector,        // download button on account page
  timePeriodOptions,           // object — time period dropdown options: { all: 'Year-to-Date', custom: 'Custom Date Range' }
  fromDateSelector,            // string — date input selector (from), used when timePeriodOptions.custom is selected
  toDateSelector,              // string — date input selector (to), used when timePeriodOptions.custom is selected
  downloadSubmitSelector,      // confirm download
  postDownloadDismiss,         // string[] — selectors to dismiss "download started" modal (default: close/× buttons)
  backButtonSelector,          // return to dashboard
}
```

**Flow:** For each account → navigate by last-4 → set time period → download → dismiss modal → back to dashboard → next account.

**Watch for:** Custom dropdown components for time period selection. Account tiles may use last-4 digits for navigation.

---

## Pattern C: PDF Statements

Download monthly PDF statements, extract text with LiteParse, then agent extracts structured transactions from the text.

**Sub-pattern 1: Yearly ZIP archives**
```
┌─────────────────────────────────────────────┐
│  Statements Page                             │
│                                              │
│  ▼ 2026                                     │
│    January 2026     [Download]               │
│    February 2026    [Download]               │
│    [Download All 2026]                       │
│                                              │
│  ▶ 2025                                     │
│  ▶ 2024                                     │
└─────────────────────────────────────────────┘
```

**Sub-pattern 2: Per-account dropdown + per-month buttons**
```
┌─────────────────────────────────────────────┐
│  Statements Page                             │
│                                              │
│  Account: [Checking ...1234 ▼]               │
│                                              │
│  March 2026     [Download statement]         │
│  February 2026  [Download statement]         │
│  January 2026   [Download statement]         │
│  December 2025  [Download statement]         │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  pdfBased: true,
  statementsUrl,               // URL of statements page (used if statementsNavSelector not set)
  statementsNavSelector,       // string — selector for a nav element to click to reach statements page (alternative to statementsUrl)
  accountDropdownSelector,     // sub-pattern 2: account selector (triggers per-account statement flow)
  downloadButtonSelector,      // sub-pattern 2: per-month download button selector (default: 'button[aria-label*="Download"]')
  // Sub-pattern 1: Download buttons discovered dynamically by "Download all" button text
}
```

**Flow:** Navigate to statements page → download PDFs (ZIP or individual) → LiteParse extracts text → agent extracts structured transactions from text → import.js normalizes.

**Watch for:** ZIPs containing monthly PDFs (need unzip step). Some institutions only show closed months — current month transactions need a different path.

---

## Pattern D: Export Modal

An export/download modal with a calendar date picker. Often found on statement pages where you select a date range via prev/next month navigation.

```
┌─────────────────────────────────────────────┐
│  Statements Page                             │
│                                              │
│  [Export Transactions]  ← entry point        │
│                                              │
│  ┌─────────────────────────────────────────┐ │
│  │  Export Modal                            │ │
│  │                                          │ │
│  │  ◀  March 2026  ▶                       │ │
│  │  Su Mo Tu We Th Fr Sa                    │ │
│  │                  1  2  3                 │ │
│  │   4  5  6  7  8  9 10                    │ │
│  │  11 12 13 14 15 16 17                    │ │
│  │  18 19 20 21 22 23 24                    │ │
│  │  25 26 27 [28]                           │ │
│  │                                          │ │
│  │         [ Export ]                       │ │
│  └─────────────────────────────────────────┘ │
│                                              │
│  (backdrop overlay may block clicks —        │
│   use page.evaluate() to bypass)             │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  exportModal: true,
  statementsLinkSelector,      // navigate to statements page
  exportLinkSelector,          // open export modal
  startDateClickSelector,      // truthy — enables start-date calendar picker logic (in --all mode only)
  prevMonthSelector,           // calendar prev month button
  monthsBack,                  // number — how many months to navigate back in calendar (default: 14)
  monthYearTriggerSelector,    // string — selector to read current month/year label for verification (default: '.month-year-trigger')
  dayButtonSelector,           // day button in calendar (parameterized)
  exportButtonSelector,        // confirm export
}
```

**Flow:** Navigate to statements → click export → navigate calendar to target month → select day → export → repeat for date range.

**Watch for:** Backdrop overlays that intercept `locator.click()`. Use `page.evaluate(() => element.click())` to bypass. Calendar navigation may need multiple prev-month clicks to reach the target date.

---

## Pattern E: Direct Export

The simplest pattern. Navigate to a page, click one button, CSV downloads immediately. No date picker, no account selector, no modal.

```
┌─────────────────────────────────────────────┐
│  Transaction History                         │
│                                              │
│  ├─ 03/27 CONTRIBUTION    +$500.00          │
│  ├─ 03/01 CONTRIBUTION    +$500.00          │
│  ├─ 02/01 CONTRIBUTION    +$500.00          │
│  └─ ...                                      │
│                                              │
│  [Export Table]  ← click, CSV downloads      │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  directExport: true,
  navigationSelector,          // link/button to reach transaction history page
  navigateToTransactions,      // async fn(page, options) — custom navigation function (replaces navigationSelector; for SPAs where locator.click() doesn't trigger React events)
  exportButtonSelector,        // the export button
  csvSkipRows,                 // number — rows to skip at top of CSV before header (default: 0; use for files with metadata preamble)
}
```

**Flow:** Navigate to transaction history → click export → done.

---

## Pattern F: Report-Based (Async)

Generate a report, wait for it to be ready, then download. Used by institutions that build reports asynchronously.

```
┌─────────────────────────────────────────────┐
│  Reports Page                                │
│                                              │
│  Create New Report                           │
│  Date from:  [mm/dd/yyyy]                    │
│  Date to:    [mm/dd/yyyy]                    │
│  Format:     [CSV ▼]                         │
│  [ Generate Report ]                         │
│                                              │
│  ─────────────────────                       │
│  Recent Reports                              │
│  ├─ 2026-03-28  Processing...               │
│  ├─ 2026-03-15  [Download]    ← ready        │
│  └─ 2026-02-28  [Download]                   │
└─────────────────────────────────────────────┘
```

**Config keys:**
```js
transactions: {
  reportBased: true,
  reportUrl,                   // URL of reports page
  transactionTypeSelector,     // string — selector for transaction type dropdown (optional)
  transactionTypeValue,        // string — value to select in transaction type dropdown (default: 'Balance affecting')
  dateRangeSelector,           // string — selector for date range input/picker (opens date range UI on click)
  fromDateSelector,            // string — start date input within date range picker (default: auto-detected by placeholder/name)
  toDateSelector,              // string — end date input within date range picker (default: auto-detected by placeholder/name)
  formatSelector,              // string — selector for format dropdown (optional)
  formatValue,                 // string — value to select in format dropdown (default: 'CSV')
  createReportSelector,        // generate report button
  downloadLinkSelector,        // download link (appears when ready; default: 'a:has-text("Download")')
  refreshSelector,             // string — selector for refresh button to poll report status (optional; if absent, waits 5s between polls)
}
```

**Flow:** Navigate to reports → set date range → generate → poll until ready → download.

**Watch for:** Reports may take 30-120 seconds to generate. Poll at reasonable intervals. Some institutions email the report instead of making it downloadable in-page.

---

## How Patterns Are Selected

The institution config's `transactions` section determines which pattern runs. `download-transactions.js` checks config keys in this order:

```
directExport: true     → Pattern E
exportModal: true      → Pattern D
pdfBased: true         → Pattern C
reportBased: true      → Pattern F
perAccount: true       → Pattern B
(default)              → Pattern A (central dialog)
```

## Adding a New Pattern

If you encounter a bank that doesn't fit any existing pattern:

1. Document the download flow (screenshots, selectors, interactions)
2. Add a new `run<PatternName>()` function in `download-transactions.js`
3. Add a config key to trigger it (e.g., `customPattern: true`)
4. Route to it in the `run()` function's pattern detection logic
5. Update this document
