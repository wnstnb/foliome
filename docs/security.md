# Security Model

Foliome handles bank login credentials and financial data. This document explains exactly how that data is protected at every layer — from credential storage through browser automation to dashboard serving.

## Credential Lifecycle

Credentials never exist as plaintext at rest. The lifecycle:

```
User adds credentials to .env (or Bitwarden vault)
    ↓
Pre-flight encryption (automatic, every sync)
    ↓
.env on disk contains encrypted blobs — unreadable without .env.keys
    ↓
At runtime: dotenvx decrypts into process memory
    ↓
Playwright types credentials into bank login form
    ↓
Process exits — plaintext gone from memory
```

**What the agent sees:** Nothing. Syncs run as background child processes. The agent only sees stdout status messages like `[chase] Login submitted`. The codebase never prints credentials to stdout — no logging, no output, no file written.

**Two credential backends:**

1. **Bitwarden vault (recommended)** — credentials fetched from an encrypted vault at login time. Only the Bitwarden API key and master password touch `.env` (encrypted by dotenvx). Each institution is explicitly mapped via `config/credential-map.json` — the runtime can only fetch item IDs listed in that file. It never runs `bw list`, `bw search`, or browses the vault.

2. **.env fallback** — credentials stored directly in `.env` as `<SLUG>_USERNAME` / `<SLUG>_PASSWORD`. Encrypted at rest by dotenvx. The `.env.keys` file holds the decryption key and is gitignored.

### Credential Resolution Order

When `getCredentials(institution, credentials)` is called at login time:

1. Check `config/credential-map.json` for a Bitwarden vault item ID mapped to this institution
2. If found → `bw get item <id>` to fetch credentials from vault
3. If not found or Bitwarden unavailable → fall back to `process.env` (decrypted by dotenvx)

### Flow 1: New User With .env Credentials

```
1. User clones repo, creates .env:
   CHASE_USERNAME=myuser
   CHASE_PASSWORD=mypassword

2. User talks to the agent ("sync my accounts", "add a new bank", etc.)

3. Pre-flight runs automatically (scripts/encrypt-env.js):
   - Scans .env for sensitive keys (*_USERNAME, *_PASSWORD, BW_*)
   - Detects CHASE_USERNAME and CHASE_PASSWORD are plaintext
   - Encrypts them via dotenvx → values become encrypted:BKJx...
   - .env.keys created with decryption key (gitignored)

4. .env now looks like:
   CHASE_USERNAME="encrypted:BKJxjW6op8dk..."
   CHASE_PASSWORD="encrypted:BGdMHM+J3s35..."

5. At sync time:
   - dotenvx loads .env, decrypts using .env.keys
   - process.env.CHASE_USERNAME has the plaintext (in memory only)
   - browser-reader.js types it into the login form
   - Process exits, plaintext gone
```

The user never needs to run encryption manually. The pre-flight runs before every sync and catches any new plaintext credentials.

**Important:** All credentials must be single-quoted in `.env` (e.g., `PASSWORD='my#pa$$word'`). Single quotes prevent `#` truncation, `$` interpolation, and backtick expansion. The pre-flight encryption script enforces this automatically.

### Flow 2: Setting Up Bitwarden

```
1. User gets Bitwarden API key from vault settings, adds to .env:
   BW_CLIENTID=user.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   BW_CLIENTSECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   BW_PASSWORD="MyMasterPassword"

2. Pre-flight encrypts all three BW_* values automatically.

3. User asks agent to set up vault mapping:
   - Agent runs: node scripts/vault.js list-banks
   - Output shows item names + first 3 chars of username + Bitwarden item IDs
   - Agent asks user to confirm which items map to which institutions

4. Agent maps each institution:
   - node scripts/vault.js map chase <item-id>
   - Writes to config/credential-map.json (safe to commit — IDs are not secrets)

5. At sync time:
   - sync-all.js unlocks Bitwarden once, shares session with all child processes
   - Each bank's login calls getCredentials(institution, config)
   - getCredentials checks credential-map.json → finds Bitwarden item ID
   - Fetches that specific item from vault → returns { username, password }
   - browser-reader.js types credentials into login form
   - Credentials never logged, never printed, never touch disk
```

### Vault Scoping

The runtime credential module (`scripts/credentials.js`) can ONLY fetch item IDs explicitly listed in `credential-map.json`. It never runs `bw list`, `bw search`, or browses the vault. The vault helper (`scripts/vault.js`) is the only place that searches the vault, and it only runs during setup — never during syncs.

### Vault CLI Helper

`scripts/vault.js` — used during setup only, never during syncs:

```
node scripts/vault.js status              # check bw CLI installed, logged in, vault unlocked
node scripts/vault.js list-banks          # search vault for bank login items (masked output)
node scripts/vault.js search <term>       # search vault for any login item by keyword
node scripts/vault.js map <slug> <id>     # add institution → Bitwarden item mapping
node scripts/vault.js test <slug>         # verify credentials can be fetched (masked output)
node scripts/vault.js migrate             # interactive: match institutions to vault items
```

### Required .env Variables

**For Bitwarden (optional, recommended):**
- `BW_CLIENTID` — Bitwarden API client ID
- `BW_CLIENTSECRET` — Bitwarden API client secret
- `BW_PASSWORD` — Bitwarden master password (must be quoted if it contains `#`)

**For .env-only mode (no Bitwarden):**
- `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` per institution (e.g., `CHASE_USERNAME`, `CHASE_PASSWORD`)

The `.env` slug convention: uppercase, hyphens removed (e.g., `capital-one` → `CAPITALONE`, `apple-card` → `APPLECARD`).

**For Dashboard Mini App (optional):**
- `DASHBOARD_BOT_TOKEN` — only needed if the bot sending the `web_app` button differs from `TELEGRAM_BOT_TOKEN`. Auto-detected from the Claude Code Telegram plugin if installed. See `docs/telegram-setup.md` for details.

## Encryption at Rest

`scripts/encrypt-env.js` runs automatically before every sync. It scans `.env` for sensitive key patterns (`*_USERNAME`, `*_PASSWORD`, `BW_PASSWORD`, `BW_CLIENTID`, `BW_CLIENTSECRET`) and encrypts any plaintext values via dotenvx. The user never needs to run encryption manually.

**What gets encrypted:** Bank login credentials and Bitwarden master password — the things that, if leaked, give access to financial accounts.

**What doesn't get encrypted:** API keys (`TELEGRAM_BOT_TOKEN`, etc.) — these are revocable tokens, not bank login credentials. Revoking a token is a one-click operation; changing a bank password is not.

**Non-bypassable enforcement:** The pre-flight runs inside `main()` of every entry point (`sync-all.js`, `run.js`, `explore-interactive.js`) via `execSync`. If dotenvx is not installed, the pre-flight calls `process.exit(1)` — the sync cannot proceed.

## Security Gate

Before Playwright enters any credentials into a page, `security-gate.js` verifies:

1. **Domain match** — the current page URL domain matches the expected domain from the institution config
2. **HTTPS** — the connection is encrypted

If either check fails, the process hard-aborts. No credentials are entered. This prevents credential theft via DNS hijacking, phishing redirects, or man-in-the-middle attacks.

## Browser Isolation

Each institution gets its own persistent Chrome profile under `data/chrome-profile/<institution>/`. Profiles are not shared across institutions — cookies, sessions, and localStorage are isolated.

**System Chrome preferred.** The browser reader auto-detects system Chrome and uses it over Playwright's bundled Chromium. A real browser fingerprint defeats captchas and bot detection that banks use. Falls back to Playwright Chromium if Chrome is not installed.

**WebAuthn/passkey bypass.** Banks that push passkey enrollment get bypassed via a CDP virtual authenticator. This prevents the enrollment interstitial from blocking automation without actually registering a passkey on the user's device.

## Content Security

### Prompt injection defense

`sanitize-text.js` processes all text captured from bank websites before it reaches the agent:

- **Hidden element stripping** — removes text from elements that are visually hidden but present in the DOM (a common injection vector where attackers hide instructions in invisible page elements)
- **Boundary markers** — wraps untrusted content with clear delimiters so the agent can distinguish bank-provided text from system instructions

### Dashboard Content Security Policy

All dashboard responses include a `Content-Security-Policy` header:

```
default-src 'self';
script-src 'self' https://telegram.org;
style-src 'self' 'unsafe-inline';
img-src 'self' https://cdn.simpleicons.org;
frame-src https://www.youtube.com https://www.youtube-nocookie.com;
connect-src 'self';
object-src 'none'
```

This prevents XSS, unauthorized script injection, and data exfiltration from the dashboard.

### Wiki markdown rendering

The wiki tab renders user-controlled markdown content (imported articles, agent-written pages). Security measures:

- **No raw HTML** — `react-markdown` is used without `rehype-raw`, so HTML tags in markdown render as literal text, not DOM elements
- **Blocked protocols** — `javascript:` and `data:` URLs are rendered as plain text, not clickable links
- **No external images** — all image sources are rewritten to go through `/api/wiki/asset`, which enforces path confinement and MIME allowlisting
- **External links** — open in new tabs with `rel="noopener noreferrer"` to prevent `window.opener` attacks

### Wiki asset serving

Wiki assets (images, PDFs) are served through a path-confined pipeline:

1. **Null byte rejection** — blocks null byte injection as the first check
2. **Filename validation** — path components must match `[a-zA-Z0-9._-]`
3. **Path confinement** — `path.resolve()` + `startsWith()` check ensures the resolved path stays within the wiki directory
4. **Symlink rejection** — `fs.lstatSync` rejects symbolic links
5. **Extension allowlist** — only `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, `.pdf` are served. SVG is explicitly excluded (SVG can contain embedded scripts)
6. **MIME enforcement** — `Content-Type` set from a hardcoded map, `X-Content-Type-Options: nosniff` prevents MIME sniffing
7. **PDF download-only** — PDFs are served with `Content-Disposition: attachment` to prevent inline rendering

## Session Security

The dashboard server authenticates via Telegram's HMAC-SHA256 initData:

1. **HMAC validation** — initData is signed by Telegram using the bot token. The server recomputes the HMAC and compares using `crypto.timingSafeEqual()` to prevent timing attacks.
2. **Replay protection** — initData older than 1 hour is rejected (`auth_date` freshness check).
3. **User allowlist** — only the `TELEGRAM_CHAT_ID` in `.env` can access the dashboard.
4. **Session tokens** — 30-minute sliding window with 24-hour absolute maximum. One-time auth tokens (60-second TTL) bridge the initData → session flow.
5. **Token resolution** — the server auto-detects which bot token to validate against (plugin bot → .env bot), preventing silent 403s from token mismatch.

## Data Integrity

- **Failed syncs never destroy good data** — `writeError` preserves the previous successful sync output. A failed sync cannot overwrite a good file with an empty or partial result.
- **Zero-balance protection** — if a sync returns empty balances, the previous data is kept rather than recording zeros.
- **Balance sanity check** — warns on >50% change from last sync, catching extraction errors before they reach the database.
- **Dedup on import** — transactions are deduplicated by composite key (`institution + account_id + date + amount + description_hash`, or `institution + account_id + raw_transaction_id` for API sources). Duplicate imports are idempotent.
- **Atomic writes** — wiki pages and brief files are written atomically (write to `.tmp`, then `fs.renameSync`) to prevent the dashboard from reading half-written files.

## Popup and Overlay Dismissal

Bank websites display cookie banners, promotional modals, and enrollment interstitials that block automation. The dismissal system uses a scoped 4-tier approach to avoid accidentally clicking bank actions:

1. **Framework IDs** — known cookie consent framework element IDs (OneTrust, CookiePro, etc.)
2. **Container-scoped text** — text matching ("Accept", "Continue") only within identified cookie/consent containers
3. **Modal-scoped** — dismiss buttons within modal/dialog elements
4. **Institution-specific** — custom `popupDismissSelectors` from the institution config

No unscoped text matching is used — the system never clicks a button just because it says "Accept" unless it's confirmed to be within a consent context.

## What's Gitignored

The `.gitignore` ensures sensitive files never enter version control:

- `.env`, `.env.keys` — credentials and encryption keys
- `*-tokens.json` — API token storage files
- `data/` — all financial data (sync output, database, chrome profiles, downloads)
- `config/` — all config files (populated from `config-templates/` on setup, contains personal data after customization)
- `.claude/settings.local.json` — local permission rules with personal IDs
