#!/usr/bin/env node
/**
 * CLI entry point for the Browser Reader primitive.
 *
 * Usage:
 *   node readers/run.js <institution>                          # both balances + transactions
 *   node readers/run.js <institution> --balances               # balances only
 *   node readers/run.js <institution> --transactions           # transactions only
 *   node readers/run.js <institution> --transactions --all     # all transaction history (first run)
 *   node readers/run.js <institution> --transactions --from 2026-02-01 --to 2026-03-19
 *   node readers/run.js <institution> --explore                # dump page structure
 *   node readers/run.js <institution> --mfa-handler telegram   # MFA via Telegram
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const BrowserReader = require('./browser-reader');
const { extractSanitizedText } = require('./sanitize-text');

const institution = process.argv[2];
const useTelegram = process.argv.includes('--mfa-handler') || process.argv.includes('telegram');
const exploreMode = process.argv.includes('--explore');
const balancesOnly = process.argv.includes('--balances');
const transactionsOnly = process.argv.includes('--transactions');
const allHistory = process.argv.includes('--all');
const fromDate = getArg('--from');
const toDate = getArg('--to');

// If neither flag specified, do both
const doBalances = balancesOnly || (!balancesOnly && !transactionsOnly && !exploreMode);
const doTransactions = transactionsOnly || (!balancesOnly && !transactionsOnly && !exploreMode);

function getArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

if (!institution) {
  console.error('Usage: node readers/run.js <institution> [--balances] [--transactions] [--all] [--from DATE] [--to DATE] [--explore]');
  process.exit(1);
}

let config;
try {
  config = require(`./institutions/${institution}`);
} catch (e) {
  console.error(`No reader config found for institution: ${institution}`);
  process.exit(1);
}

async function promptStdin(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(message + ' ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function handleMfa(reader, mfaSignal) {
  console.log(`[${institution}] MFA detected: ${mfaSignal.type}`);

  if (mfaSignal.type === 'email') {
    try {
      const gmailMfa = require('../scripts/gmail-mfa');
      console.log(`[${institution}] Polling Gmail for MFA code...`);
      const code = await gmailMfa.pollForMfaCode({
        sender: mfaSignal.emailSender,
        subjectKeyword: mfaSignal.emailSubject,
        timeoutMs: 60000,
        pollIntervalMs: 10000,
      });
      if (code) {
        console.log(`[${institution}] Got email MFA code`);
        return reader.enterMfaCode(code);
      }
      console.log(`[${institution}] Email MFA timed out, falling back to manual`);
    } catch {
      console.log(`[${institution}] Gmail MFA not configured, falling back to manual`);
    }
  }

  if (mfaSignal.type === 'push') {
    await reader.initiatePushMfa();
    const pushMsg = `${institution.toUpperCase()} MFA — approve the push notification on your phone`;
    // Notify via MFA bridge so sync-all.js picks it up and sends Telegram notification
    const { requestCode } = require('./mfa-bridge');
    requestCode(institution, pushMsg);
    console.log(`[${institution}] ${pushMsg}`);
    console.log(`[${institution}] Waiting for push approval...`);
    for (let i = 0; i < 18; i++) {  // 18 × 10s = 180s (was 120s)
      const cleared = await reader.checkMfaCleared();
      if (cleared) {
        // Clean up bridge files
        const mfaDir = require('path').join(__dirname, '..', 'data', 'mfa-pending');
        try { require('fs').unlinkSync(require('path').join(mfaDir, `${institution}.request.json`)); } catch {}
        return reader._detectState();
      }
      console.log(`[${institution}] Still waiting... (${(i + 1) * 10}s)`);
      await new Promise(r => setTimeout(r, 10000));
    }
    throw new Error('Push MFA timed out after 180 seconds');
  }

  // Some banks require clicking a button to initiate SMS delivery (e.g., "Text me", "Send code")
  if (config.mfa.mfaInitiationSelector) {
    try {
      const initBtn = reader.page.locator(config.mfa.mfaInitiationSelector);
      if (await initBtn.isVisible({ timeout: 3000 })) {
        await initBtn.click();
        console.log(`[${institution}] Clicked MFA initiation: ${config.mfa.mfaInitiationSelector}`);
        await reader.page.waitForTimeout(3000);
      }
    } catch {}
  } else {
    // Generic fallback: look for common initiation buttons
    for (const sel of ['button:has-text("Text me")', 'button:has-text("Send code")', 'button:has-text("Send Code")']) {
      try {
        const btn = reader.page.locator(sel).first();
        if (await btn.isVisible({ timeout: 1000 })) {
          await btn.click();
          console.log(`[${institution}] Clicked MFA initiation: ${sel}`);
          await reader.page.waitForTimeout(3000);
          break;
        }
      } catch {}
    }
  }

  // Multi-step MFA: some banks show an intermediate step after initiation (e.g., phone selection)
  // Config provides mfaSteps — an array of {selector, action, value?} to execute before code entry
  if (config.mfa.mfaSteps) {
    for (const step of config.mfa.mfaSteps) {
      try {
        let el = reader.page.locator(step.selector);
        if (step.first) el = el.first();
        if (step.action === 'click') {
          await el.click({ timeout: step.timeout || 5000 });
        } else if (step.action === 'evaluateClick') {
          // Use JS click instead of Playwright click (some banks log out on trusted clicks)
          await reader.page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
          }, step.evaluateSelector || step.selector);
        } else if (step.action === 'waitFor') {
          await el.waitFor({ state: 'visible', timeout: step.timeout || 10000 });
        } else if (step.action === 'check') {
          const checked = await el.isChecked().catch(() => false);
          if (!checked) await el.check({ timeout: step.timeout || 5000 });
        }
        console.log(`[${institution}] MFA step: ${step.action} ${step.selector}`);
        if (step.waitAfter) await reader.page.waitForTimeout(step.waitAfter);
      } catch (e) {
        console.log(`[${institution}] MFA step failed: ${step.action} ${step.selector} — ${e.message.substring(0, 60)}`);
      }
    }
  }

  // Verify the code input is actually visible before requesting a code
  // If it's not, the page is in an unexpected state (intermediate modal, error, etc.)
  const codeSelectors = config.mfa.codeInputSelectors || ['input[type="tel"]', 'input[type="text"]'];
  let codeInputVisible = false;
  for (const sel of codeSelectors) {
    try {
      const inp = reader.page.locator(sel).first();
      if (await inp.isVisible({ timeout: 5000 })) {
        codeInputVisible = true;
        break;
      }
    } catch {}
  }

  if (!codeInputVisible) {
    console.log(`[${institution}] Code input not visible after MFA initiation — entering adaptive mode`);
    const result = await handleUnknownState(reader);
    // After adaptive resolution, re-detect state — may now be on code entry or dashboard
    const newState = await reader._detectState();
    if (newState === 'dashboard') return newState;
    // If still not dashboard, check again for code input
    for (const sel of codeSelectors) {
      try {
        if (await reader.page.locator(sel).first().isVisible({ timeout: 3000 })) {
          codeInputVisible = true;
          break;
        }
      } catch {}
    }
    if (!codeInputVisible) {
      throw new Error('MFA code input not visible after adaptive recovery');
    }
  }

  // SMS or device code — use MFA bridge (allows background operation) with stdin fallback
  const { requestCode, waitForCode } = require('./mfa-bridge');
  requestCode(institution, mfaSignal.message);
  console.log(`[${institution}] Waiting for MFA code via bridge (data/mfa-pending/${institution}.code) or stdin...`);

  // Race: bridge file vs stdin
  let code;
  const bridgePromise = waitForCode(institution, 300000);

  if (process.stdin.isTTY) {
    // Interactive terminal — also accept stdin
    const stdinPromise = promptStdin('Enter MFA code:');
    code = await Promise.race([bridgePromise, stdinPromise]);
  } else {
    // Non-interactive (background) — bridge only
    code = await bridgePromise;
  }

  if (!code) throw new Error('No MFA code provided (timeout)');
  return reader.enterMfaCode(code);
}

async function handleUnknownState(reader) {
  const { captureAnnotatedState } = require('./annotate');
  const adaptive = require('./adaptive-bridge');
  const page = reader.page;

  console.log(`[${institution}] Unknown page state — entering adaptive mode`);

  for (let round = 0; round < 10; round++) {
    // Take annotated screenshot
    const ssPath = path.join(__dirname, '..', 'data', 'adaptive-pending', `${institution}-screenshot.png`);
    const stateData = await captureAnnotatedState(page, page, ssPath);

    // Write request for the orchestrating agent
    adaptive.requestHelp(institution, stateData);

    // Wait for instruction
    const instruction = await adaptive.waitForInstruction(institution, 300000);
    if (!instruction) throw new Error('Adaptive bridge timeout — no instruction received');

    // Execute the actions
    const allElements = [...stateData.elements, ...stateData.inputs];
    for (const action of (instruction.actions || [])) {
      console.log(`[${institution}] Adaptive action: ${action.action}${action.element ? ' [' + action.element + ']' : ''}`);
      try {
        if (action.action === 'click') {
          const el = allElements.find(e => e.n === action.element);
          if (el) {
            try {
              await page.locator(el.selector).first().click({ timeout: 5000 });
            } catch {
              await page.mouse.click(el.bounds.x + el.bounds.w / 2, el.bounds.y + el.bounds.h / 2);
            }
          } else if (action.selector) {
            await page.locator(action.selector).first().click({ timeout: 5000 });
          }
        } else if (action.action === 'type') {
          const el = allElements.find(e => e.n === action.element);
          const sel = el?.selector || action.selector;
          if (sel) await page.locator(sel).first().fill(action.text, { timeout: 5000 });
        } else if (action.action === 'evaluate') {
          await page.evaluate(`(() => { ${action.code} })()`);
        } else if (action.action === 'wait') {
          await page.waitForTimeout(action.ms || 3000);
        } else if (action.action === 'key') {
          await page.keyboard.press(action.key || 'Enter');
        } else if (action.action === 'frame') {
          // Frame switching not directly supported in run.js context — use evaluate
          console.log(`[${institution}] Frame action — use evaluate for iframe interaction`);
        }
        await page.waitForTimeout(500);
      } catch (e) {
        console.log(`[${institution}] Adaptive action error: ${e.message.substring(0, 60)}`);
      }
    }

    await page.waitForTimeout(2000);

    // Check if we've resolved to a known state
    const newState = await reader._detectState('post-login');
    console.log(`[${institution}] Post-adaptive state: ${newState.state}`);

    // Write learned patterns if the instruction included them
    if (instruction.mfaType || instruction.mfaPatterns) {
      adaptive.writeLearnedPatterns(institution, {
        mfaType: instruction.mfaType,
        mfaPatterns: instruction.mfaPatterns,
        mfaInitiationSelector: instruction.mfaInitiationSelector,
        codeInputSelectors: instruction.codeInputSelectors,
        codeSubmitSelector: instruction.codeSubmitSelector,
        pageTextSnippet: stateData.pageText.substring(0, 500),
      });
    }

    adaptive.cleanup(institution);

    if (newState.state === 'logged-in' || newState.state === 'mfa') {
      return newState;
    }

    // Not resolved yet — loop with new screenshot
    console.log(`[${institution}] Adaptive round ${round + 1} — still unresolved, continuing...`);
  }

  throw new Error('Adaptive bridge exhausted — could not resolve unknown state after 10 rounds');
}

async function loginFlow(reader) {
  let result = await reader.start();
  console.log(`[${institution}] Initial state: ${result.state}`);

  if (result.state === 'login') {
    result = await reader.login();
    console.log(`[${institution}] Post-login state: ${result.state}`);
  }

  // Handle unknown state via adaptive bridge (may resolve to MFA or dashboard)
  if (result.state === 'unknown') {
    result = await handleUnknownState(reader);
    console.log(`[${institution}] Post-adaptive state: ${result.state}`);
  }

  if (result.state === 'mfa') {
    result = await handleMfa(reader, result.mfa);
    console.log(`[${institution}] Post-MFA state: ${result.state}`);
    if (result.state === 'mfa') {
      result = await handleMfa(reader, result.mfa);
      console.log(`[${institution}] Post-MFA-2 state: ${result.state}`);
    }
  }

  // Adaptive may be needed after MFA too (new interstitial, unexpected page)
  if (result.state === 'unknown') {
    result = await handleUnknownState(reader);
    console.log(`[${institution}] Post-adaptive-2 state: ${result.state}`);
  }

  if (result.state !== 'logged-in') {
    throw new Error(`Could not reach dashboard — final state: ${result.state}`);
  }

  return result;
}

async function runExplore(reader) {
  console.log(`\n[${institution}] === EXPLORE MODE ===`);
  const page = reader.page;
  await page.waitForTimeout(5000);

  const exploreDir = path.join(__dirname, '..', 'data', 'explore');
  if (!fs.existsSync(exploreDir)) fs.mkdirSync(exploreDir, { recursive: true });
  const ssPath = path.join(exploreDir, `${institution}-dashboard-${Date.now()}.png`);
  await page.screenshot({ path: ssPath, fullPage: true });
  console.log(`Screenshot: ${ssPath}`);

  const mainText = await extractSanitizedText(page, { unwrap: true });
  const mainLines = mainText.split('\n').filter(l => l.trim());
  console.log(`\nMAIN PAGE TEXT (${mainText.length} chars, ${mainLines.length} lines):`);
  mainLines.slice(0, 80).forEach(l => console.log(`  | ${l.trim().substring(0, 150)}`));
  if (mainLines.length > 80) console.log(`  | ... (${mainLines.length - 80} more lines)`);

  const acctEls = await page.evaluate(() => {
    const results = [];
    document.querySelectorAll('[class*="account"], [class*="tile"], [class*="balance"]').forEach(el => {
      const text = el.textContent.trim().substring(0, 300);
      if (text.length > 5 && text.length < 500) {
        results.push({ tag: el.tagName, id: el.id, class: el.className.substring(0, 100), text });
      }
    });
    return results.slice(0, 40);
  });
  if (acctEls.length) {
    console.log('\nACCOUNT ELEMENTS:');
    console.log(JSON.stringify(acctEls, null, 2));
  }

  console.log(`\n[${institution}] Browser staying open. Press Ctrl+C to close.`);
  await new Promise(() => {});
}

const RESULT_DIR = path.join(__dirname, '..', 'data', 'sync-output');

/**
 * Write a structured result file for sync-all.js to read.
 */
function writeResultFile(institution, taskResults, errors) {
  const hasOk = Object.values(taskResults).includes('ok');
  const hasFailed = Object.values(taskResults).includes('failed');
  const status = hasFailed ? (hasOk ? 'partial' : 'failed') : 'ok';

  const resultFile = path.join(RESULT_DIR, `${institution}.result.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    institution,
    status,
    tasks: taskResults,
    errors,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

async function main() {
  // Pre-flight: encrypt any raw credentials before processing
  try {
    require('child_process').execSync('node scripts/encrypt-env.js', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      timeout: 30000,
    });
  } catch {} // Non-fatal — sync-all.js also runs this

  const reader = new BrowserReader(config);
  const { withRecovery } = require('./recovery');

  // Load existing output to avoid overwriting data from previous runs
  const outputFile = path.join(__dirname, '..', 'data', 'sync-output', `${institution}.json`);
  let output = { balances: [], transactions: [], holdings: [] };
  try {
    if (fs.existsSync(outputFile)) {
      const existing = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      output.balances = existing.balances || [];
      output.transactions = existing.transactions || [];
      output.holdings = existing.holdings || [];
      console.log(`[${institution}] Loaded existing output: ${output.balances.length} balances, ${output.transactions.length} transactions`);
    }
  } catch {};

  const taskResults = {};
  const errors = [];

  try {
    await loginFlow(reader);

    // Dismiss any promotional pop-ups before doing anything
    await reader.dismissPopups();

    if (exploreMode) {
      await runExplore(reader);
      return;
    }

    // Task: Balances (wrapped in recovery)
    if (doBalances) {
      console.log(`\n[${institution}] === TASK: BALANCES ===`);
      const balanceTask = require('./tasks/extract-balances');
      const taskCtx = {
        task: 'balances',
        step: 'extract-dashboard-text',
        partialResults: { balances: output.balances },
      };
      const balanceResult = await withRecovery(reader.page, config, reader, taskCtx, () =>
        balanceTask.run(reader.page, config)
      );

      if (balanceResult) {
        output.balances = balanceResult.balances;
        if (balanceResult.pendingExtraction) {
          output.pendingExtraction = { ...output.pendingExtraction, ...balanceResult.pendingExtraction };
        }
        taskResults.balances = 'ok';
        console.log(`[${institution}] Balances: captured for agent extraction`);
      } else {
        taskResults.balances = 'failed';
        if (taskCtx._error) errors.push(taskCtx._error);
        console.log(`[${institution}] Balances: failed — preserving existing data`);
      }
    }

    // Task: Statement balances (download statement PDFs for period-end balances)
    if (doBalances && config.statementBalances) {
      console.log(`\n[${institution}] === TASK: STATEMENT BALANCES ===`);
      const stmtTask = require('./tasks/download-statements');
      const taskCtx = {
        task: 'statements',
        step: 'download-statement-pdfs',
        partialResults: {},
      };
      const stmtResult = await withRecovery(reader.page, config, reader, taskCtx, () =>
        stmtTask.run(reader.page, config, { months: 3 })
      );

      if (stmtResult) {
        if (stmtResult.statementBalances?.length > 0) {
          output.statementBalances = stmtResult.statementBalances;
        }
        if (stmtResult.pendingExtraction) {
          output.pendingExtraction = { ...output.pendingExtraction, ...stmtResult.pendingExtraction };
        }
        taskResults.statements = 'ok';
        console.log(`[${institution}] Statements: ${stmtResult.pendingExtraction?.statementPdfs?.length || 0} PDFs pending extraction`);
      } else {
        taskResults.statements = 'failed';
        console.log(`[${institution}] Statements: failed — non-critical, continuing`);
      }

      // Navigate back to dashboard for transactions task
      try {
        const dashUrl = config.dashboardUrl || config.entryUrl;
        await reader.page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await reader.page.waitForTimeout(3000);
      } catch {}
    }

    // Task: Transactions (wrapped in recovery — runs independently of balances)
    if (doTransactions && config.transactions) {
      console.log(`\n[${institution}] === TASK: TRANSACTIONS ===`);
      const txnTask = require('./tasks/download-transactions');
      const txnOptions = {
        mode: allHistory ? 'all' : (fromDate ? 'incremental' : 'all'),
        fromDate: fromDate || null,
        toDate: toDate || null,
      };
      const taskCtx = {
        task: 'transactions',
        step: 'download-transactions',
        partialResults: { transactions: output.transactions },
      };
      const txnResult = await withRecovery(reader.page, config, reader, taskCtx, () =>
        txnTask.run(reader.page, config, txnOptions)
      );

      if (txnResult) {
        output.transactions = txnResult.transactions;
        if (txnResult.pendingExtraction) {
          output.pendingExtraction = output.pendingExtraction || {};
          output.pendingExtraction.pdfTexts = txnResult.pendingExtraction.pdfTexts;
        }
        taskResults.transactions = 'ok';
        console.log(`[${institution}] Transactions: ${output.transactions.length} total`);
      } else {
        taskResults.transactions = 'failed';
        if (taskCtx._error) errors.push(taskCtx._error);
        console.log(`[${institution}] Transactions: failed — preserving existing data`);
      }
    } else if (doTransactions && !config.transactions) {
      console.log(`[${institution}] No transaction download config — skipping`);
    }

    // Always write output (even on partial failure — preserves good data from successful tasks)
    reader.writeOutput(output);
    writeResultFile(institution, taskResults, errors);
    console.log(`\n[${institution}] Done. ${output.transactions.length} transactions, extraction pending for agent`);

  } catch (error) {
    // Outer catch — login failure or catastrophic error
    console.error(`[${institution}] Error: ${error.message}`);

    // Take diagnostic screenshot before closing
    try {
      if (reader.page) {
        const ssDir = path.join(__dirname, '..', 'data', 'adaptive-pending');
        if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
        await reader.page.screenshot({
          path: path.join(ssDir, `${institution}-fatal-error.png`),
          fullPage: false,
        });
      }
    } catch { /* screenshot failed */ }

    // Write whatever we have
    if (output.balances.length > 0 || output.transactions.length > 0) {
      reader.writeOutput(output);
    }
    writeResultFile(institution, taskResults, [{
      task: 'login',
      step: 'login-flow',
      category: 'fatal',
      message: (error.message || String(error)).substring(0, 300),
    }]);
    process.exitCode = 1;
  } finally {
    if (!exploreMode) await reader.close();
  }
}

main().catch(err => {
  console.error(`[${institution}] Fatal:`, err);
  process.exit(1);
});
