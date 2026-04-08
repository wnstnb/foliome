#!/usr/bin/env node
/**
 * Bitwarden Vault CLI Helper
 *
 * Manage the credential-map.json mapping between institution slugs and Bitwarden vault item IDs.
 * This is the ONLY place that uses `bw list` or `bw search` — the runtime credential module never does.
 *
 * Usage:
 *   node scripts/vault.js status              — check bw CLI installed, logged in, vault unlocked
 *   node scripts/vault.js list-banks          — show Bitwarden items that look like bank logins
 *   node scripts/vault.js search <term>       — search vault for login items matching a keyword
 *   node scripts/vault.js map <slug> <id>     — add an entry to credential-map.json
 *   node scripts/vault.js test <slug>         — verify credentials can be fetched for an institution
 *   node scripts/vault.js migrate             — for each institution in .env, search Bitwarden and map
 */

require('@dotenvx/dotenvx').config({ path: require('path').join(__dirname, '..', '.env') });
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CREDENTIAL_MAP_PATH = path.join(__dirname, '..', 'config', 'credential-map.json');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'config', 'accounts.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIAL_MAP_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveMap(map) {
  const dir = path.dirname(CREDENTIAL_MAP_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIAL_MAP_PATH, JSON.stringify(map, null, 2) + '\n');
}

function getSession() {
  const masterPassword = process.env.BW_PASSWORD;
  if (!masterPassword) {
    console.error('BW_PASSWORD not set in .env');
    process.exit(1);
  }

  try {
    const statusRaw = execSync('bw status', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
    const status = JSON.parse(statusRaw);

    if (status.status === 'unauthenticated') {
      const clientId = process.env.BW_CLIENTID;
      const clientSecret = process.env.BW_CLIENTSECRET;
      if (!clientId || !clientSecret) {
        console.error('BW_CLIENTID and BW_CLIENTSECRET required for login. Set them in .env.');
        process.exit(1);
      }
      console.log('Logging in to Bitwarden...');
      execSync('bw login --apikey', {
        stdio: 'pipe',
        timeout: 30000,
        env: { ...process.env, BW_CLIENTID: clientId, BW_CLIENTSECRET: clientSecret },
      });
    }

    const session = execSync('bw unlock --passwordenv BW_PASSWORD --raw', {
      stdio: 'pipe',
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env, BW_PASSWORD: masterPassword },
    }).trim();

    if (!session) {
      console.error('Failed to unlock vault — no session token returned.');
      process.exit(1);
    }

    return session;
  } catch (err) {
    console.error(`Bitwarden error: ${err.message}`);
    process.exit(1);
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdStatus() {
  // Check bw CLI
  try {
    const version = execSync('bw --version', { stdio: 'pipe', timeout: 5000, encoding: 'utf-8' }).trim();
    console.log(`Bitwarden CLI: v${version}`);
  } catch {
    console.log('Bitwarden CLI: NOT INSTALLED');
    console.log('  Install: https://bitwarden.com/help/cli/');
    return;
  }

  // Check auth status
  try {
    const statusRaw = execSync('bw status', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
    const status = JSON.parse(statusRaw);
    console.log(`Vault status: ${status.status}`);
    if (status.userEmail) console.log(`User: ${status.userEmail}`);
  } catch (err) {
    console.log(`Vault status: error (${err.message})`);
  }

  // Check env vars
  console.log(`BW_CLIENTID: ${process.env.BW_CLIENTID ? 'set' : 'NOT SET'}`);
  console.log(`BW_CLIENTSECRET: ${process.env.BW_CLIENTSECRET ? 'set' : 'NOT SET'}`);
  console.log(`BW_PASSWORD: ${process.env.BW_PASSWORD ? 'set' : 'NOT SET'}`);

  // Show credential map
  const map = loadMap();
  const count = Object.keys(map).length;
  console.log(`\nCredential map: ${count} institution${count !== 1 ? 's' : ''} mapped`);
  for (const [slug, id] of Object.entries(map)) {
    console.log(`  ${slug} → ${id}`);
  }
}

async function cmdListBanks() {
  const session = getSession();

  // Search for common bank-related terms
  const searchTerms = ['bank', 'credit', 'financial', 'login'];

  // Also search for known institution names from accounts.json
  try {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
    const bankNames = [...new Set(accounts.map(a => a.bankName).filter(Boolean))];
    searchTerms.push(...bankNames);
  } catch {}

  const seen = new Set();
  const results = [];

  for (const term of searchTerms) {
    try {
      const raw = execSync(`bw list items --search "${term}" --session ${session}`, {
        stdio: 'pipe',
        timeout: 30000,
        encoding: 'utf-8',
      });
      const items = JSON.parse(raw);
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        if (item.type === 1 && item.login) { // type 1 = login item
          results.push({
            id: item.id,
            name: item.name,
            username: item.login.username ? item.login.username.substring(0, 3) + '***' : '(none)',
            uri: item.login.uris?.[0]?.uri || '(no URI)',
          });
        }
      }
    } catch {}
  }

  if (results.length === 0) {
    console.log('No bank login items found in Bitwarden vault.');
    return;
  }

  console.log(`Found ${results.length} potential bank login item(s):\n`);
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    ID:       ${r.id}`);
    console.log(`    Username: ${r.username}`);
    console.log(`    URI:      ${r.uri}`);
    console.log();
  }
}

async function cmdSearch(term) {
  if (!term) {
    console.error('Usage: node scripts/vault.js search <term>');
    process.exit(1);
  }

  const session = getSession();
  const raw = execSync(`bw list items --search "${term}" --session ${session}`, {
    stdio: 'pipe',
    timeout: 30000,
    encoding: 'utf-8',
  });
  const items = JSON.parse(raw).filter(i => i.type === 1 && i.login);

  if (items.length === 0) {
    console.log(`No login items found matching "${term}".`);
    return;
  }

  console.log(`Found ${items.length} login item(s) matching "${term}":\n`);
  for (const item of items) {
    const username = item.login.username
      ? item.login.username.substring(0, 3) + '***'
      : '(none)';
    const uri = item.login.uris?.[0]?.uri || '(no URI)';
    console.log(`  ${item.name}`);
    console.log(`    ID:       ${item.id}`);
    console.log(`    Username: ${username}`);
    console.log(`    URI:      ${uri}`);
    console.log();
  }
}

async function cmdMap(slug, itemId) {
  if (!slug || !itemId) {
    console.error('Usage: node scripts/vault.js map <institution-slug> <bitwarden-item-id>');
    process.exit(1);
  }

  // Validate UUID format
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(itemId)) {
    console.error(`Invalid Bitwarden item ID format: ${itemId}`);
    console.error('Expected UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    process.exit(1);
  }

  const map = loadMap();
  const existed = slug in map;
  map[slug] = itemId;
  saveMap(map);

  console.log(`${existed ? 'Updated' : 'Added'}: ${slug} → ${itemId}`);
}

async function cmdTest(slug) {
  if (!slug) {
    console.error('Usage: node scripts/vault.js test <institution-slug>');
    process.exit(1);
  }

  const map = loadMap();
  const itemId = map[slug];

  if (!itemId) {
    console.error(`No Bitwarden item mapped for "${slug}".`);
    console.error(`Run: node scripts/vault.js map ${slug} <bitwarden-item-id>`);
    process.exit(1);
  }

  console.log(`Testing credential fetch for ${slug} (item: ${itemId})...`);
  const session = getSession();

  try {
    const raw = execSync(`bw get item ${itemId} --session ${session}`, {
      stdio: 'pipe',
      timeout: 15000,
      encoding: 'utf-8',
    });
    const item = JSON.parse(raw);

    if (!item.login) {
      console.error('Item found but has no login credentials.');
      process.exit(1);
    }

    const username = item.login.username || '';
    const password = item.login.password || '';

    console.log(`Username: ${username.substring(0, 3)}${'*'.repeat(Math.max(0, username.length - 3))}`);
    console.log(`Password: ${'*'.repeat(password.length)} (${password.length} chars)`);
    console.log('Credential fetch successful.');
  } catch (err) {
    console.error(`Failed to fetch item: ${err.message}`);
    process.exit(1);
  }
}

async function cmdMigrate() {
  const session = getSession();
  const map = loadMap();

  // Find institutions with *_USERNAME/*_PASSWORD env vars
  const institutions = [];
  try {
    const institutionFiles = fs.readdirSync(path.join(__dirname, '..', 'readers', 'institutions'))
      .filter(f => f.endsWith('.js'));

    for (const file of institutionFiles) {
      const config = require(path.join(__dirname, '..', 'readers', 'institutions', file));
      if (config.credentials?.usernameEnv && config.credentials?.passwordEnv) {
        const slug = config.institution || file.replace('.js', '');
        const hasEnvCreds = process.env[config.credentials.usernameEnv] && process.env[config.credentials.passwordEnv];
        institutions.push({
          slug,
          usernameEnv: config.credentials.usernameEnv,
          passwordEnv: config.credentials.passwordEnv,
          hasEnvCreds,
          alreadyMapped: slug in map,
        });
      }
    }
  } catch (err) {
    console.error(`Failed to read institution configs: ${err.message}`);
    process.exit(1);
  }

  if (institutions.length === 0) {
    console.log('No institutions with credential configs found.');
    return;
  }

  console.log(`Found ${institutions.length} institution(s) with credential configs:\n`);

  for (const inst of institutions) {
    const status = inst.alreadyMapped ? ' (already mapped)' : inst.hasEnvCreds ? '' : ' (no .env creds)';
    console.log(`── ${inst.slug}${status}`);

    if (inst.alreadyMapped) {
      console.log(`   Already mapped to: ${map[inst.slug]}`);
      continue;
    }

    // Search Bitwarden for matching items
    const searchTerms = [inst.slug, inst.slug.replace(/-/g, ' ')];
    const seen = new Set();
    const matches = [];

    for (const term of searchTerms) {
      try {
        const raw = execSync(`bw list items --search "${term}" --session ${session}`, {
          stdio: 'pipe',
          timeout: 30000,
          encoding: 'utf-8',
        });
        const items = JSON.parse(raw);
        for (const item of items) {
          if (seen.has(item.id) || item.type !== 1 || !item.login) continue;
          seen.add(item.id);
          matches.push({
            id: item.id,
            name: item.name,
            username: item.login.username ? item.login.username.substring(0, 3) + '***' : '(none)',
          });
        }
      } catch {}
    }

    if (matches.length === 0) {
      console.log('   No matching items found in Bitwarden. Skipping.');
      continue;
    }

    console.log(`   Found ${matches.length} potential match(es):`);
    matches.forEach((m, i) => {
      console.log(`     [${i + 1}] ${m.name} (${m.username}) — ${m.id}`);
    });

    const answer = await ask(`   Map ${inst.slug} to which item? [1-${matches.length}, s=skip]: `);

    if (answer.toLowerCase() === 's' || !answer) {
      console.log('   Skipped.');
      continue;
    }

    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < matches.length) {
      map[inst.slug] = matches[idx].id;
      saveMap(map);
      console.log(`   Mapped: ${inst.slug} → ${matches[idx].id}`);
    } else {
      console.log('   Invalid selection. Skipped.');
    }
  }

  console.log(`\nDone. ${Object.keys(map).length} institution(s) now mapped.`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const command = process.argv[2];
const arg1 = process.argv[3];
const arg2 = process.argv[4];

switch (command) {
  case 'status':
    cmdStatus();
    break;
  case 'list-banks':
    cmdListBanks();
    break;
  case 'search':
    cmdSearch(arg1);
    break;
  case 'map':
    cmdMap(arg1, arg2);
    break;
  case 'test':
    cmdTest(arg1);
    break;
  case 'migrate':
    cmdMigrate();
    break;
  default:
    console.log(`Bitwarden Vault Helper

Usage:
  node scripts/vault.js status              Check bw CLI and auth status
  node scripts/vault.js list-banks          Find bank login items in vault
  node scripts/vault.js search <term>       Search vault for items by keyword
  node scripts/vault.js map <slug> <id>     Map institution to Bitwarden item
  node scripts/vault.js test <slug>         Verify credential fetch works
  node scripts/vault.js migrate             Interactive migration from .env`);
    break;
}
