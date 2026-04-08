---
name: getting-started
description: Guided first-bank setup — credentials, exploration, sync, extraction, import
trigger: manual
---

# Getting Started

Walk a new user through setting up their first bank integration end-to-end. This skill orchestrates existing primitives — it doesn't introduce new infrastructure.

## When to activate

Suggest this skill when:
- The user says "get started", "set up", "first bank", or "how do I use this"
- No institution configs exist in `readers/institutions/` (only templates)

Detection: check if `readers/institutions/` contains any `.js` files at the top level (not in `templates/`). If none exist, suggest: "It looks like you haven't set up any banks yet. Run `/getting-started` to set up your first one."

## Procedure

### Step 1: Welcome + dependency check

"Welcome to Foliome. Let's set up your first bank."

Run `./setup` to verify all dependencies are installed. The setup script is idempotent — it checks Node.js, npm packages, Playwright browsers, SQLite, and the classifier model. It creates `.env` from the template if it doesn't exist. If any dependency is missing, the script offers to install it.

Wait for setup to complete before continuing. If it fails on a step the user needs to handle manually (e.g., installing Node.js), help them through it.

### Step 2: Choose a bank

Ask the user: "What bank do you want to start with? Give me the login URL (e.g., https://www.yourbank.com/signin)."

Also ask for the institution slug — a short lowercase name with hyphens (e.g., `my-bank`, `first-national`).

### Step 3: Set up credentials

Tell the user the credential naming convention:
- `<SLUG>_USERNAME` / `<SLUG>_PASSWORD` where the slug is uppercased with hyphens removed
- Example: if the slug is `my-bank`, the env vars are `MYBANK_USERNAME` and `MYBANK_PASSWORD`

Tell the user to add these to their `.env` file manually. Do not read or write `.env` directly.

### Step 4: Validate credentials exist

Run: `node scripts/check-env.js <SLUG>_USERNAME <SLUG>_PASSWORD`

If either shows "NOT SET", ask the user to check their `.env` file and try again. Do not proceed until both are set.

### Step 5: Build the integration

Run `/learn-institution` with the institution name and URL. This skill handles the full exploration: login flow discovery, MFA detection, account enumeration, transaction download pattern identification.

The `/learn-institution` skill will check `readers/institutions/templates/` for matching patterns automatically.

### Step 6: First sync

Run the sync for the new institution only:
```bash
node readers/sync-all.js --bank <institution> --import --classify
```

Run this in the background. Monitor for MFA requests in `data/mfa-pending/`. When MFA triggers, notify the user and wait for their code.

### Step 7: Extract balances

After sync completes, check `data/sync-output/<institution>.json` for `pendingExtraction`. If present, extract structured balances from the raw page text (same process as the `/sync` skill's post-sync extraction).

### Step 8: Verify

Show the user what was captured:
- Number of accounts found
- Balance for each account
- Number of transactions downloaded

If everything looks right: "Your first bank is set up. Here's what you can do next:"
- `/morning-brief` — daily financial summary
- `/brief-me` — ask questions about your finances (spending, portfolio, reports)
- `/sync` — sync all institutions (run this daily)
- `/learn-institution` — add another bank

If something looks wrong, help debug. Common issues:
- MFA wasn't handled (re-run sync)
- Selectors changed since template was written (adaptive bridge should have caught it)
- Balance extraction didn't find all accounts (check `pendingExtraction.balanceText`)

## Key principle

This skill is glue. It orchestrates `/learn-institution`, `/sync`, and the extraction flow that already exist. Do not build new infrastructure — call existing primitives.
