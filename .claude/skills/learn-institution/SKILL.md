---
name: learn-institution
description: Discover and build a complete bank integration by answering 9 required questions
trigger: manual
---

# Learn Institution

You are building a deterministic Playwright integration for a financial institution. You have 9 questions to answer. You do not stop until all 9 are answered and recorded in a working config file.

**You are the builder, not the runner.** Everything you discover gets written to a config file. Once you're done, daily execution uses that config with zero LLM cost.

**You are self-correcting.** When a tool fails, you diagnose the error, fix the tool or config, and try again. You do not stop and ask for help unless the user needs to provide something (like an MFA code or credentials).

## Core Loop: Visual Step-by-Step Exploration

You navigate the bank website **visually**, one step at a time — like a human would. Each step:

```
1. READ the annotated screenshot — elements are labeled [1], [2], [3]...
2. REASON about what you see — "I see a login form, element [3] is the username field"
3. ACT — send a command: click, type, scroll, etc.
4. READ the new screenshot — see what changed
5. RECORD — note the selector and behavior for the config
6. REPEAT until the question is answered
```

**This is NOT batch exploration.** You do NOT run a script end-to-end and parse the output. You navigate step by step, seeing the page at each step, adapting immediately when something unexpected happens.

**NEVER use direct URL navigation (`goto`, `navigate`) inside an authenticated session.** Once logged in, navigate ONLY by clicking elements on the page. Direct URL navigation breaks SPA session state on most bank sites, triggering a redirect to the login screen. This disorients the entire flow. If you need to get to a different section of the site, find the nav element, menu item, or link and click it. The only exceptions are: (1) the initial entry URL before login, and (2) the `dashboardUrl` recovery after login when the post-login page is unknown.

**When you hit a wall, DO NOT improvise blindly.** Follow this escalation:

```
1. STOP — don't try 5 variations of evaluate or DOM manipulation
2. READ existing code that solves this pattern:
   - readers/tasks/download-transactions.js — selectTimePeriod(), selectDropdownOption(), fillDateInput()
   - readers/tasks/download-statements.js — Chase saveMenu/directLink patterns, stale DOM purge
   - readers/institutions/<bank>.js — the bank's existing config (if re-learning)
3. READ the template index:
   - readers/institutions/templates/GUIDE.md — pattern lookup tables, component cheat sheet, obstacle solutions
   - readers/institutions/templates/*.js — proven config structures with comments
4. APPLY the proven pattern to your current situation
5. THEN retry in the explorer with an informed approach
```

The codebase IS the answer key. Templates and working configs contain proven solutions for shadow DOM components, custom dropdowns, modal interactions, date pickers, and download flows. Check them BEFORE guessing.

**If you find a bug in the exploration tools themselves** (`explore-interactive.js`, `browser-reader.js`, `run.js`, `download-transactions.js`), you have permission to fix them. Fix the root cause, not just the symptom.

## Inputs

The user provides:
- **Institution name** (slug, e.g., `mybank`)
- **Login URL** (e.g., `https://www.mybank.com/signin`)
- **Credential env var names** — convention is `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` where the slug is uppercased with hyphens removed (e.g., `capital-one` → `CAPITALONE_USERNAME` / `CAPITALONE_PASSWORD`). Already in `.env`.

To verify credentials are set, use: `node scripts/check-env.js CAPITALONE_USERNAME CAPITALONE_PASSWORD`
Or check all vars for an institution: `node scripts/check-env.js --prefix CAPITALONE`

## Before Starting: Check Existing Work

**If re-learning an existing institution** (the config file already exists at `readers/institutions/<bank>.js`):
1. Read the existing config file first — understand what's already known
2. Read `config/institutions-status.md` for notes on this bank's MFA, download patterns, and quirks
3. Only explore what's new or broken — don't rediscover what already works
4. Extend the existing config, don't replace it

**If building a new institution**, check `readers/institutions/templates/` for an existing pattern that matches. Read each template file and compare its login style (iframe vs direct, single vs multi-step) and download pattern to what you see on the live site.

If a template matches:
- Use it as your starting hypothesis — verify each selector against the live site instead of discovering blind
- Replace `institution`, `entryUrl`, `security`, `credentials` with the real values
- The template accelerates Q1 (login), Q7/Q8 (transactions) significantly
- Still verify everything live — templates may be outdated if the bank redesigned

If no template matches, proceed with full discovery below.

## The 15 Questions

You must answer ALL of these. Each question has completion criteria — you are NOT done until every checkbox is checked. Do not move to the next question until the current one is fully complete.

- [ ] **Q1: How do I log in?**
- [ ] **Q2: How do I see balances?**
- [ ] **Q3: How many cash accounts exist?** (checking, savings, balance accounts)
- [ ] **Q4: How many loan/credit accounts exist?** (credit cards, loans, lines of credit)
- [ ] **Q5: What are the balances of the cash accounts?**
- [ ] **Q6: What are the balances of the loan/credit accounts?**
- [ ] **Q7: How do I get transactions for the cash accounts?**
- [ ] **Q8: How do I get transactions for the loan/credit accounts?**
- [ ] **Q9: What are the data semantics?** (sign conventions for debits, credits, balances)
- [ ] **Q10: How do I get the current statement balance for cash accounts?**
- [ ] **Q11: How do I get the current statement balance for credit card accounts?**
- [ ] **Q12: How do I get the current statement balance for loan accounts?**
- [ ] **Q13: How do I get previous/historical statement balances for cash accounts?**
- [ ] **Q14: How do I get previous/historical statement balances for credit card accounts?**
- [ ] **Q15: How do I get previous/historical statement balances for loan accounts?**

**IMPORTANT: Do not call `done` on the explorer until ALL questions are fully answered.** Seeing a download dialog is not the same as discovering all the selectors inside it. You must interact with every control in the download flow.

**IMPORTANT: Q10-Q15 are answered per account type. Do NOT assume one type's answer works for another.** Cash accounts, credit cards, and loans almost always surface statement balances in different places. Each question requires its own navigation, download, and verification.

## How to Answer Each Question

### Q1: How do I log in?

Start the interactive explorer:
```bash
node readers/explore-interactive.js <institution> <login-url> <usernameEnv> <passwordEnv>
```
Run this in the background. Then send commands and read screenshots step by step.

**Step 1: Read the initial screenshot.**
```bash
# Read the annotated screenshot
Read data/explore/<institution>-step-0.png
# Read the element list
Read data/explore/<institution>-state.json
```

The screenshot shows numbered labels `[1]`, `[2]`, `[3]` next to every interactive element. The state file maps each number to its CSS selector.

**Step 2: Identify the login form.**

Look at the screenshot. You'll see one of:
- **Login form visible** — username input `[3]`, password input `[5]`, submit button `[7]`
- **Landing page** — only a "Sign In" button `[2]`, no form yet → click it
- **Cookie banner blocking** — send `dismiss` command first
- **Iframe** — no inputs on main page, but iframes listed with "has inputs" → switch into the frame

**Step 3: Fill credentials and submit.**
```bash
node readers/explore-cmd.js <institution> type 3 "{{USERNAME}}"
node readers/explore-cmd.js <institution> type 5 "{{PASSWORD}}"
node readers/explore-cmd.js <institution> click 7
```
`{{USERNAME}}` and `{{PASSWORD}}` are special tokens — the explorer replaces them with the actual env var values but records the tokens in history. Credentials never appear in logs.

**Step 4: Read the new screenshot.**

After each command, read the new screenshot. You'll see one of:
- **Dashboard** — login succeeded, balances visible
- **MFA page** — code input, "Text me" button, push notification prompt
- **Method selection** — "Continue with Password" / "Use Passkey"
- **Interstitial** — passkey enrollment, promo page → navigate to dashboard URL
- **Error** — wrong credentials, captcha, rate limit

**Step 5: Handle MFA (if present).**

If you see an MFA page:
1. Look for an initiation button ("Text me", "Send code") → click it
2. Wait for code input to appear → `wait 3000` → `screenshot`
3. Ask the user for the MFA code
4. Type the code into the input field
5. Click the submit button ("Next", "Verify", "Submit")
6. Read the new screenshot — should be the dashboard

**Step 6: Inspect the iframe (if login is in one).**

If the login form was in an iframe, you switched into it by index (`frame 100`). But the config needs a CSS selector. Inspect the iframe element:
```bash
node readers/explore-cmd.js <institution> frame main
node readers/explore-cmd.js <institution> evaluate "const iframes = document.querySelectorAll('iframe'); const info = Array.from(iframes).map(f => ({id: f.id, name: f.name, src: f.src?.substring(0,80)})); document.title = JSON.stringify(info)"
```
Record the iframe's `id` (e.g., `iframe#logonbox`) or `name` attribute for the config's `iframeSelector`.

**Step 7: Extract MFA patterns from page text.**

If MFA was triggered, look at the `textPreview` from the MFA page state. Extract the key phrases that indicate MFA:
- Push: "confirm using our mobile app", "push notification", "confirm your identity"
- SMS: "sent a code", "text message", "check your phone"
- Email: "sent to your email", "check your email"

These go into `mfa.pushPatterns`, `mfa.smsPatterns`, or `mfa.emailPatterns`. Extract **at least 2-3 patterns** from the actual text you saw.

**Step 8: Record in config.**

Q1 is complete when ALL of these are recorded:
- [ ] `entryUrl` and `security.expectedDomain`
- [ ] `credentials.usernameEnv` and `passwordEnv`
- [ ] `login.usernameSelector`, `passwordSelector`, `submitSelector`
- [ ] `login.iframePattern` and `iframeSelector` (if applicable)
- [ ] `login.landingPage` and `signInSelector` (if applicable)
- [ ] `login.multiStep` and `nextButtonSelector` (if applicable)
- [ ] `login.methodSelectionSelector` (if applicable)
- [ ] `mfa.push`/`sms`/`email` — which types exist
- [ ] `mfa.pushPatterns`/`smsPatterns`/`emailPatterns` — extracted from actual page text
- [ ] `mfa.mfaInitiationSelector` — e.g., `button:has-text("Text me")` (if applicable)
- [ ] `mfa.codeInputSelectors` and `codeSubmitSelector` (if SMS/email MFA)
- [ ] `login.interstitials` (if passkey enrollment or promos appeared)

Write these into the config file now. Don't wait until the end.

### Q2: How do I see balances?

After login, you should be on a dashboard. Read the screenshot — do you see balances?

- **Yes, balances visible** — the `textPreview` in the state file should contain dollar amounts. Record the dashboard URL as `dashboardUrl` if it differs from `entryUrl`.
- **Page seems empty** — the SPA may not have rendered. Send `wait 5000` then `screenshot`.
- **Wrong page** — you may be on a promo or interstitial. Navigate to the actual dashboard URL.

Balance extraction uses the LLM approach — page text is captured and saved as `pendingExtraction`. The agent extracts structured balances from the text. No external API calls. You don't need selectors for individual balance elements.

**Extract `loggedInPatterns` NOW.** Read the dashboard `textPreview`. Pick **at least 3 phrases** that appear on the dashboard but would NOT appear on the login page. Good examples:
- Account type names: "checking", "savings", "credit card"
- Greeting text: "good morning", "good afternoon", "good evening"
- Dashboard sections: "bank accounts", "account summary", "recent activity"
- Account-specific names: "sapphire", "freedom", "prime visa"

Write these into `login.loggedInPatterns` in the config. The browser-reader uses these to detect whether login succeeded.

Q2 is complete when:
- [ ] Dashboard is visible with balances
- [ ] `dashboardUrl` recorded (if different from entryUrl)
- [ ] `loggedInPatterns` extracted (at least 3 phrases from actual dashboard text)
- [ ] Text length > 300 chars confirmed

### Q3 & Q4: How many accounts exist?

**Scroll through the ENTIRE dashboard.** Accounts are often grouped in sections (bank accounts, credit cards, investments) that extend below the fold. Scroll down repeatedly, taking screenshots, until you see the page footer or content starts repeating. Do NOT assume the first screenshot shows all accounts.

For each account found, record:
- **Account name** (as displayed)
- **Last-4 digits** (critical for matching)
- **Type**: checking, savings, credit, brokerage, retirement, education, mortgage
- **Liability flag**: credit cards, mortgages, and loans are liabilities — balances should be NEGATIVE

Q3 & Q4 are complete when:
- [ ] Scrolled to the bottom of the dashboard — saw ALL account sections
- [ ] Every account listed with name, last-4, type
- [ ] Accounts written to `config/accounts.json`

### Q5 & Q6: What are the balances?

Write the config file now (login + security + credentials + mfa + extraction sections — transactions will be added in Q7/Q8). Then verify the LLM extraction picks up all accounts:
```bash
node readers/run.js <institution> --balances
```

If any are missing, the dashboard text may not contain enough information. Check:
- Is the page fully loaded? (text length should be >300 chars)
- Did the `extract-balances.js` task navigate away from the dashboard? Check if `dashboardUrl` is needed.
- Are the `loggedInPatterns` too generic? They should match dashboard content but NOT the login page.

Q5 & Q6 are complete when:
- [ ] Config file written at `readers/institutions/<institution>.js`
- [ ] `run.js --balances` succeeds and outputs correct balance count
- [ ] All accounts from Q3/Q4 appear in the output with correct balances

### Q7 & Q8: How do I get transactions?

**This is the most complex question. Do NOT stop at finding the download button. You must interact with every control in the download flow, record every selector, and trigger an actual download.**

**Step 1: Find the download entry point.**

You may need to navigate from the dashboard into an account detail page first. Look for:
- A download/export icon on the account activity page
- A "Statements & documents" tab or link
- A "Download" or "Export" button on the dashboard

If you don't see a download option on the dashboard:
1. Click into an account (checking or credit card)
2. Look for download/export icons near the transaction list
3. Scroll down — the download icon may be below the fold near the transactions table

Record the selector of whatever you click to open the download flow.

**Step 2: Identify the download pattern.**

Read the new screenshot after clicking. You'll see one of:

| What you see | Pattern | Next action |
|---|---|---|
| Dialog with account/file type/activity dropdowns | **A: Central dialog** | Interact with EACH dropdown |
| Account-specific page with download link | **B: Per-account** | Click download, find date range |
| Statements page with PDF links | **C: PDF statements** | Click a statement download |
| Modal with calendar date picker | **D: Export modal** | Navigate the date picker |
| Instant CSV download | **E: Direct export** | Verify the file |

**Step 3: Discover EVERY selector in the download flow.**

**This is where you must be thorough.** For each pattern:

**Pattern A (Central dialog) — required selectors:**
1. Click the **Account dropdown** → record its trigger selector.
2. **Open the dropdown and read ALL the options.** Take a screenshot. Verify every account from Q3/Q4 appears. Record the dropdown selector (e.g., `#select-account-selector`).
3. Select a **different account** from the dropdown (not the default). Confirm it switches. This proves the dropdown works.
4. Click the **File type dropdown** → record trigger. Look for "CSV" or "Spreadsheet". Record the selector and the **exact label text** (e.g., `'Spreadsheet (Excel, CSV)'`).
5. Click the **Activity dropdown** → record trigger. Look for "All transactions" or date range options. Record the selector and **label texts** for both "all" and "date range" modes.
6. If there's a date range option, select it. Find the **from** and **to** date input selectors (e.g., `input[placeholder="mm/dd/yyyy"]`).
7. Find the **Download/Submit button** — record its selector. This is often NOT a generic `button[type="submit"]`. Inspect its `id`, `aria-labelledby`, or `data-testid`.
8. **Actually click Download.** Verify a file is saved to `data/downloads/`.
9. **Check the post-download state.** After download, banks often show a confirmation ("Download other activity", "Download started"). Take a screenshot. Record any button selectors needed to cycle back to the dialog for the next account.

The download task (`download-transactions.js`) iterates through all accounts automatically using these selectors — you don't need to manually download for each account. But you DO need to verify the dropdown contains all accounts and the cycle-back flow works.

**Pattern B (Per-account) — required selectors:**
1. Navigate to one account's activity/detail page → record how you got there (what did you click? last-4 tile? account name link?). The download task navigates by last-4 digits from `accounts.json`.
2. Find the download link/button → record selector
3. Interact with date range picker if present → record selectors
4. Click download → verify file saved
5. Record post-download state (dismiss modal? click X?)
6. Navigate back to dashboard → record back button selector or URL
7. **Navigate to a SECOND account** (different type if possible — e.g., checking then credit card). Verify the download link selector is the same. If different account types have different download flows, record both.

**Pattern C (PDF statements) — required selectors:**
1. Find the statements/documents page → record URL or navigation path
2. Find per-month PDF download links → record selector pattern
3. Download one PDF → verify it's readable
4. Note whether it's per-month or downloadable as a batch (ZIP)

**Pattern D (Export modal) — required selectors:**
1. Find the export/download link → record selector
2. Interact with the date picker → record prev/next month selectors, day button selector
3. Find the export button → record selector
4. If backdrop overlays block clicks, try `evaluate` → note this in config

**Pattern E (Direct export) — required selectors:**
1. Navigate to transaction history page → record selector
2. Find the export button → record selector
3. Click it → verify file saved

**Step 4: Handle custom web components (shadow DOM).**

Many banks use custom elements (`<mds-select>`, `<c1-ease-select>`, `<ui-button>`) with shadow DOM. The interactive explorer CANNOT see inside shadow roots — annotations won't label those elements and `document.querySelector()` in `evaluate` won't find them.

**Use Playwright's `page.locator()` instead — it pierces shadow DOM automatically.** When the explorer can't reach an element, switch to the browser-reader primitive:

```javascript
// This WORKS — Playwright pierces shadow DOM
await page.locator('text=Statements & documents').click();
await page.locator('#select-account-selector').click();

// This DOES NOT WORK — querySelector can't pierce shadow DOM
await page.evaluate(() => document.querySelector('text=Statements').click());
```

When you hit shadow DOM during exploration:
1. **Stop using the explorer** for that navigation step
2. Write a quick Playwright script using `BrowserReader` that logs in and uses `page.locator()` with text matching or ID selectors
3. Capture the page text after navigation to see what's there
4. Record the Playwright locator selector in the config (not the shadow DOM traversal path)

The existing `download-transactions.js` already demonstrates this pattern — study it for the bank you're working on.

**Step 5: Verify the download worked.**

```bash
ls -la data/downloads/
```

Check that a CSV or PDF file was actually saved. If not, the download button may need a different interaction (evaluate click, longer wait, etc.).

Q7 & Q8 are complete when:
- [ ] Download entry point selector recorded
- [ ] Download pattern identified (A-E)
- [ ] **Every dropdown/control in the download flow interacted with** — not just seen
- [ ] Every selector recorded in the config's `transactions` section
- [ ] A file was actually downloaded and verified
- [ ] Post-download flow discovered (confirmation page, cycle-back button, dismiss modal)
- [ ] **Multiple accounts verified** — either all accounts visible in dropdown (Pattern A) or download tested on at least 2 accounts (Pattern B)
- [ ] Different account types checked — do checking and credit cards use the same download path?
- [ ] Config's `transactions` section is fully populated for the identified pattern

### How account matching works

The download task iterates through accounts using `account-matcher.js`, which maps bank display names (e.g., "CHECKING (...XXXX)") to `accounts.json` entries by **last-4 digits**. This means:

1. Every account in `accounts.json` must have a `last4` field
2. The display name in the dropdown/tile doesn't need to match exactly — the matcher finds it by last-4
3. If a new display name appears, the matcher auto-adds it as an alias

When exploring, verify that every account you found in Q3/Q4 is reachable in the download flow — either visible in the account dropdown (Pattern A) or navigable from the dashboard (Pattern B).

**Five proven transaction download patterns:**

| Pattern | How it works | Config key |
|---|---|---|
| **A: Central dialog** | One dialog serves all accounts. Account dropdown + date range + format + download button. | `transactions: { downloadButtonSelector, accountDropdownButton, ... }` |
| **B: Per-account** | Navigate to each account page individually, click download, set date range. | `transactions: { perAccount: true, downloadLinkSelector, ... }` |
| **C: PDF statements** | Download monthly PDF statements. Parse with LiteParse + LLM. | `transactions: { pdfBased: true, statementsUrl, ... }` |
| **D: Export modal** | Modal with calendar date picker. May need evaluate() for backdrop bypass. | `transactions: { exportModal: true, prevMonthSelector, ... }` |
| **E: Direct export** | Navigate to page, click one button, CSV downloads. Simplest pattern. | `transactions: { directExport: true, navigationSelector, exportButtonSelector }` |

**Statements vs current-month transactions:** Statements only cover closed/past months. Current month transactions need a live activity view or an export that includes today's date range. Look for both paths.

## Handling Obstacles

**Before trying to solve any obstacle, check `readers/institutions/templates/GUIDE.md`.** It has lookup tables for login patterns, MFA patterns, download patterns, custom web components, and common obstacle solutions. If the obstacle matches a known pattern, apply the proven solution — don't reinvent it.

When you encounter an obstacle, handle it AND record how you handled it:

| Obstacle | How to handle | Record in config |
|---|---|---|
| Cookie consent banner | Dismiss before login. Add selector to `dismissPopups` in browser-reader.js if not already there. | Part of `dismissPopups` |
| MFA (SMS/device code) | Click initiation button ("Text me", "Send code") → wait for code input → enter code → click submit | `mfa.mfaInitiationSelector`, `mfa.codeSubmitSelector` |
| MFA (email) | Auto-poll via `scripts/gmail-mfa.js` | `mfa.emailPatterns`, `bankEmailSender` |
| MFA (push) | Click push option, wait for approval | `mfa.pushPatterns` |
| Popup/modal | Dismiss it. Add new dismiss selectors to browser-reader.js if needed. | `dismissPopups` patterns |
| Passkey enrollment | Skip by navigating to dashboard URL. Do NOT click Continue. | `login.interstitials` |
| Landing page login | Click "Sign In" to reveal form. May load in iframe. | `login.landingPage`, `login.signInSelector` |
| Method selection | Click "Continue with Password" after email submit. | `login.methodSelectionSelector` |
| Multi-step login | Fill email → Next → fill password → Submit. Adaptive: detect if password already visible. | `login.multiStep`, `login.nextButtonSelector` |
| Individual digit MFA | 6 separate `input[type="tel"]` fields. Click first, type each digit. | `mfa.individualDigitInputs` |
| Backdrop overlay | `locator.click()` fails. Use `page.evaluate(() => el.click())`. | Note in config, use evaluate-based patterns |
| No IDs on inputs | Use `input[name="..."]` or `input[type="..."]` selectors. | Use name-based selectors |
| Dashboard URL differs | Post-login URL != login URL. Balance task navigates to wrong page. | `dashboardUrl` in config |
| Session doesn't persist | Some banks require full login+2FA every run despite persistent profiles. | Note in config comments |
| Custom web components | `<mds-select>`, `<c1-ease-select>`, `<ui-button>`. Click button to open, click option. | Note component type in config |
| Shadow DOM (no annotations) | Elements inside shadow roots are invisible to the explorer's annotations. **Do NOT use `evaluate` with `document.querySelector()`** — it cannot pierce shadow DOM. Instead, use Playwright's `page.locator()` which pierces automatically. Switch from the explorer to the browser-reader primitive for shadow DOM navigation. | Record the Playwright locator selector in config |
| Shadow DOM navigation | Write a Playwright script using `BrowserReader` to log in, then use `page.locator('text=Target Text').click()` or `page.locator('#element-id').click()`. Capture page text after navigation. Study `download-transactions.js` for the existing bank's shadow DOM patterns. | Record working locator selectors in config |
| Collapsed accordions | Expand before clicking download. Check `aria-expanded`. | Expand in download flow |
| SPA stale dropdown DOM | Some SPAs keep dropdown menu items visible in the DOM even after their parent accordion is collapsed. Multiple accounts with the same dropdown pattern (e.g., "Save as PDF") create duplicate element IDs. Fix: purge stale dropdown elements via `el.remove()` after each account's downloads complete. **Always verify with the explorer** by checking element counts via `evaluate` after accordion collapse. | Purge after download, note in config |
| ZIP downloads | "Download all" may produce ZIP. Unzip and process each file. | Handle in download task |
| PDF transactions | Use `lit parse <file.pdf> --format text` → LLM extraction. | LiteParse pipeline |

## Fixing Tools

When a tool breaks on a new pattern, fix it. Common fixes you may need to make:

**`explore-full.js`:**
- New cookie banner type → add selector to the cookie dismissal list at the top
- New MFA initiation button text → add to `initMfaSelectors` list
- New MFA submit button text → add to `codeSubmitSelectors` list
- Input fields with no IDs → already fixed (uses name/type fallback)

**`browser-reader.js`:**
- New dismiss popup selector → add to `dismissSelectors` array in `dismissPopups()`
- New MFA pattern text → add to detection patterns in config
- Backdrop blocking clicks → use `page.evaluate()` click pattern

**`download-transactions.js`:**
- New download pattern → add a new `run<Pattern>()` function and route it in `run()`
- Date picker interaction → build institution-specific logic

**`run.js`:**
- New MFA initiation button → add to generic fallback list or use config selector

### Q9: What are the data semantics?

**This question is answered AFTER Q7/Q8, once you have actual transaction data.** You must understand how this platform represents debits, credits, and balances before the data can be imported correctly.

**Step 1: Inspect the raw transaction data.**

After `run.js --transactions --all` succeeds, read the sync output:
```bash
node -e "const d = JSON.parse(require('fs').readFileSync('data/sync-output/<institution>.json','utf-8')); const txns = d.transactions || []; txns.slice(0,10).forEach(t => console.log(JSON.stringify(t.raw).substring(0,200)))"
```

**Step 2: Determine the transaction format.**

Look at the raw data. You'll see one of:
- **Signed single column**: One amount field. Some amounts positive, some negative. → `format: "signed"`
- **Typed column**: One amount field (always positive) + a separate type column (e.g., "Debit"/"Credit"). → `format: "typed"`
- **Split columns**: Separate debit and credit amount columns. → `format: "split"`

**Step 3: Determine what sign a debit has.**

Find a transaction you can identify as a **debit** (purchase, withdrawal, payment to a vendor). Check: is the raw amount positive or negative?

- Credit card: look for a known merchant purchase (TARGET, AMAZON, a restaurant)
- Checking account: look for a bill payment, Zelle send, or ATM withdrawal
- Savings account: look for a transfer out or withdrawal

Record: `"debit": "negative"` or `"debit": "positive"`

**Step 4: Determine what sign a credit has.**

Find a transaction you can identify as a **credit** (payment received, deposit, refund). Check: is the raw amount positive or negative?

- Credit card: look for an ACH payment, credit, or refund
- Checking account: look for a payroll deposit, transfer in, or refund
- Savings account: look for a deposit or transfer in

Record: `"credit": "positive"` or `"credit": "negative"`

**Step 5: Confirm with the user.**

Present your findings:
> "I inspected the raw transaction data for [institution]. Here's what I found:
> - A purchase at TARGET shows as +$8.38 (positive) in the raw data
> - An ACH payment shows as -$753.56 (negative) in the raw data
> - This means debits are positive and credits are negative (issuer perspective)
> - Import will flip signs so purchases become negative (money out) in the database
> Does this look correct?"

**Step 6: Select validation anchors.**

Pick 2-3 transactions that are unambiguously identifiable as debits or credits. These will be checked on every future import to verify the convention hasn't changed:

- A well-known merchant purchase (TARGET, AMAZON, STARBUCKS) → known debit
- A payroll or payment deposit → known credit
- A recurring subscription → known debit

**Step 7: Write to `config/data-semantics.json`.**

Read the existing file and add the new institution entry:
```json
"<institution>": {
  "transactionConvention": {
    "format": "signed",
    "debit": "positive",
    "credit": "negative"
  },
  "balanceConvention": {
    "<accountType>": "<what positive balance means>"
  },
  "anchors": [
    { "descriptionPattern": "TARGET", "is": "debit", "rawSign": "positive" },
    { "descriptionPattern": "ACH DEPOSIT", "is": "credit", "rawSign": "negative" }
  ],
  "learnedAt": "<today's date>",
  "learnedFrom": "<what you inspected>"
}
```

For **typed** format (unsigned amounts with type column), also include:
```json
"transactionConvention": {
  "format": "typed",
  "typeColumn": "Transaction Type",
  "debitValue": "Debit",
  "creditValue": "Credit",
  "amountSign": "unsigned (always positive)"
}
```

**Step 8: Re-import and validate.**

Run the import with validation:
```bash
node sync-engine/import.js --bank <institution>
```

Check the output for "Data semantics validation passed" or warnings. If warnings appear, the convention you recorded may be wrong — go back to Step 3.

Then spot-check in the database:
```bash
node -e "const db = require('better-sqlite3')('data/foliome.db'); db.prepare(\"SELECT date, description, amount FROM transactions WHERE institution = '<institution>' ORDER BY date DESC LIMIT 5\").all().forEach(r => console.log(r.date, r.amount > 0 ? '+' : '', r.amount.toFixed(2), r.description.substring(0,50)))"
```

Verify: purchases should be negative, deposits/payments should be positive.

Q9 is complete when:
- [ ] Transaction format identified (signed, typed, or split)
- [ ] Sign of debit determined and recorded
- [ ] Sign of credit determined and recorded
- [ ] Balance convention documented for each account type
- [ ] Validation anchors selected (at least 2)
- [ ] Written to `config/data-semantics.json`
- [ ] Import runs with validation passing
- [ ] Spot-check confirms correct signs in database

### Q10: How do I get the most recent statement closing balance for cash accounts?

Skip if this institution has no checking or savings accounts.

**Step 1: Read the dashboard text from Q2. For EACH cash account, search for a statement balance label.**

Look for text near the account like "Last statement balance", "Previous balance", "Statement balance", "Interest saving balance". Record the exact label and dollar amount if found.

**Step 2: If not found on dashboard — navigate to the statements/documents section.**

Use the browser-reader primitive (`page.locator()` — pierces shadow DOM):
```javascript
const reader = new BrowserReader(config);
// ... login ...
await reader.page.locator('text=Statements').first().click({ timeout: 10000 });
```
Capture the page text after navigation. Record:
- [ ] The exact selector that got you there (e.g., `text=Statements & documents`)
- [ ] The URL after navigation
- [ ] The full page text (first 3000 chars)

**Step 3: On the statements page, find the cash account's statements.**

Read the page text. Is there an account selector (dropdown, tabs, list)? Record:
- [ ] How accounts are listed (all visible, or one at a time with a selector?)
- [ ] The selector to choose a specific cash account
- [ ] What information is shown per statement — dates only? dates + balances? download links?

**Step 4: Determine the source — is the closing balance visible in HTML, or do you need to download a PDF?**

- If the page shows closing balances inline (e.g., "Mar 17 — $12,278.90") → capture the text. Record the text pattern. This is your source.
- If the page shows only dates and download links → you need the PDF. Proceed to Step 5.
- If there is no statements section but the transaction CSVs include a running `Balance` column → check for a natural month-end anchor like "Monthly Interest Paid" on the last day of each month. The balance after this transaction IS the month-end closing balance. Source: `csv-balance-column`. Record the anchor description and date pattern in the config. No additional navigation needed — data comes from the existing CSV download pipeline (Pattern S-E).
- If there is no statements section for cash accounts → record "not available" and move on.

**Step 5: If PDF required — download ONE statement, parse it, and verify it contains closing balance data.**

1. Click the download link for the most recent cash account statement
2. Record the exact selector you clicked (e.g., link text, button selector, aria-label)
3. Verify file saved: `ls -la data/downloads/` — record the filename
4. Parse: `liteparse parse data/downloads/<file>.pdf`
5. Read the parsed output. Search for and record the EXACT text containing:
   - [ ] Statement period start date — record the line (e.g., `Statement Period: Feb 13, 2026`)
   - [ ] Statement period end date — record the line (e.g., `through Mar 12, 2026`)
   - [ ] Opening/beginning balance — record the line (e.g., `Beginning Balance on Feb 13  $  100.00`)
   - [ ] Closing/ending balance — record the line (e.g., `Ending Balance on Mar 12, 2026  $  100.00`)
6. If any field is missing, note which one and whether the PDF has it under a different name

**Step 6: Record the actual extracted values.**

Write down: "For [account name], the most recent statement period is [start] to [end], closing balance is $[amount]." This is the proof that the pipeline works.

Q10 is complete when:
- [ ] Every cash account checked on dashboard for statement balance labels
- [ ] If not on dashboard: navigated to statements page — selector recorded
- [ ] Statements page text captured — account selection method recorded
- [ ] Source determined: dashboard text, HTML page, PDF, or not available
- [ ] If PDF: one statement actually downloaded — download selector recorded, filename recorded
- [ ] If PDF: statement parsed — exact text lines for period dates and balances recorded
- [ ] Actual closing balance value written down as proof
- [ ] All selectors written to config `statementBalances.checking` / `.savings`

### Q11: How do I get the most recent statement closing balance for credit card accounts?

Skip if this institution has no credit cards.

**Step 1: Read the dashboard text from Q2. For EACH credit card, search for a statement balance.**

Credit cards commonly show this on the dashboard. Look for:
- "Last statement balance: $X"
- "Interest saving balance: $X"
- "Previous balance: $X"
- "Statement balance: $X"

Check EVERY credit card individually. Different cards may use different labels or may not show it at all.

**Step 2: For each credit card, record what you found.**

| Card | Label found | Amount | Source |
|---|---|---|---|
| Freedom (...7890) | "Interest saving balance" | $340.47 | Dashboard |
| Sapphire (...1234) | "Last statement balance" | $514.99 | Dashboard |
| Prime Visa (...5678) | (not found) | — | Need statements page |

**Step 3: For any card NOT showing a statement balance on the dashboard — navigate to the statements page.**

Same navigation as Q10 Step 2. On the statements page:
- [ ] Select the credit card account — record the selector
- [ ] Check if the closing balance is visible in HTML or requires PDF download

**Step 4: If PDF required — download ONE credit card statement, parse it, verify it has closing balance.**

Same process as Q10 Step 5. Credit card PDFs typically use different field names:
- "Previous Balance" (opening)
- "New Balance" (closing)
- "Payment Due Date"
- "Minimum Payment Due"

Record the exact text lines from the parsed PDF.

**Step 5: Record the actual extracted values for every credit card.**

| Card | Statement period end | Closing balance | Source | Label/field name |
|---|---|---|---|---|
| Freedom (...7890) | ~Mar 5 | -$340.47 | Dashboard | "Interest saving balance" |
| Sapphire (...1234) | ~Mar 20 | -$514.99 | Dashboard | "Last statement balance" |
| Prime Visa (...5678) | Mar 20 | -$126.66 | PDF | "New Balance" |

Q11 is complete when:
- [ ] EVERY credit card checked individually on dashboard — not just one
- [ ] Label text recorded per card (may differ between cards)
- [ ] For cards not on dashboard: statements page navigated, account selected, source determined
- [ ] If PDF: one credit card statement downloaded, parsed, field names and values recorded
- [ ] Actual closing balance values recorded for every card as proof
- [ ] All selectors written to config `statementBalances.credit`

### Q12: How do I get the most recent statement closing balance for loan accounts?

Skip if this institution has no mortgage, loan, or line of credit accounts. Mark N/A and move to Q13.

**Step 1: Check the dashboard text for loan/mortgage statement balances.**

Mortgage dashboards usually show "current principal balance" — this is the LIVE balance, not necessarily the statement closing balance. Look for whether there's a separate "statement balance" or "previous principal balance" shown.

**Step 2: Navigate to the statements page and select the loan account.**

- [ ] Record the selector to navigate to statements
- [ ] Record the selector to choose the loan/mortgage account
- [ ] Capture the page text — what's shown for loan statements?

**Step 3: Download ONE loan statement PDF, parse it, find the principal balance.**

1. Download the most recent statement — record the selector
2. Parse with `liteparse parse`
3. Search for and record the exact text containing:
   - [ ] Statement date or period
   - [ ] Principal balance — record the exact line (e.g., `Principal Balance (Not a Payoff Amount)  $634,362.94`)
   - [ ] Previous principal balance (if shown)
   - [ ] Payment breakdown: principal portion vs interest portion

**Step 4: Confirm the sign convention.**

The principal balance is a LIABILITY. Record it as NEGATIVE in the database. Verify: if the PDF says "$634,362.94", the stored value should be `-634362.94`.

**Step 5: Record the actual extracted value.**

"For [mortgage account], the statement dated [date] shows principal balance of $[amount] (stored as -$[amount])."

Q12 is complete when:
- [ ] Loan accounts identified from Q4 (or marked N/A)
- [ ] Dashboard checked for statement balance vs live balance distinction
- [ ] If PDF: one statement downloaded — selector recorded
- [ ] If PDF: parsed — exact text line for principal balance recorded
- [ ] Actual value written down as proof
- [ ] Sign convention confirmed (negative for liabilities)
- [ ] All selectors written to config `statementBalances.mortgage`

### Q13: How do I get historical statement balances for cash accounts?

**Goal:** Download and parse multiple months of statements to build trend data. This proves the download flow is deterministic and repeatable.

**Step 1: Navigate to the statements page using the selector from Q10.**

Record how many months of statements are visible for cash accounts. Are they paginated? Is there a "Show more" or year selector?

- [ ] Number of months visible: ___
- [ ] Pagination mechanism: ___ (none / "Show more" button / year dropdown / scroll)

**Step 2: Download 3 consecutive statements for ONE cash account.**

For each statement:
1. Click the download link — record the selector pattern. Is it the same selector for every month, or does it contain a date?
2. Verify download: `ls -la data/downloads/`
3. Parse: `liteparse parse data/downloads/<file>.pdf`
4. Extract: period start, period end, opening balance, closing balance

Record the results:

| # | Filename | Period start | Period end | Opening balance | Closing balance |
|---|---|---|---|---|---|
| 1 | (actual filename) | YYYY-MM-DD | YYYY-MM-DD | $X | $X |
| 2 | (actual filename) | YYYY-MM-DD | YYYY-MM-DD | $X | $X |
| 3 | (actual filename) | YYYY-MM-DD | YYYY-MM-DD | $X | $X |

**Step 3: Verify consistency.**

- [ ] The 3 statements cover 3 different consecutive periods (no duplicates)
- [ ] Month N's closing balance equals (or is very close to) month N+1's opening balance
- [ ] The download selector pattern is deterministic — you could write a loop that downloads all of them

**Step 4: Record the deterministic download pattern.**

For the Playwright script to download all historical statements, it needs:
- [ ] Navigation selector to get to statements page
- [ ] Account selector (if per-account view)
- [ ] Download selector pattern — what do you click for each statement? (e.g., the Nth row's download button, a link with date text)
- [ ] How to iterate — are statements in a table? What identifies each row?
- [ ] Post-download behavior — does a modal appear? Does the page change?

Q13 is complete when:
- [ ] 3 PDFs actually downloaded for one cash account — filenames recorded
- [ ] 3 PDFs actually parsed — all values recorded in the table above
- [ ] Consecutive periods verified — no gaps, no duplicates
- [ ] Balance consistency verified — closing N ≈ opening N+1
- [ ] Download selector pattern is deterministic and recorded
- [ ] Iteration method recorded (how to download the next statement)
- [ ] Total available months recorded
- [ ] All selectors written to config

### Q14: How do I get historical statement balances for credit card accounts?

Skip if all credit card statement balances come from dashboard text (S-C) and you don't need historical data beyond the current period.

**Step 1: Navigate to the statements page, select a credit card account.**

- [ ] Can you access credit card statements from the same page as cash account statements?
- [ ] Or is there a separate navigation path? Record the selectors.

**Step 2: Download 3 consecutive credit card statements for ONE card.**

For each statement:
1. Download — record selector
2. Parse with `liteparse parse`
3. Extract: statement closing date, previous balance (opening), new balance (closing)

Record the results:

| # | Filename | Statement date | Previous balance | New balance |
|---|---|---|---|---|
| 1 | (actual filename) | YYYY-MM-DD | $X | $X |
| 2 | (actual filename) | YYYY-MM-DD | $X | $X |
| 3 | (actual filename) | YYYY-MM-DD | $X | $X |

**Step 3: Note differences from cash account PDF format.**

- [ ] Different field names? (e.g., "New Balance" vs "Ending Balance")
- [ ] Different layout? (e.g., summary box at top vs inline)
- [ ] Additional fields present? (minimum due, due date, APR)

Record these — the extraction prompt must handle both formats.

**Step 4: Verify consistency.**

- [ ] 3 different consecutive periods
- [ ] Month N's "New Balance" ≈ month N+1's "Previous Balance"

Q14 is complete when:
- [ ] 3 credit card PDFs actually downloaded — filenames recorded
- [ ] 3 PDFs parsed — all values in table above
- [ ] Format differences from cash account PDFs documented
- [ ] Balance consistency verified
- [ ] All selectors recorded — including any differences from cash account download path

### Q15: How do I get historical statement balances for loan accounts?

Skip if this institution has no loan accounts. Mark N/A.

**Step 1: Navigate to loan statements, same approach as Q12.**

**Step 2: Download 3 consecutive loan statements.**

For each:
1. Download — record selector
2. Parse — extract statement date and principal balance

| # | Filename | Statement date | Principal balance |
|---|---|---|---|
| 1 | (actual filename) | YYYY-MM-DD | $X |
| 2 | (actual filename) | YYYY-MM-DD | $X |
| 3 | (actual filename) | YYYY-MM-DD | $X |

**Step 3: Verify principal decreases over time.**

- [ ] Each month's principal is lower than the previous month (assuming payments being made)
- [ ] The decrease per month is consistent (should be close to the principal portion of the monthly payment)

Q15 is complete when:
- [ ] 3 loan PDFs downloaded and parsed (or marked N/A)
- [ ] Principal balance values recorded and verified decreasing
- [ ] All selectors recorded
- [ ] Written to config

### Recording all statement balance findings

After Q10-Q15, write the complete `statementBalances` section to the config. Every selector must be one that was actually tested and verified.

Each account type with `source: 'pdf'` must provide three download hooks that `download-statements.js` calls:
- `beforeDownloads(page, accountId)` — setup before row iteration (expand accordion, select account tab, etc.)
- `download(page, accountId, rowIdx)` — download one statement PDF, return the Playwright `Download` object
- `afterDownloads(page, accountId)` — cleanup after row iteration (collapse accordion, purge stale DOM, etc.)

The generic wrapper handles navigation, page readiness, iteration over accounts (filtered from `config.accounts` by type) and months, file saving, PDF parsing via LiteParse, and error handling. You only write the Playwright click sequences you discovered during exploration.

```javascript
statementBalances: {
  // Navigation to statements page (shared across account types, or per-type if different)
  statementsNavSelector: 'text=Statements & documents',  // verified in Q10 Step 2
  statementsUrl: 'https://...#/dashboard/documents/...',  // URL after navigation
  pageReadyPatterns: ['ACCOUNT NAME 1', 'ACCOUNT NAME 2'],  // text to wait for (optional)
  errorRetry: { text: "isn't working right now", selector: 'text=Try again' },  // optional

  checking: {
    source: 'pdf',               // or 'dashboard' or 'html' — what actually worked
    // PDF field patterns (exact text from parsed output):
    periodStartPattern: 'Statement Period:',
    periodEndPattern: 'through',
    openingBalancePattern: 'Beginning Balance on',
    closingBalancePattern: 'Ending Balance on',
    monthsAvailable: 12,          // how many months visible on the page
    // Download hooks — the Playwright click sequence you discovered
    beforeDownloads: async (page, accountId) => {
      // Setup: expand section, click tab, select account, etc.
      await page.locator('#checking-section').click({ timeout: 5000 });
      await page.waitForTimeout(2000);
    },
    download: async (page, accountId, rowIdx) => {
      // Download one statement — return the Playwright Download object
      const link = page.locator(`#download-row-${rowIdx}`);
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        link.click({ timeout: 5000 }),
      ]);
      return dl;
    },
    afterDownloads: async (page, accountId) => {
      // Cleanup: collapse section, purge stale DOM elements, etc.
    },
  },
  savings: { /* same structure — agent writes download hooks from Q13 exploration */ },
  credit: {
    currentSource: 'dashboard',   // most recent from dashboard text
    dashboardLabels: {
      // per-card labels discovered in Q11 Step 2
      'institution-card-1': 'Interest saving balance',
      'institution-card-2': 'Last statement balance',
    },
    historicalSource: 'pdf',      // older periods from PDF statements
    closingBalancePattern: 'New Balance',
    openingBalancePattern: 'Previous Balance',
    // Download hooks — accountId distinguishes between multiple cards
    beforeDownloads: async (page, accountId) => {
      // Map accountId to the correct card section
    },
    download: async (page, accountId, rowIdx) => {
      const [dl] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.locator(`#card-download-row-${rowIdx}`).click({ timeout: 5000 }),
      ]);
      return dl;
    },
  },
  mortgage: {
    source: 'pdf',
    closingBalancePattern: 'Principal Balance (Not a Payoff Amount)',
    signConvention: 'negative',   // store as negative (liability)
    download: async (page, accountId, rowIdx) => {
      // Agent writes the discovered click sequence
    },
  },
  brokerage: { source: 'not-available' },
},
```

Import writes to the `statement_balances` table. The dashboard shows "vs. Last Period" using the most recent entry per account.

## Final Verification

After all 15 questions are answered and the config is written, close the interactive explorer (`done`) and test the config through the actual primitive:

**1. Test balances:**
```bash
node readers/run.js <institution> --balances
```
Check: does it log in, extract balances, and write `data/sync-output/<institution>.json`? If MFA is triggered, provide the code.

**2. Test transactions:**
```bash
node readers/run.js <institution> --transactions --all
```
Check: does it download transactions and write them to the output file? Verify the transaction count makes sense.

**3. Test full pipeline:**
```bash
node readers/run.js <institution>
```

**4. Verify statement balances:**
Check that `statementBalances` data was written to the JSON output (for S-A/S-C patterns) and imported to the `statement_balances` table:
```bash
node -e "const db = require('better-sqlite3')('data/foliome.db'); db.prepare(\"SELECT * FROM statement_balances WHERE institution='<institution>'\").all().forEach(r => console.log(r.account_id, r.period_end, r.closing_balance))"
```
Verify: at least one statement balance per account type that has pattern S-A or S-C.
Check: both balances and transactions in one run.

If any step fails, **diagnose and fix the config** — don't just report the error. Common issues:
- Selector changed between explorer and run.js → update config selector
- Shadow DOM element needs evaluate-based click → add custom handler in download-transactions.js
- MFA timeout → increase postLoginWaitMs or adjust MFA flow

**The skill is NOT complete until `run.js` succeeds with both balances and transactions.**

## Tools Available

| Tool | Purpose | When to use |
|---|---|---|
| `node readers/explore-interactive.js <bank> <url> <userEnv> <passEnv>` | **Interactive visual explorer** — background process, step-by-step | Primary exploration tool for all banks |
| `node readers/explore-cmd.js <bank> <action> [args]` | Send commands to the interactive explorer | Every step of exploration |
| `node readers/explore-full.js <url> <userEnv> <passEnv> --profile <name>` | Batch exploration (legacy) — runs all phases at once | Quick scan fallback |
| `node readers/explore.js <url> --profile <name>` | Dump any page without login | Quick page inspection |
| `node readers/run.js <bank> --balances` | Test balance extraction through the primitive | After config is written |
| `node readers/run.js <bank> --transactions --all` | Test transaction download through the primitive | After transaction config is written |
| `node readers/run.js <bank> --explore` | Login + MFA + dump dashboard via the primitive | Testing the config's login flow |

### Interactive Explorer Commands

| Command | Example | What it does |
|---|---|---|
| `screenshot` | `explore-cmd.js <bank> screenshot` | Retake annotated screenshot |
| `click <N>` | `explore-cmd.js <bank> click 5` | Click element [5] |
| `type <N> <text>` | `explore-cmd.js <bank> type 3 "{{USERNAME}}"` | Type into element [3] |
| `key <key>` | `explore-cmd.js <bank> key Enter` | Press a keyboard key |
| `scroll <dir> [px]` | `explore-cmd.js <bank> scroll down 500` | Scroll the page |
| `frame <N>` | `explore-cmd.js <bank> frame 100` | Switch into iframe [100] |
| `frame main` | `explore-cmd.js <bank> frame main` | Switch back to main page |
| `navigate <url>` | `explore-cmd.js <bank> navigate https://...` | Go to URL |
| `dismiss` | `explore-cmd.js <bank> dismiss` | Dismiss popups/banners |
| `wait <ms>` | `explore-cmd.js <bank> wait 5000` | Wait for page to settle |
| `back` | `explore-cmd.js <bank> back` | Browser back |
| `evaluate <js>` | `explore-cmd.js <bank> evaluate "el.click()"` | Run JS in page context |
| `done` | `explore-cmd.js <bank> done` | Close browser, save history |

**Credential tokens:** Use `{{USERNAME}}` and `{{PASSWORD}}` in `type` commands. The explorer replaces them with env var values but records the tokens (not actual values) in history.

## MFA Bridge

When running in the background, MFA codes are exchanged via files:
- Script writes: `data/mfa-pending/<institution>.request.json`
- Orchestrator writes: `data/mfa-pending/<institution>.code`
- Script reads the code and continues

To submit a code: `node -e "require('./readers/mfa-bridge').submitCode('<institution>', '<code>')"`

## Reference: Config Template

```javascript
const accounts = require('../../config/accounts.json');

module.exports = {
  institution: '<institution>',
  entryUrl: '<login-url>',
  dashboardUrl: '<post-login-url>',  // if different from entryUrl

  security: {
    expectedDomain: '<domain>',
    requireHttps: true,
  },

  credentials: {
    usernameEnv: '<SLUG>_USERNAME',   // Slug uppercased, hyphens removed (e.g., capital-one → CAPITALONE)
    passwordEnv: '<SLUG>_PASSWORD',
  },

  login: {
    landingPage: false,          // true if login form is behind a "Sign In" click
    signInSelector: null,        // e.g., 'text=Sign In'
    iframePattern: null,
    iframeSelector: null,
    usernameSelector: '<selector>',
    passwordSelector: '<selector>',
    submitSelector: '<selector>',
    multiStep: false,
    nextButtonSelector: null,
    methodSelectionSelector: null,  // e.g., 'button:has-text("Continue with Password")'
    postLoginWaitMs: 5000,
    loggedInPatterns: [],        // text that appears on dashboard but NOT login page
    interstitials: [],           // [{ urlPattern, action: 'skip', targetUrl }]
  },

  mfa: {
    sms: false, email: false, push: false,
    bankEmailSender: null, bankEmailSubject: null,
    smsPatterns: [], emailPatterns: [], pushPatterns: [],
    mfaInitiationSelector: null,  // e.g., 'button:has-text("Text me")'
    codeInputSelectors: ['input[type="tel"]', 'input[type="text"]'],
    codeSubmitSelector: null,     // e.g., 'button:has-text("Next")' — null for auto-submit
    trustDevicePatterns: [],
    individualDigitInputs: false, // true for Apple-style 6 separate inputs
  },

  transactions: {
    // === Choose ONE pattern ===
    //
    // Pattern A — Central dialog:
    // downloadButtonSelector, accountDropdownButton, fileTypeDropdownButton,
    // activityDropdownButton, downloadSubmitSelector
    //
    // Pattern B — Per-account:
    // perAccount: true, downloadLinkSelector, timePeriodOptions,
    // downloadSubmitSelector, postDownloadDismiss, backButtonSelector
    //
    // Pattern C — PDF statements:
    // pdfBased: true, statementsUrl
    //
    // Pattern D — Export modal:
    // exportModal: true, statementsLinkSelector, exportLinkSelector,
    // prevMonthSelector, dayButtonSelector, exportButtonSelector
    //
    // Pattern E — Direct export:
    // directExport: true, navigationSelector, exportButtonSelector
  },

  accounts: accounts['<institution>']?.accounts || [],

  extraction: async (page, accountList) => {
    const { extractBalances } = require('../llm-extract');
    const pageText = await page.evaluate(() => document.body.innerText);
    if (pageText.length < 100) throw new Error('Dashboard text too short');
    const result = await extractBalances(pageText, '<institution>', accountList);
    return { balances: result.balances || [], transactions: [], holdings: [] };
  },
};
```

## Reference: Existing Configs

Before building a new config, study the existing working examples in `readers/institutions/`. Each demonstrates a different combination of login flow, MFA type, and download pattern:

```bash
ls readers/institutions/*.js
```

Read 2-3 existing configs to understand the structure. Pay attention to:
- **Login variations**: iframe login, multi-step login, landing page login, method selection
- **MFA variations**: push (two-step), SMS with initiation button, device code (individual digit inputs), email auto-poll
- **Download patterns**: central dialog with custom dropdowns, per-account navigation, PDF statements, export modal with date picker, direct single-button export
- **Obstacle handling**: cookie banners, passkey interstitials, backdrop overlays, custom web components with shadow DOM, dashboard URL differing from entry URL
- **Account types**: checking, savings, credit, brokerage, retirement, education, mortgage — each with correct sign conventions (liabilities are negative)
