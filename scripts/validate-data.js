#!/usr/bin/env node
/**
 * Data Validation — checks that data semantics, normalization, and database
 * invariants are correct.
 *
 * Three layers:
 *   1. Anchors vs raw data: do Layer 1 JSON files match data-semantics.json?
 *   2. Normalization: does normalizeAmountSign() produce correct output?
 *   3. Database invariants: are signs correct in SQLite after import?
 *
 * Usage:
 *   node scripts/validate-data.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'foliome.db');
const SYNC_OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');
const SEMANTICS_PATH = path.join(__dirname, '..', 'config', 'data-semantics.json');
const ACCOUNTS_PATH = path.join(__dirname, '..', 'config', 'accounts.json');

let passed = 0;
let failed = 0;
let skipped = 0;

function pass(msg) { passed++; console.log(`  ✓ ${msg}`); }
function fail(msg) { failed++; console.log(`  ✗ ${msg}`); }
function skip(msg) { skipped++; console.log(`  - ${msg}`); }

// === Load config ===

function loadSemantics() {
  try { return JSON.parse(fs.readFileSync(SEMANTICS_PATH, 'utf-8')); }
  catch { return null; }
}

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8')); }
  catch { return null; }
}

function loadSyncOutput(institution) {
  const filePath = path.join(SYNC_OUTPUT_DIR, `${institution}.json`);
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch { return null; }
}

// Copied from import.js — the actual normalization function under test
function normalizeAmountSign(amount, institution, raw, semantics) {
  if (!semantics?.institutions?.[institution]) return amount;
  const conv = semantics.institutions[institution].transactionConvention;
  if (!conv) return amount;
  if (conv.format === 'signed') {
    if (conv.debit === 'positive') return -amount;
  } else if (conv.format === 'typed') {
    const typeValue = raw[conv.typeColumn];
    if (typeValue === conv.debitValue && amount > 0) return -amount;
  }
  return amount;
}

function resolveField(mapping, canonicalName, raw, ...fallbacks) {
  if (mapping?.[canonicalName]) {
    const val = raw[mapping[canonicalName]];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  for (const fb of fallbacks) {
    const val = raw[fb];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

// ============================================================
// LAYER 1: Anchors vs raw Layer 1 data
// ============================================================

function validateAnchorsVsRaw(semantics) {
  console.log('\n=== LAYER 1: Anchors vs Raw Data ===\n');

  if (!semantics?.institutions) {
    skip('No data semantics found');
    return;
  }

  for (const [institution, config] of Object.entries(semantics.institutions)) {
    const anchors = config.anchors || [];
    if (!anchors.length) {
      skip(`${institution}: no anchors defined`);
      continue;
    }

    const data = loadSyncOutput(institution);
    if (!data) {
      skip(`${institution}: no sync output file`);
      continue;
    }

    const transactions = data.transactions || [];
    const mapping = config.columnMapping || null;

    for (const anchor of anchors) {
      if (!anchor.rawSign) continue;

      // Find matching transaction in raw data
      const match = transactions.find(txn => {
        const raw = txn.raw || {};
        const desc = resolveField(mapping, 'description', raw,
          'Description', 'Transaction Description', 'description',
          'Merchant', 'bankDescription', 'counterpartyName', 'note');
        return desc && desc.toUpperCase().includes(anchor.descriptionPattern.toUpperCase());
      });

      if (!match) {
        skip(`${institution}: anchor "${anchor.descriptionPattern}" not found in raw data`);
        continue;
      }

      const raw = match.raw || {};
      let amount = resolveField(mapping, 'amount', raw,
        'Amount', 'Transaction Amount', 'amount', 'Amount (USD)', 'netAmount');
      if (typeof amount === 'string') amount = parseFloat(amount.replace(/[$,]/g, ''));

      if (isNaN(amount) || amount === 0) {
        skip(`${institution}: anchor "${anchor.descriptionPattern}" has zero/NaN amount`);
        continue;
      }

      const actualRawSign = amount > 0 ? 'positive' : 'negative';
      if (actualRawSign === anchor.rawSign) {
        pass(`${institution}: raw "${anchor.descriptionPattern}" is ${anchor.rawSign} (${amount})`);
      } else {
        fail(`${institution}: raw "${anchor.descriptionPattern}" expected rawSign=${anchor.rawSign} but found ${actualRawSign} (${amount})`);
      }
    }
  }
}

// ============================================================
// LAYER 2: Normalization logic
// ============================================================

function validateNormalization(semantics) {
  console.log('\n=== LAYER 2: Sign Normalization ===\n');

  if (!semantics?.institutions) {
    skip('No data semantics found');
    return;
  }

  for (const [institution, config] of Object.entries(semantics.institutions)) {
    const anchors = config.anchors || [];
    if (!anchors.length) continue;

    const data = loadSyncOutput(institution);
    if (!data) continue;

    const transactions = data.transactions || [];
    const mapping = config.columnMapping || null;

    for (const anchor of anchors) {
      if (!anchor.rawSign || !anchor.is) continue;

      const match = transactions.find(txn => {
        const raw = txn.raw || {};
        const desc = resolveField(mapping, 'description', raw,
          'Description', 'Transaction Description', 'description',
          'Merchant', 'bankDescription', 'counterpartyName', 'note');
        return desc && desc.toUpperCase().includes(anchor.descriptionPattern.toUpperCase());
      });

      if (!match) continue;

      const raw = match.raw || {};
      let rawAmount = resolveField(mapping, 'amount', raw,
        'Amount', 'Transaction Amount', 'amount', 'Amount (USD)', 'netAmount');
      if (typeof rawAmount === 'string') rawAmount = parseFloat(rawAmount.replace(/[$,]/g, ''));
      if (isNaN(rawAmount) || rawAmount === 0) continue;

      const normalized = normalizeAmountSign(rawAmount, institution, raw, semantics);
      const expectedSign = anchor.is === 'debit' ? 'negative' : 'positive';
      const actualSign = normalized > 0 ? 'positive' : 'negative';

      if (actualSign === expectedSign) {
        pass(`${institution}: normalize("${anchor.descriptionPattern}") ${rawAmount} → ${normalized} (${anchor.is} = ${expectedSign})`);
      } else {
        fail(`${institution}: normalize("${anchor.descriptionPattern}") ${rawAmount} → ${normalized}, expected ${expectedSign} for ${anchor.is}`);
      }
    }
  }
}

// ============================================================
// LAYER 3: Database invariants
// ============================================================

function validateDatabase(semantics) {
  console.log('\n=== LAYER 3: Database Invariants ===\n');

  if (!fs.existsSync(DB_PATH)) {
    skip('Database not found');
    return;
  }

  const db = new Database(DB_PATH, { readonly: true });
  const accounts = loadAccounts();

  // --- 3a: Anchor transactions in DB have correct signs ---
  console.log('  [Anchor sign checks]');

  if (semantics?.institutions) {
    for (const [institution, config] of Object.entries(semantics.institutions)) {
      for (const anchor of (config.anchors || [])) {
        if (!anchor.is) continue;

        const row = db.prepare(
          `SELECT amount, description FROM transactions
           WHERE institution = ? AND description LIKE ?
           ORDER BY date DESC LIMIT 1`
        ).get(institution, `%${anchor.descriptionPattern}%`);

        if (!row) {
          // Try investment_transactions
          const invRow = db.prepare(
            `SELECT amount, description FROM investment_transactions
             WHERE institution = ? AND description LIKE ?
             ORDER BY date DESC LIMIT 1`
          ).get(institution, `%${anchor.descriptionPattern}%`);

          if (!invRow) {
            skip(`${institution}: anchor "${anchor.descriptionPattern}" not in DB`);
            continue;
          }

          const expectedSign = anchor.is === 'debit' ? 'negative' : 'positive';
          const actualSign = invRow.amount > 0 ? 'positive' : 'negative';
          if (actualSign === expectedSign) {
            pass(`${institution}: DB "${anchor.descriptionPattern}" = ${invRow.amount} (${anchor.is} = ${expectedSign})`);
          } else {
            fail(`${institution}: DB "${anchor.descriptionPattern}" = ${invRow.amount}, expected ${expectedSign} for ${anchor.is}`);
          }
          continue;
        }

        const expectedSign = anchor.is === 'debit' ? 'negative' : 'positive';
        const actualSign = row.amount > 0 ? 'positive' : 'negative';
        if (actualSign === expectedSign) {
          pass(`${institution}: DB "${anchor.descriptionPattern}" = ${row.amount} (${anchor.is} = ${expectedSign})`);
        } else {
          fail(`${institution}: DB "${anchor.descriptionPattern}" = ${row.amount}, expected ${expectedSign} for ${anchor.is}`);
        }
      }
    }
  }

  // --- 3b: Credit card purchases should be negative ---
  console.log('\n  [Credit card sign invariants]');

  const creditAccounts = db.prepare(
    `SELECT DISTINCT account_id FROM transactions WHERE account_type = 'credit'`
  ).all().map(r => r.account_id);

  for (const accountId of creditAccounts) {
    // Purchases on credit cards should be negative (money spent)
    const positivePurchases = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount > 0
        AND description NOT LIKE '%PAYMENT%'
        AND description NOT LIKE '%DEPOSIT%'
        AND description NOT LIKE '%CREDIT%'
        AND description NOT LIKE '%REFUND%'
        AND description NOT LIKE '%RETURN%'
        AND description NOT LIKE '%REVERSAL%'
        AND description NOT LIKE '%Thank%'
        AND (type IS NULL OR (type != 'Payment' AND type != 'Adjustment'))
    `).get(accountId);

    if (positivePurchases.cnt === 0) {
      pass(`${accountId}: no positive non-payment transactions (purchases are negative)`);
    } else {
      // Show samples
      const samples = db.prepare(`
        SELECT amount, description FROM transactions
        WHERE account_id = ? AND amount > 0
          AND description NOT LIKE '%PAYMENT%'
          AND description NOT LIKE '%DEPOSIT%'
          AND description NOT LIKE '%CREDIT%'
          AND description NOT LIKE '%REFUND%'
          AND description NOT LIKE '%RETURN%'
          AND description NOT LIKE '%REVERSAL%'
          AND description NOT LIKE '%Thank%'
          AND (type IS NULL OR (type != 'Payment' AND type != 'Adjustment'))
        LIMIT 5
      `).all(accountId);
      fail(`${accountId}: ${positivePurchases.cnt} positive non-payment transactions (should be negative)`);
      samples.forEach(s => console.log(`      ${s.amount} | ${s.description.substring(0, 70)}`));
    }

    // Payments to credit cards should be positive (money arriving to pay down balance)
    // Exclude returned/reversed payments — those are debits (balance went back up)
    const negativePayments = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount < 0
        AND (description LIKE '%PAYMENT%'
          OR description LIKE '%ACH DEPOSIT%'
          OR description LIKE '%Thank%'
          OR type = 'Payment')
        AND description NOT LIKE '%Returned%'
        AND description NOT LIKE '%Reversal%'
        AND (type IS NULL OR type != 'Reversal')
    `).get(accountId);

    if (negativePayments.cnt === 0) {
      pass(`${accountId}: no negative payment transactions (payments are positive)`);
    } else {
      const samples = db.prepare(`
        SELECT amount, description FROM transactions
        WHERE account_id = ? AND amount < 0
          AND (description LIKE '%PAYMENT%'
            OR description LIKE '%ACH DEPOSIT%'
            OR description LIKE '%Thank%'
            OR type = 'Payment')
          AND description NOT LIKE '%Returned%'
          AND description NOT LIKE '%Reversal%'
          AND (type IS NULL OR type != 'Reversal')
        LIMIT 5
      `).all(accountId);
      fail(`${accountId}: ${negativePayments.cnt} negative payment transactions (should be positive)`);
      samples.forEach(s => console.log(`      ${s.amount} | ${s.description.substring(0, 70)}`));
    }
  }

  // --- 3c: Checking account payroll should be positive ---
  console.log('\n  [Checking account sign invariants]');

  const checkingAccounts = db.prepare(
    `SELECT DISTINCT account_id FROM transactions WHERE account_type = 'checking'`
  ).all().map(r => r.account_id);

  for (const accountId of checkingAccounts) {
    // Payroll deposits should be positive
    const negativePayroll = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount < 0
        AND (description LIKE '%PAYROLL%' OR description LIKE '%DIR DEP%')
    `).get(accountId);

    if (negativePayroll.cnt === 0) {
      pass(`${accountId}: payroll deposits are positive`);
    } else {
      const samples = db.prepare(`
        SELECT amount, description FROM transactions
        WHERE account_id = ? AND amount < 0
          AND (description LIKE '%PAYROLL%' OR description LIKE '%DIR DEP%')
        LIMIT 3
      `).all(accountId);
      fail(`${accountId}: ${negativePayroll.cnt} negative payroll transactions (should be positive)`);
      samples.forEach(s => console.log(`      ${s.amount} | ${s.description.substring(0, 70)}`));
    }

    // Interest payments should be positive
    const negativeInterest = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount < 0
        AND (description LIKE '%INTEREST PAYMENT%' OR description LIKE '%Interest Paid%')
    `).get(accountId);

    if (negativeInterest.cnt === 0) {
      pass(`${accountId}: interest payments are positive`);
    } else {
      fail(`${accountId}: ${negativeInterest.cnt} negative interest payments (should be positive)`);
    }
  }

  // --- 3d: Savings account interest should be positive ---
  console.log('\n  [Savings account sign invariants]');

  const savingsAccounts = db.prepare(
    `SELECT DISTINCT account_id FROM transactions WHERE account_type = 'savings'`
  ).all().map(r => r.account_id);

  for (const accountId of savingsAccounts) {
    const negativeInterest = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount < 0
        AND (description LIKE '%Interest%' OR description LIKE '%INTEREST%')
    `).get(accountId);

    if (negativeInterest.cnt === 0) {
      pass(`${accountId}: interest is positive`);
    } else {
      fail(`${accountId}: ${negativeInterest.cnt} negative interest transactions (should be positive)`);
    }
  }

  // --- 3e: Mortgage payments should be negative ---
  console.log('\n  [Mortgage sign invariants]');

  const mortgageAccounts = db.prepare(
    `SELECT DISTINCT account_id FROM transactions WHERE account_type = 'mortgage'`
  ).all().map(r => r.account_id);

  for (const accountId of mortgageAccounts) {
    const positivePayments = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_id = ? AND amount > 0
        AND description LIKE '%Payment%'
    `).get(accountId);

    if (positivePayments.cnt === 0) {
      pass(`${accountId}: mortgage payments are negative`);
    } else {
      const samples = db.prepare(`
        SELECT amount, description FROM transactions
        WHERE account_id = ? AND amount > 0 AND description LIKE '%Payment%'
        LIMIT 3
      `).all(accountId);
      fail(`${accountId}: ${positivePayments.cnt} positive mortgage payments (should be negative)`);
      samples.forEach(s => console.log(`      ${s.amount} | ${s.description.substring(0, 70)}`));
    }
  }

  // --- 3f: Account-type-implied classifications ---
  console.log('\n  [Account-type-implied classifications]');

  const ACCOUNT_TYPE_CATEGORIES = {
    mortgage: 'Mortgage',
    auto_loan: 'Transportation',
    student_loan: 'Education',
    personal_loan: 'Transfer',
    heloc: 'Transfer',
    cd: 'Income',
  };

  for (const [accountType, expectedCategory] of Object.entries(ACCOUNT_TYPE_CATEGORIES)) {
    const wrongCategory = db.prepare(`
      SELECT COUNT(*) as cnt FROM transactions
      WHERE account_type = ? AND user_category IS NOT NULL AND user_category != ?
    `).get(accountType, expectedCategory);

    const total = db.prepare(
      `SELECT COUNT(*) as cnt FROM transactions WHERE account_type = ?`
    ).get(accountType);

    if (total.cnt === 0) {
      skip(`${accountType}: no transactions (not onboarded)`);
      continue;
    }

    if (wrongCategory.cnt === 0) {
      pass(`${accountType}: all ${total.cnt} transactions classified as ${expectedCategory}`);
    } else {
      const samples = db.prepare(`
        SELECT user_category, description FROM transactions
        WHERE account_type = ? AND user_category IS NOT NULL AND user_category != ?
        LIMIT 3
      `).all(accountType, expectedCategory);
      fail(`${accountType}: ${wrongCategory.cnt} of ${total.cnt} transactions NOT classified as ${expectedCategory}`);
      samples.forEach(s => console.log(`      ${s.user_category} | ${s.description.substring(0, 60)}`));
    }
  }

  // Verify model-classified accounts don't use account_type source
  const MODEL_ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'hsa', 'fsa', 'prepaid', 'money_market'];
  const wrongSource = db.prepare(`
    SELECT COUNT(*) as cnt FROM transactions
    WHERE account_type IN (${MODEL_ACCOUNT_TYPES.map(() => '?').join(',')})
      AND category_source = 'account_type'
  `).get(...MODEL_ACCOUNT_TYPES);

  if (wrongSource.cnt === 0) {
    pass('No model-classified accounts using account_type source');
  } else {
    fail(`${wrongSource.cnt} transactions on model-classified accounts using account_type source`);
  }

  // --- 3g: All account_ids in transactions exist in accounts.json ---
  console.log('\n  [Account registry consistency]');

  if (accounts) {
    const knownIds = new Set();
    for (const inst of Object.values(accounts)) {
      for (const acct of inst.accounts || []) {
        knownIds.add(acct.accountId);
      }
    }

    const dbAccountIds = db.prepare(
      `SELECT DISTINCT account_id FROM transactions
       UNION
       SELECT DISTINCT account_id FROM investment_transactions`
    ).all().map(r => r.account_id);

    const orphans = dbAccountIds.filter(id => !knownIds.has(id));
    if (orphans.length === 0) {
      pass(`All ${dbAccountIds.length} account IDs in DB exist in accounts.json`);
    } else {
      fail(`${orphans.length} account IDs in DB not found in accounts.json: ${orphans.join(', ')}`);
    }
  }

  // --- 3h: No zero-amount transactions ---
  console.log('\n  [Data quality]');

  const zeroAmount = db.prepare(
    `SELECT COUNT(*) as cnt FROM transactions WHERE amount = 0`
  ).get();

  if (zeroAmount.cnt === 0) {
    pass('No zero-amount transactions');
  } else {
    const samples = db.prepare(
      `SELECT account_id, description FROM transactions WHERE amount = 0 LIMIT 5`
    ).all();
    fail(`${zeroAmount.cnt} zero-amount transactions`);
    samples.forEach(s => console.log(`      ${s.account_id} | ${s.description.substring(0, 70)}`));
  }

  // --- 3i: All transactions have an institution ---
  const noInstitution = db.prepare(
    `SELECT COUNT(*) as cnt FROM transactions WHERE institution IS NULL OR institution = ''`
  ).get();

  if (noInstitution.cnt === 0) {
    pass('All transactions have an institution');
  } else {
    fail(`${noInstitution.cnt} transactions missing institution`);
  }

  // --- 3j: All transactions have a date ---
  const noDate = db.prepare(
    `SELECT COUNT(*) as cnt FROM transactions WHERE date IS NULL OR date = ''`
  ).get();

  if (noDate.cnt === 0) {
    pass('All transactions have a date');
  } else {
    fail(`${noDate.cnt} transactions missing date`);
  }

  db.close();
}

// ============================================================
// MAIN
// ============================================================

console.log('FOLIOME DATA VALIDATION');
console.log('='.repeat(50));

const semantics = loadSemantics();

validateAnchorsVsRaw(semantics);
validateNormalization(semantics);
validateDatabase(semantics);

console.log('\n' + '='.repeat(50));
console.log(`RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped`);

if (failed > 0) {
  console.log('\nFailed checks indicate data integrity issues.');
  console.log('Review config/data-semantics.json and re-run import if needed.');
  process.exit(1);
}
