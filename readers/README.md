# Browser Reader Primitive

Config-driven Playwright module (`browser-reader.js`). Each institution provides a config in `institutions/<bank>.js`.

## Config Shape

Each institution config provides:

- Entry URL + dashboard URL + security gate (domain + HTTPS verification)
- Login selectors (supports iframes via `frameLocator`, landing pages, method selection)
- MFA detection patterns (SMS, email, push, device code) + handler selectors + initiation buttons
- Transaction download dialog selectors (six patterns + PDF pipeline)
- Text capture function (page text saved for agent-side balance extraction)
- Interstitial handlers (passkey enrollment, promo pages)
- WebAuthn/passkey guard via CDP virtual authenticator (`disableWebAuthn`) — deferred to post-auth
- System Chrome auto-detection (`executablePath` to real Chrome binary)
- Institution-specific popup dismiss selectors (`popupDismissSelectors`)
- Dashboard URL for post-login recovery (`dashboardUrl`)

## What the Primitive Handles

- Credential resolution via Bitwarden vault or `.env` fallback (`scripts/credentials.js`)
- Persistent Chrome profile per institution (session reuse across runs)
- Security gate before any credentials
- Cookie banner dismissal before login
- Landing page login (click "Sign In" to reveal form)
- Iframe-aware login (via `frameLocator`)
- Multi-step login with method selection
- Adaptive login (detects if password already visible on return visits)
- SPA session detection (retries state detection when no login form found — handles cached sessions that redirect away from login)
- MFA detection → initiation → signal to caller → code entry (single field or individual digits) or push wait
- MFA bridge (file-based code exchange for background operation)
- Adaptive bridge (visual help for unknown page states via annotated screenshots)
- Post-login interstitial handling (passkey enrollment → skip to dashboard)
- Pop-up/modal dismissal via 4-tier system: framework IDs → container-scoped consent → modal-scoped → institution-specific
- Dashboard URL recovery for unknown post-login pages
- CDP virtual authenticator for WebAuthn/passkey bypass (activated post-auth to avoid interfering with device-based 2FA)
- CSV download with file capture
- PDF statement download + LiteParse + agent extraction
- Backdrop overlay bypass via `page.evaluate()` clicks

## MFA Handling

MFA is detected from page text patterns (including iframe content) and routed to handlers. Code exchange uses the MFA bridge (`mfa-bridge.js`) for background operation.

- **SMS** — Click initiation button ("Text me", "Send code") → wait for code input to appear → enter code → click submit
- **Email** — Gmail API auto-polls, regex-extracts code, enters automatically. Falls back to SMS.
- **Push** — Click push option, confirm, poll for clearance (up to 180s)
- **Device code** — Code sent to trusted devices. Uses individual digit input fields (6 separate `input[type="tel"]`). Same bridge flow as SMS.
- **TOTP** — Authenticator app (Google Authenticator, Authy, etc.) generates a 6-digit code. Single input field, no initiation button needed. Config uses `totp: true` and `totpPatterns` for detection.
- **Adaptive bridge** — When `_detectState()` returns `'unknown'` (page not recognized as login, dashboard, or MFA), `run.js` enters adaptive mode: takes an annotated screenshot, writes a help request to `data/adaptive-pending/`, and waits for the agent to send instructions. After resolution, discovered patterns are saved so the next run is deterministic.

## CLI

```
node readers/run.js <bank>                          # balances + transactions
node readers/run.js <bank> --balances               # balances only
node readers/run.js <bank> --transactions           # transactions only
node readers/run.js <bank> --transactions --all     # full history (first run)
node readers/run.js <bank> --transactions --from 2026-02-01 --to 2026-03-19  # date range
node readers/run.js <bank> --explore                # dump page structure
node readers/explore-interactive.js <bank> <url> <userEnv> <passEnv>  # interactive visual explorer
node readers/explore-cmd.js <bank> <action> [args]  # send commands to interactive explorer
node readers/explore.js <url> --profile <name>      # explore any login page
node readers/sync-all.js                            # sync all institutions in parallel
node readers/sync-all.js --bank <name>              # sync single institution only
```
