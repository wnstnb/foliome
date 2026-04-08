#!/usr/bin/env node
/**
 * Sync All — orchestrates balances and transactions for all configured banks.
 *
 * Execution strategy:
 *   Phase 1: API connectors in parallel — auto-discovered from connectors/ directory
 *   Phase 2: All browser banks in parallel — auto-discovered from readers/institutions/
 *            MFA codes collected together and routed via bridge.
 *            Telegram notifications sent directly when MFA is detected.
 *
 * Usage:
 *   node readers/sync-all.js                          # full sync
 *   node readers/sync-all.js --balances               # balances only
 *   node readers/sync-all.js --transactions           # transactions only
 *   node readers/sync-all.js --bank <institution>       # specific bank only
 *
 * Output: JSON files in data/sync-output/<bank>.json
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getPendingRequests, submitCode } = require('./mfa-bridge');
const telegram = require('../scripts/telegram-notify');

const INSTITUTIONS_DIR = path.join(__dirname, 'institutions');
const CONNECTORS_DIR = path.join(__dirname, '..', 'connectors');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');
const MFA_DIR = path.join(__dirname, '..', 'data', 'mfa-pending');

const balancesOnly = process.argv.includes('--balances');
const transactionsOnly = process.argv.includes('--transactions');
const bankFilter = process.argv.includes('--bank') ? process.argv[process.argv.indexOf('--bank') + 1] : null;
const runImport = process.argv.includes('--import');
const runClassify = process.argv.includes('--classify');

// Discover all configured browser reader institutions
const browserInstitutions = fs.readdirSync(INSTITUTIONS_DIR)
  .filter(f => f.endsWith('.js') && !f.includes('learned'))
  .map(f => f.replace('.js', ''));

// Discover API connectors — any .js file in connectors/ (standalone scripts, not modules)
const apiConnectors = fs.readdirSync(CONNECTORS_DIR)
  .filter(f => f.endsWith('.js'))
  .map(f => f.replace('.js', ''));

const results = [];

function buildArgs(bank, isApi) {
  if (isApi) {
    const args = [`connectors/${bank}.js`];
    if (balancesOnly) args.push('--balances');
    else if (transactionsOnly) args.push('--transactions');
    return args;
  }
  const args = ['readers/run.js', bank];
  if (balancesOnly) args.push('--balances');
  else if (transactionsOnly) args.push('--transactions', '--all');
  return args;
}

/**
 * Run a bank sync as a child process. Returns a promise that resolves with the result.
 */
function runBank(bank, isApi = false) {
  return new Promise((resolve) => {
    const args = buildArgs(bank, isApi);
    const startTime = Date.now();
    let output = '';

    console.log(`[sync] Starting ${bank}${isApi ? ' (API)' : ''}...`);

    const child = spawn('node', args, {
      cwd: path.join(__dirname, '..'),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      // Print key lines
      text.split('\n').forEach(line => {
        const l = line.trim();
        if (l.includes('Done.') || l.includes('✓') || l.includes('Error') || l.includes('MFA') || l.includes('balances') || l.includes('transactions')) {
          console.log(`  [${bank}] ${l}`);
        }
      });
    });

    child.stderr.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const outputFile = path.join(OUTPUT_DIR, `${bank}.json`);
      const resultFile = path.join(OUTPUT_DIR, `${bank}.result.json`);

      // Read structured result file if available
      let resultMeta = null;
      try {
        if (fs.existsSync(resultFile)) {
          resultMeta = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        }
      } catch {}

      if (fs.existsSync(outputFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
          const status = resultMeta?.status || (code === 0 ? 'ok' : 'failed');
          const errorReason = resultMeta?.errors?.length
            ? resultMeta.errors.map(e => `${e.task}: ${e.category}`).join(', ')
            : null;
          const result = {
            bank,
            status,
            balances: (data.balances || []).length,
            transactions: (data.transactions || []).length,
            elapsed: `${elapsed}s`,
            errorReason,
            taskResults: resultMeta?.tasks || null,
          };
          results.push(result);

          const icon = status === 'ok' ? '✓' : status === 'partial' ? '⚠' : '✗';
          const reasonStr = errorReason ? `  [${errorReason}]` : '';
          console.log(`[sync] ${icon} ${bank}: ${result.balances}B, ${result.transactions}T (${elapsed}s)${reasonStr}`);
          resolve(result);
        } catch {
          results.push({ bank, status: 'parse error', elapsed: `${elapsed}s` });
          resolve(null);
        }
      } else {
        const errorReason = resultMeta?.errors?.length
          ? resultMeta.errors.map(e => `${e.task}: ${e.category}`).join(', ')
          : null;
        results.push({ bank, status: 'failed', elapsed: `${elapsed}s`, errorReason });
        const reasonStr = errorReason ? `  [${errorReason}]` : '';
        console.log(`[sync] ✗ ${bank}: failed (exit ${code}, ${elapsed}s)${reasonStr}`);
        resolve(null);
      }
    });

    // Kill after 10 minutes
    setTimeout(() => {
      child.kill();
      results.push({ bank, status: 'timeout', elapsed: '600s' });
      console.log(`[sync] ✗ ${bank}: timeout`);
      resolve(null);
    }, 600000);
  });
}

/**
 * Poll for MFA requests and report them via console AND Telegram.
 * Sends a Telegram notification the instant any bank requests MFA,
 * so the user knows exactly which services need codes.
 */
async function waitForMfaCodes(expectedBanks, timeoutMs = 300000) {
  const deadline = Date.now() + timeoutMs;
  const resolved = new Set();
  const notified = new Set();  // track which institutions we've already notified about
  let pendingBatch = [];       // accumulate requests for a brief window before sending

  while (resolved.size < expectedBanks.length && Date.now() < deadline) {
    const pending = getPendingRequests();
    const newRequests = pending.filter(p => !notified.has(p.institution));

    if (newRequests.length > 0) {
      // Add new requests to the batch
      for (const req of newRequests) {
        notified.add(req.institution);
        pendingBatch.push(req);
      }

      // Brief delay to batch simultaneous MFA requests (banks launch in parallel)
      // If multiple banks hit MFA within 3s, we send one consolidated message
      await new Promise(r => setTimeout(r, 3000));

      // Check for any more that arrived during the batch window
      const morePending = getPendingRequests();
      for (const req of morePending) {
        if (!notified.has(req.institution)) {
          notified.add(req.institution);
          pendingBatch.push(req);
        }
      }

      // Send consolidated notification
      if (pendingBatch.length > 0) {
        console.log('\n' + '='.repeat(50));
        console.log('MFA CODES NEEDED:');

        const lines = pendingBatch.map(req => {
          console.log(`  → ${req.institution}: ${req.message}`);
          // Format for Telegram
          const name = req.institution.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          return `  - ${name}: ${req.message.split('—')[1]?.trim() || req.message}`;
        });

        console.log('='.repeat(50));

        // Send Telegram notification immediately (backup — agent also polls bridge files)
        const telegramMsg = `🔐 MFA codes needed:\n${lines.join('\n')}\n\nReply with codes like: "BankA 123456, BankB 7654321"`;
        console.log('[sync] Sending MFA Telegram notification...');
        telegram.sendMessage(telegramMsg).then(() => {
          console.log('[sync] ✓ MFA Telegram notification sent');
        }).catch((err) => {
          console.error(`[sync] ✗ MFA Telegram notification FAILED: ${err.message || err}`);
          // Retry once after 2 seconds
          setTimeout(() => {
            console.log('[sync] Retrying MFA Telegram notification...');
            telegram.sendMessage(telegramMsg).then(() => {
              console.log('[sync] ✓ MFA Telegram notification sent (retry)');
            }).catch((err2) => {
              console.error(`[sync] ✗ MFA Telegram retry FAILED: ${err2.message || err2}`);
            });
          }, 2000);
        });

        pendingBatch = [];
      }
    }

    // Check if codes have been submitted (request files cleaned up)
    for (const bank of expectedBanks) {
      const requestFile = path.join(MFA_DIR, `${bank}.request.json`);
      const codeFile = path.join(MFA_DIR, `${bank}.code`);
      if (!fs.existsSync(requestFile) && !fs.existsSync(codeFile)) {
        resolved.add(bank);
      }
    }

    await new Promise(r => setTimeout(r, 1000));  // poll every 1s (was 2s)
  }
}

/**
 * Poll for adaptive help requests (unknown page states) and notify via Telegram.
 * The orchestrating agent (or a Haiku sub-agent) reads the screenshot and sends instructions.
 */
async function pollForAdaptiveRequests(expectedBanks, timeoutMs = 300000) {
  const { getPendingAdaptiveRequests } = require('./adaptive-bridge');
  const deadline = Date.now() + timeoutMs;
  const notified = new Set();

  while (Date.now() < deadline) {
    const pending = getPendingAdaptiveRequests();
    const newRequests = pending.filter(p => !notified.has(p.institution));

    for (const req of newRequests) {
      notified.add(req.institution);

      if (req.type === 'task-error') {
        // Task-phase failure (balances/transactions)
        console.log(`\n[sync] TASK ERROR: ${req.institution} — task "${req.task}" failed at "${req.step}" (${req.error?.category})`);
        const name = req.institution.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const telegramMsg = `⚠️ ${name} — task "${req.task}" failed\nStep: ${req.step}\nError: ${req.error?.category} — ${(req.error?.message || '').substring(0, 200)}\nURL: ${req.page?.url || 'N/A'}\n\nScreenshot saved. Use adaptive-bridge to send recovery instructions.`;
        console.log(`[sync] Sending task-error Telegram notification for ${req.institution}...`);
        telegram.sendMessage(telegramMsg).then(() => {
          console.log(`[sync] ✓ Task-error Telegram notification sent for ${req.institution}`);
        }).catch((err) => {
          console.error(`[sync] ✗ Task-error Telegram notification FAILED for ${req.institution}: ${err.message || err}`);
        });
      } else {
        // Unknown page state (login-phase)
        console.log(`\n[sync] ADAPTIVE: ${req.institution} — unknown page state, needs visual help`);
        const telegramMsg = `🔍 ${req.institution.toUpperCase()} — unknown page state after login.\nScreenshot: ${req.screenshot}\nURL: ${req.url}\n${req.elements?.length || 0} interactive elements, ${req.inputs?.length || 0} inputs\n\nUse adaptive-bridge to send instructions.`;
        console.log(`[sync] Sending adaptive Telegram notification for ${req.institution}...`);
        telegram.sendMessage(telegramMsg).then(() => {
          console.log(`[sync] ✓ Adaptive Telegram notification sent for ${req.institution}`);
        }).catch((err) => {
          console.error(`[sync] ✗ Adaptive Telegram notification FAILED for ${req.institution}: ${err.message || err}`);
        });
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

/**
 * Pre-authenticate with Bitwarden once so child processes can reuse the session.
 * Sets BW_SESSION in process.env — child processes inherit it and skip login/unlock.
 */
function preAuthBitwarden() {
  try {
    execSync('bw --version', { stdio: 'pipe', timeout: 5000 });
  } catch {
    return; // bw CLI not installed — credentials.js will fall back to .env
  }

  const clientId = process.env.BW_CLIENTID;
  const clientSecret = process.env.BW_CLIENTSECRET;
  const masterPassword = process.env.BW_PASSWORD;
  if (!clientId || !clientSecret || !masterPassword) return;

  try {
    const statusRaw = execSync('bw status', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' });
    const status = JSON.parse(statusRaw);

    if (status.status === 'unauthenticated') {
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

    if (session) {
      process.env.BW_SESSION = session;
      console.log('[sync] Bitwarden vault unlocked — session shared with all child processes');
    }
  } catch (err) {
    console.log(`[sync] Bitwarden pre-auth failed (credentials will fall back to .env): ${err.message}`);
  }
}

async function main() {
  console.log('=== SYNC ALL ===');
  console.log(`Browser readers: ${browserInstitutions.join(', ')}`);
  console.log(`API connectors: ${apiConnectors.join(', ')}`);
  console.log(`Mode: ${balancesOnly ? 'balances only' : transactionsOnly ? 'transactions only' : 'balances + transactions'}`);
  if (bankFilter) console.log(`Filter: ${bankFilter} only`);
  console.log('');

  // Pre-flight: encrypt any raw credentials in .env before processing
  try {
    execSync('node scripts/encrypt-env.js', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      timeout: 30000,
    });
  } catch {
    // Non-fatal — encryption is best-effort
  }

  // Pre-authenticate with Bitwarden once — child processes inherit BW_SESSION
  preAuthBitwarden();

  // Clean MFA pending
  try {
    const files = fs.readdirSync(MFA_DIR);
    files.forEach(f => fs.unlinkSync(path.join(MFA_DIR, f)));
  } catch {}

  // Clean adaptive pending
  const ADAPTIVE_DIR = path.join(__dirname, '..', 'data', 'adaptive-pending');
  try {
    const files = fs.readdirSync(ADAPTIVE_DIR);
    files.forEach(f => fs.unlinkSync(path.join(ADAPTIVE_DIR, f)));
  } catch {}

  if (bankFilter) {
    // Single bank mode
    const isApi = apiConnectors.includes(bankFilter);
    if (!isApi && !browserInstitutions.includes(bankFilter)) {
      console.log(`No config found for: ${bankFilter}`);
      return;
    }
    await runBank(bankFilter, isApi);
  } else {
    // === PHASE 1: API connectors in parallel ===
    console.log('\n--- PHASE 1: API CONNECTORS (parallel) ---');
    const apiTasks = apiConnectors.map(bank => runBank(bank, true));
    await Promise.all(apiTasks);

    // === PHASE 2: All browser banks in parallel (MFA handled via bridge) ===
    if (browserInstitutions.length > 0) {
      console.log('\n--- PHASE 2: ALL BROWSERS (parallel — MFA via bridge if needed) ---');
      console.log(`Launching ${browserInstitutions.join(', ')}...`);
      console.log('If MFA is required, you will be prompted for codes.\n');

      const browserTasks = browserInstitutions.map(bank => runBank(bank));

      // Poll for MFA requests and adaptive help requests while banks are running
      waitForMfaCodes(browserInstitutions).catch((err) => {
        console.error(`[sync] MFA watcher error: ${err.message || err}`);
      });
      pollForAdaptiveRequests(browserInstitutions).catch((err) => {
        console.error(`[sync] Adaptive watcher error: ${err.message || err}`);
      });

      await Promise.all(browserTasks);
    }
  }

  // === SUMMARY ===
  console.log('\n' + '='.repeat(50));
  console.log('SYNC SUMMARY');
  console.log('='.repeat(50));

  let totalBal = 0, totalTxn = 0;
  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'partial' ? '⚠' : '✗';
    const stats = r.balances !== undefined ? `${r.balances}B, ${r.transactions}T` : r.status;
    const reason = r.errorReason ? `  [${r.errorReason}]` : '';
    console.log(`  ${icon} ${r.bank.padEnd(15)} ${stats.padEnd(15)} ${r.elapsed}${reason}`);
    if (r.balances) totalBal += r.balances;
    if (r.transactions) totalTxn += r.transactions;
  }
  console.log('  ' + '-'.repeat(40));
  console.log(`  TOTAL: ${totalBal} balances, ${totalTxn} transactions`);
  const okCount = results.filter(r => r.status === 'ok').length;
  const partialCount = results.filter(r => r.status === 'partial').length;
  const failedCount = results.filter(r => r.status !== 'ok' && r.status !== 'partial').length;
  console.log(`  ${okCount}/${results.length} succeeded${partialCount ? `, ${partialCount} partial` : ''}${failedCount ? `, ${failedCount} failed` : ''}`);

  // Post-sync pipeline
  if (runImport) {
    console.log('\n--- IMPORT: JSON → SQLite ---');
    try {
      const { execSync } = require('child_process');
      const importOutput = execSync('node sync-engine/import.js', { encoding: 'utf-8', cwd: path.join(__dirname, '..') });
      console.log(importOutput);
    } catch (e) {
      console.error('Import failed:', e.message.substring(0, 100));
    }
  }

  if (runClassify) {
    console.log('\n--- CLASSIFY: Categorize transactions ---');
    try {
      const { execSync } = require('child_process');
      const classifyOutput = execSync('node sync-engine/classify.js', { encoding: 'utf-8', cwd: path.join(__dirname, '..'), timeout: 600000 });
      console.log(classifyOutput);
    } catch (e) {
      console.error('Classification failed:', e.message.substring(0, 100));
    }
  }
}

main().catch(err => {
  console.error('Sync error:', err);
  process.exit(1);
});
