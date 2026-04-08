# Institution Templates — Pattern Index

When exploring a new bank or debugging an existing one, use this index to identify which template matches what you're seeing.

## Which template am I looking at?

### Login Pattern

| What you see | Template |
|---|---|
| Username + password on the main page, no iframe | `direct-login-*` |
| Login form inside an `<iframe>` (check DevTools) | `iframe-login-*` |
| "Sign In" button on a landing/marketing page → iframe appears | `iframe-multistep-export-modal` |
| Email → Continue → method selection → password (multi-step) | `*-multistep-*` |
| Passkey enrollment interstitial after login | `multistep-webauthn-pdf-statements` |
| Cookie consent banner blocking login | `direct-login-brokerage` (OneTrust pattern) |
| Post-login interstitial (contact review, enrollment) | `direct-login-central-download-page` |
| Iframe login that frame-busts (parent page navigates away after submit) | `iframe-framebust-export-modal` |

### MFA Pattern

| What you see | Template |
|---|---|
| "Text me the code" / "Send code" button → single input | `direct-login-direct-export`, `direct-login-brokerage` |
| Push notification / mobile app approval | `iframe-login-central-dialog` |
| 6 individual digit inputs (Apple-style) | `iframe-multistep-export-modal` |
| SMS + email + push (all three) | `direct-login-per-account-download`, `iframe-login-central-dialog` |
| Phone number list → evaluate-based JS click (Playwright click causes logout) | `direct-login-central-download-page` |
| Method selection tiles (SMS / push / call) → phone selection modal → code | `iframe-framebust-export-modal` |

### Transaction Download Pattern

| What you see | Template | Pattern |
|---|---|---|
| One dialog with account/file type/activity dropdowns | `iframe-login-central-dialog` | **A: Central dialog** |
| Navigate to each account page, click download | `direct-login-per-account-download` | **B: Per-account** |
| Statements page with per-month PDF download links | `direct-login-pdf-statements` | **C: PDF statements** |
| Statements page → yearly ZIP of monthly PDFs | `multistep-webauthn-pdf-statements` | **C: ZIP variant** |
| Modal with calendar date picker for export | `iframe-multistep-export-modal` | **D: Export modal** |
| Transaction History page → single "Export" button | `direct-login-direct-export` | **E: Direct export** |
| Separate download PAGE with combobox dropdown, readonly dates, radio format | `direct-login-central-download-page` | **A variant: Download page** |
| Shadow DOM nav → account selector + date range + export modal (CSV/JSON/XML) | `iframe-framebust-export-modal` | **A variant: Export modal** |

### Statement Balance Pattern

| What you see | Template | Pattern |
|---|---|---|
| PDF statements with "Beginning/Ending Balance" | `direct-login-pdf-statements` | **S-A** |
| PDF statements with "Beginning/Ending Account Value" (brokerage) | `iframe-framebust-export-modal` | **S-A** |
| HTML page listing periods with balances inline | `iframe-multistep-export-modal`, `multistep-webauthn-pdf-statements` | **S-B** |
| Dashboard shows "Last statement balance: $X" | `iframe-login-central-dialog` (credit cards) | **S-C** |
| No statement balance concept (investment/529) | `direct-login-direct-export`, `direct-login-brokerage` | **S-D** |
| CSV has running "Balance" column + month-end anchor | `direct-login-per-account-download` | **S-E** |

## Custom Web Component Cheat Sheet

When the explorer can't see elements (0 annotations in a section), you've hit shadow DOM.

| Component | Bank | How to interact |
|---|---|---|
| `<mds-select>`, `<mds-button>`, `<mds-list-item>` | Chase | `document.querySelector('#elementId').click()` for host elements |
| `<c1-ease-select>` | Capital One | Click `.c1-ease-select-trigger` to open → click `[role="option"]` to select |
| `<ui-button>`, `<ui-pane-backdrop>` | Apple Card | `page.evaluate(() => el.click())` to bypass backdrop overlays |
| Native `<select>` in Angular/React | NetBenefits | Needs Playwright `selectOption()` — explorer evaluate can't trigger framework bindings |
| `div[role="combobox"]` with `li[role="option"]` | Wells Fargo | Click combobox to open → click `[role="option"]` to select — handled by `getDropdownOptions()` |

## Common Obstacles Quick Reference

| Problem | Solution | Where it's implemented |
|---|---|---|
| Dropdown items have duplicate IDs across accordions | Purge stale elements via `el.remove()` in `afterDownloads` hook | Institution config (Chase) |
| Download button stays disabled after filling dates | Click inside the modal (not outside) to blur input and trigger Angular validation | `download-transactions.js` (Capital One) |
| Credit card PDF link opens viewer, not download | Use `-download` link, not `-pdf` link in the `download` hook | Institution config (Chase) |
| Modal closes when clicking outside | Keep all interactions inside `.cdk-overlay-container` | Capital One pattern |
| `page.reload()` doesn't clear SPA state | SPA hash navigation preserves stale DOM — purge in `afterDownloads` hook | Institution config (Chase) |
| Explorer downloads disappear after `done` | Downloads go to `data/downloads/explorer/` (configured via `downloadsPath`) | `explore-interactive.js` |
| Readonly date inputs (`.fill()` fails) | Remove readonly via JS, set value via native setter, dispatch input+change events | `direct-login-central-download-page` template |
| Playwright click causes logout on MFA buttons | Use `evaluateClick` in `mfaSteps` — JS click from page context avoids trusted event detection | `direct-login-central-download-page` template |
| CSV has no header row | Provide `csvColumns` array in transactions config — `parseCSV` uses these as column names | `direct-login-central-download-page` template |
| File format uses radio buttons (not dropdown) | Provide `selectFileFormat` async function — checks `aria-checked` before clicking | `direct-login-central-download-page` template |

## Template Summary

| Template | Login | MFA | Transactions | Statement Balances |
|---|---|---|---|---|
| `iframe-login-central-dialog` | Iframe, single-step | SMS/email/push | A: Central dialog | S-A/S-C mixed |
| `direct-login-per-account-download` | Direct, single-step | SMS/email/push | B: Per-account CSV | S-E: CSV balance column |
| `direct-login-pdf-statements` | Direct, single-step | None | C: PDF statements | S-A: PDF balances |
| `multistep-webauthn-pdf-statements` | Multi-step, WebAuthn bypass | SMS/email | C: ZIP of PDFs | S-B: HTML statement list |
| `iframe-multistep-export-modal` | Landing page → iframe, multi-step | Device code (6 digits) | D: Export modal | S-B: HTML statement list |
| `direct-login-direct-export` | Direct, no IDs | SMS | E: Single button | S-D/S-E: varies |
| `direct-login-brokerage` | Direct, cookie banner | SMS | TBD | S-B/S-D: varies |
| `direct-login-central-download-page` | Direct, single-step | SMS (evaluateClick) | A variant: download page, readonly dates, radio format, headerless CSV | S-A: PDF |
| `iframe-framebust-export-modal` | Iframe, frame-busting MFA | SMS (multi-step) / push | A variant: shadow DOM nav + export modal | S-A: PDF (brokerage/IRA) |
