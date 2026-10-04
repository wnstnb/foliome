#!/usr/bin/env node
/**
 * Import — transforms JSON sync output (Layer 1) into SQLite (Layer 2).
 *
 * Reads all JSON files from data/sync-output/, normalizes into canonical schema,
 * and upserts into SQLite. Raw bank data preserved in JSON columns.
 *
 * Usage:
 *   node sync-engine/import.js              # import all institutions
 *   node sync-engine/import.js --bank <institution> # import specific institution
 *   node sync-engine/import.js --init       # initialize database schema only
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { validateSlug } = require('../scripts/validate-slugs');
const { parseSymbol } = require('./parse-symbol');

const DB_PATH = path.join(__dirname, '..', 'data', 'foliome.db');
const SYNC_OUTPUT_DIR = path.join(__dirname, '..', 'data', 'sync-output');
const SEMANTICS_PATH = path.join(__dirname, '..', 'config', 'data-semantics.json');
const bankFilter = process.argv.includes('--bank') ? process.argv[process.argv.indexOf('--bank') + 1] : null;
const forceImport = process.argv.includes('--force');

// Deduplicate "no semantics" warnings (one per institution per run)
const _semanticsWarned = new Set();

// === Data Semantics ===

function loadSemantics() {
  try {
    return JSON.parse(fs.readFileSync(SEMANTICS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Normalize transaction amount sign using per-institution data semantics.
 * Converts from the platform's native convention to cardholder perspective
 * (debits negative, credits positive).
 */
function normalizeAmountSign(amount, institution, raw, semantics) {
  if (!semantics?.institutions?.[institution]) {
    if (!_semanticsWarned.has(institution)) {
      _semanticsWarned.add(institution);
      console.warn(`[import] WARNING: No data-semantics entry for "${institution}" — amounts imported as-is without sign normalization`);
    }
    return amount;
  }

  const conv = semantics.institutions[institution].transactionConvention;
  if (!conv) return amount;

  if (conv.format === 'signed') {
    // Platform uses a single signed amount column.
    // If debits are positive (issuer perspective), flip all signs.
    if (conv.debit === 'positive') {
      return -amount;
    }
  } else if (conv.format === 'typed') {
    // Platform uses unsigned amounts with a type indicator column.
    const typeValue = raw[conv.typeColumn];
    if (typeValue === conv.debitValue && amount > 0) {
      return -amount;
    }
  }
  // format === 'unknown' or unrecognized: pass through unchanged
  return amount;
}

// ============================================================================
// Transaction Identity Resolution
// ============================================================================
//
// Four layers prevent duplicate transactions:
//
//   Layer 1 — Stable Bank ID (existing): API sources (e.g. a bank REST API) provide a
//   bank-assigned UUID. Stored in bank_transaction_id, used for pending→posted
//   dedup. Configured via stableIdField in data-semantics.json.
//
//   Layer 2 — Description Normalization (new): Chase and other CSV banks emit
//   the same transaction with different description formats across syncs (e.g.,
//   verbose ACH headers on day 1, condensed form on day 2). Regex rules in
//   data-semantics.json normalize descriptions to a canonical form BEFORE
//   insert, so the UNIQUE constraint catches them as identical.
//
//   Layer 3 — Natural Key UNIQUE constraint (existing): The (institution,
//   account_id, date, amount, description) constraint catches exact re-imports.
//
//   Layer 4 — Post-import Reconciliation (new): For duplicates that already
//   exist in the database (from before normalization was added), find rows
//   sharing (institution, account_id, date, amount) with different descriptions
//   but the same embedded transaction ID, and merge them.
// ============================================================================

/**
 * Layer 2: Normalize a transaction description using per-institution regex rules.
 * Applies descriptionNormalization rules from data-semantics.json in order.
 * Returns the original description unchanged if no rules exist for the institution.
 */
function normalizeDescription(institution, description, semanticsData) {
  const rules = semanticsData?.institutions?.[institution]?.descriptionNormalization;
  if (!rules || !Array.isArray(rules) || rules.length === 0) return description;

  let result = description;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.match, 'i');
      result = result.replace(regex, rule.replace);
    } catch (e) {
      console.warn(`[import] Bad normalization regex for ${institution}: ${rule.match} — ${e.message}`);
    }
  }

  // Collapse whitespace and trim
  result = result.replace(/\s+/g, ' ').trim();
  return result;
}

/**
 * Resolve a field from raw data using column mapping, with fallback chain.
 * mapping: the institution's columnMapping or investmentColumnMapping object
 * canonicalName: the field we want (e.g., 'description', 'amount')
 * raw: the raw transaction data object
 * ...fallbacks: legacy column names to try if no mapping exists
 */
function resolveField(mapping, canonicalName, raw, ...fallbacks) {
  // Try explicit mapping first
  if (mapping?.[canonicalName]) {
    const val = raw[mapping[canonicalName]];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  // Try mapping fallbacks (e.g., descriptionFallbacks)
  const fbKey = canonicalName + 'Fallbacks';
  if (mapping?.[fbKey]) {
    for (const fb of mapping[fbKey]) {
      const val = raw[fb];
      if (val !== undefined && val !== null && val !== '') return val;
    }
  }
  // Try legacy guessing chain
  for (const fb of fallbacks) {
    const val = raw[fb];
    if (val !== undefined && val !== null && val !== '') return val;
  }
  return null;
}

/**
 * Pre-import validation: check raw data against expected anchor signs
 * BEFORE normalization. If a platform changed its sign convention,
 * catch it here before bad data enters SQLite.
 */
function validateRawData(transactions, institution, semantics) {
  const instSemantics = semantics?.institutions?.[institution];
  if (!instSemantics?.anchors?.length) return [];

  const mapping = instSemantics.columnMapping || null;
  const warnings = [];

  for (const anchor of instSemantics.anchors) {
    if (!anchor.rawSign) continue;

    // Find a matching transaction in the raw data
    const match = transactions.find(txn => {
      const raw = txn.raw || {};
      const desc = resolveField(mapping, 'description', raw,
        'Description', 'Transaction Description', 'description',
        'Merchant', 'bankDescription', 'counterpartyName', 'note');
      return desc && desc.toUpperCase().includes(anchor.descriptionPattern.toUpperCase());
    });

    if (!match) continue;

    const raw = match.raw || {};
    let amount = resolveField(mapping, 'amount', raw,
      'Amount', 'Transaction Amount', 'amount', 'Amount (USD)', 'netAmount');
    if (typeof amount === 'string') amount = parseFloat(amount.replace(/[$,]/g, ''));
    if (isNaN(amount) || amount === 0) continue;

    const actualRawSign = amount > 0 ? 'positive' : 'negative';
    if (actualRawSign !== anchor.rawSign) {
      warnings.push(
        `[pre-validate] ${institution}: raw "${anchor.descriptionPattern}" expected rawSign=${anchor.rawSign} ` +
        `but found ${actualRawSign} (${amount}). Platform may have changed its convention. ` +
        `Halting import for this institution — update config/data-semantics.json.`
      );
    }
  }

  return warnings;
}

/**
 * Validate imported transactions against known anchors.
 * Returns warnings for any anchor violations.
 */
function validateAnchors(db, institution, semantics) {
  if (!semantics?.institutions?.[institution]) return [];

  const anchors = semantics.institutions[institution].anchors || [];
  const warnings = [];

  for (const anchor of anchors) {
    const row = db.prepare(
      `SELECT amount FROM transactions
       WHERE institution = ? AND description LIKE ? AND date >= date('now', '-365 days')
       ORDER BY date DESC LIMIT 1`
    ).get(institution, `%${anchor.descriptionPattern}%`);

    if (!row) continue; // no matching transaction in recent data

    const actualSign = row.amount > 0 ? 'positive' : 'negative';
    const expectedSign = anchor.is === 'debit' ? 'negative' : 'positive'; // target convention

    if (actualSign !== expectedSign) {
      warnings.push(
        `[validate] ${institution}: "${anchor.descriptionPattern}" is a ${anchor.is} but has ${actualSign} amount (${row.amount}). ` +
        `Expected ${expectedSign} in cardholder perspective. Data semantics may need updating.`
      );
    }
  }

  return warnings;
}

const semantics = loadSemantics();

// === Database Setup ===

/**
 * One-time cleanup: find transactions that share the same bank_transaction_id
 * (extracted from raw JSON) but have different dates — a pending→posted duplicate.
 * Keep the posted row (or the newer one), delete the other.
 * Also backfill bank_transaction_id from raw JSON for institutions with stableIdField.
 */
function _cleanupPendingPostedDuplicates(db) {
  if (!semantics) return;

  // Collect institutions that have a stableIdField
  const stableInstitutions = [];
  for (const [inst, cfg] of Object.entries(semantics.institutions || {})) {
    if (cfg.stableIdField) stableInstitutions.push({ institution: inst, field: cfg.stableIdField });
  }
  if (stableInstitutions.length === 0) return;

  for (const { institution, field } of stableInstitutions) {
    // Backfill bank_transaction_id from raw JSON where it's NULL
    const rows = db.prepare(
      `SELECT id, raw FROM transactions WHERE institution = ? AND bank_transaction_id IS NULL AND raw IS NOT NULL`
    ).all(institution);

    let backfilled = 0;
    const updateBankId = db.prepare(`UPDATE transactions SET bank_transaction_id = ? WHERE id = ?`);
    for (const row of rows) {
      try {
        const rawData = JSON.parse(row.raw);
        const bankId = rawData[field];
        if (bankId) {
          updateBankId.run(String(bankId), row.id);
          backfilled++;
        }
      } catch {}
    }
    if (backfilled > 0) {
      console.log(`[import] Backfilled bank_transaction_id for ${backfilled} ${institution} transactions`);
    }

    // Find and remove duplicates: same bank_transaction_id, different rows
    const dupes = db.prepare(`
      SELECT bank_transaction_id, COUNT(*) as cnt
      FROM transactions
      WHERE institution = ? AND bank_transaction_id IS NOT NULL
      GROUP BY bank_transaction_id
      HAVING cnt > 1
    `).all(institution);

    let cleaned = 0;
    for (const { bank_transaction_id } of dupes) {
      // Get all rows for this bank ID, prefer posted over pending, then newest date
      const dupRows = db.prepare(`
        SELECT id, status, date FROM transactions
        WHERE institution = ? AND bank_transaction_id = ?
        ORDER BY
          CASE WHEN status = 'posted' THEN 0 ELSE 1 END,
          date DESC
      `).all(institution, bank_transaction_id);

      // Keep the first (posted/newest), delete the rest
      for (let i = 1; i < dupRows.length; i++) {
        db.prepare(`DELETE FROM transactions WHERE id = ?`).run(dupRows[i].id);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[import] Cleaned up ${cleaned} pending→posted duplicate(s) for ${institution}`);
    }
  }
}

function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    -- Balance snapshots: one row per account per sync
    CREATE TABLE IF NOT EXISTS balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT,
      account_type TEXT NOT NULL,
      balance REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      synced_at TEXT NOT NULL,
      UNIQUE(account_id, synced_at)
    );

    -- Day-to-day transactions: checking, savings, credit cards, mortgage payments
    -- Two dedup strategies:
    --   1. bank_transaction_id (API sources): stable bank-assigned ID survives date shifts
    --      (pending→posted). import.js checks for existing row by bank ID before inserting.
    --   2. Natural-key UNIQUE on (institution, account_id, date, amount, description):
    --      fallback for CSV sources. Stable across re-syncs because date/amount/description
    --      are what the bank actually emits per row.
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_type TEXT,
      transaction_date TEXT,                  -- when user initiated (swipe/purchase date)
      posting_date TEXT,                      -- when it settled on the account
      date TEXT NOT NULL,                     -- canonical query date (= posting_date ?? transaction_date)
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      type TEXT,
      category TEXT,                          -- raw category from bank (preserved as-is)
      user_category TEXT,                     -- our classification (model, rule, or user override)
      category_source TEXT,                   -- 'bank', 'model', 'rule', 'user_override'
      category_confidence REAL,               -- model confidence (0-1), null for rules/overrides
      balance_after REAL,
      status TEXT DEFAULT 'posted',
      raw TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(institution, account_id, date, amount, description)
    );

    -- Investment transactions: trades, dividends, contributions
    -- Symbol included in natural key because two same-amount/date trades on different
    -- symbols are distinct events.
    CREATE TABLE IF NOT EXISTS investment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      type TEXT,
      symbol TEXT,
      quantity REAL,
      price REAL,
      amount REAL NOT NULL,
      fees REAL DEFAULT 0,
      raw TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(institution, account_id, date, amount, description, symbol)
    );

    -- Holdings snapshots: positions per account per sync
    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT,
      quantity REAL NOT NULL,
      price REAL,
      market_value REAL,
      cost_basis REAL,
      underlying TEXT,
      instrument_type TEXT,
      put_call TEXT,
      strike REAL,
      expiry TEXT,
      multiplier INTEGER DEFAULT 1,
      asset_type TEXT,
      currency TEXT DEFAULT 'USD',
      synced_at TEXT NOT NULL,
      UNIQUE(account_id, symbol, synced_at)
    );

    -- Statement closing balances (historical period-end anchors)
    CREATE TABLE IF NOT EXISTS statement_balances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      institution TEXT NOT NULL,
      account_id TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT NOT NULL,
      opening_balance REAL,
      closing_balance REAL NOT NULL,
      source TEXT,
      raw_text TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(institution, account_id, period_end)
    );

    -- Sync status per institution
    CREATE TABLE IF NOT EXISTS sync_status (
      institution TEXT PRIMARY KEY,
      last_success TEXT,
      last_attempt TEXT,
      last_error TEXT,
      balances_count INTEGER DEFAULT 0,
      transactions_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ok'
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_balances_account ON balances(account_id, synced_at);
    CREATE INDEX IF NOT EXISTS idx_transactions_account_date ON transactions(account_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_investment_transactions_account ON investment_transactions(account_id, date);
    CREATE INDEX IF NOT EXISTS idx_holdings_account ON holdings(account_id, synced_at);
    CREATE INDEX IF NOT EXISTS idx_statement_balances_account ON statement_balances(account_id, period_end);
  `);

  // Migrate existing holdings tables: add new columns if missing (idempotent)
  const newCols = [
    ['underlying', 'TEXT'],
    ['instrument_type', 'TEXT'],
    ['put_call', 'TEXT'],
    ['strike', 'REAL'],
    ['expiry', 'TEXT'],
    ['multiplier', 'INTEGER DEFAULT 1'],
    ['asset_type', 'TEXT'],
  ];
  for (const [col, type] of newCols) {
    try { db.exec(`ALTER TABLE holdings ADD COLUMN ${col} ${type}`); } catch {}
  }

  // Create index after migration ensures column exists
  db.exec(`CREATE INDEX IF NOT EXISTS idx_holdings_underlying ON holdings(underlying, synced_at)`);

  // Migrate: add bank_transaction_id column for API-source dedup (nullable — CSV sources won't have it)
  // When a bank provides a stable ID (e.g., an API connector's transaction UUID), pending→posted date shifts no longer
  // create duplicates — we find the existing row by bank_transaction_id and UPDATE it.
  try { db.exec(`ALTER TABLE transactions ADD COLUMN bank_transaction_id TEXT`); } catch {}
  db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_bank_txn_id ON transactions(institution, bank_transaction_id)`);

  // One-time cleanup: deduplicate pending→posted rows that slipped through before bank_transaction_id existed.
  // For each pair sharing the same bank ID (embedded in raw JSON), keep the posted row and delete the pending one.
  _cleanupPendingPostedDuplicates(db);

  // One-time cleanup: normalize existing descriptions and reconcile duplicates.
  // Applies Layer 2 (description normalization) and Layer 4 (reconciliation) to
  // historical data. Idempotent — subsequent runs find nothing to change.
  _normalizeExistingDescriptions(db);

  return db;
}

// === Normalization ===

/**
 * Normalize a raw transaction from any bank into the canonical schema.
 * Returns { table: 'transactions' | 'investment_transactions', row: {...} }
 */
function normalizeTransaction(institution, accountId, accountType, raw) {
  // Determine if this is an investment transaction
  const isInvestment = ['brokerage', 'retirement', 'education'].includes(accountType);

  if (isInvestment) {
    return normalizeInvestmentTransaction(institution, accountId, raw);
  } else {
    return normalizeDayToDay(institution, accountId, accountType, raw);
  }
}

function normalizeDayToDay(institution, accountId, accountType, raw) {
  const r = raw;
  const mapping = semantics?.institutions?.[institution]?.columnMapping || null;

  // Transaction date: when the user initiated (swipe date)
  let transactionDate = resolveField(mapping, 'transactionDate', r,
    'Transaction Date', 'createdAt', 'tradeDate');
  if (transactionDate) transactionDate = normalizeDate(transactionDate);

  // Posting date: when it settled on the account
  let postingDate = resolveField(mapping, 'postingDate', r,
    'Posting Date', 'Post Date', 'Clearing Date', 'postedAt');
  if (postingDate) postingDate = normalizeDate(postingDate);

  // Canonical date: posting date preferred (when money actually moved), fallback to transaction date
  let date = postingDate || transactionDate || normalizeDate(r['date']) || null;

  // If we only got one date from a generic 'date' field, use it for both
  if (!transactionDate && !postingDate && date) {
    transactionDate = date;
    postingDate = date;
  }

  if (!date) return null;

  // Description
  let description = resolveField(mapping, 'description', r,
    'Description', 'Transaction Description', 'description',
    'Merchant', 'bankDescription', 'counterpartyName', 'note');
  if (!description) return null;

  // Layer 2: Apply per-institution description normalization rules from data-semantics.json.
  // This handles format variations like Chase ACH detail vs condensed descriptions.
  // Rules are applied BEFORE any other normalization so the regex patterns match raw input.
  description = normalizeDescription(institution, description, semantics);

  // Chase checking: additional hardcoded normalizations beyond what regex rules handle.
  // These are structural patterns (case, inline numbers, masked accounts) that apply
  // broadly and aren't well-suited to individual regex rules.
  if (institution === 'chase' && accountType === 'checking') {
    // Normalize whitespace
    description = description.replace(/\s+/g, ' ').trim();
    // Normalize case to lowercase for dedup (original preserved in raw JSON)
    description = description.toLowerCase();
    // Strip inline transaction numbers from transfers: "online transfer 28476066877 to" → "online transfer to"
    description = description.replace(/online transfer \d+ to/i, 'online transfer to');
    // Normalize "transaction #: 12345" vs "transaction#:12345 MM/DD"
    description = description.replace(/transaction\s*#?\s*:?\s*\d+\s*\d{0,2}\/?\d{0,2}/, 'transaction');
    // Normalize masked account numbers: "#######1234" vs "xxxxxxx1234"
    description = description.replace(/[#x]{4,}\d{4}/gi, m => '****' + m.slice(-4));
  }

  // Amount
  let amount = resolveField(mapping, 'amount', r,
    'Amount', 'Transaction Amount', 'amount', 'Amount (USD)', 'netAmount');
  if (amount === null || amount === undefined) amount = 0;
  if (typeof amount === 'string') {
    amount = parseFloat(amount.replace(/[$,]/g, ''));
  }
  if (isNaN(amount)) return null;

  // Apply data semantics: normalize sign to cardholder perspective
  amount = normalizeAmountSign(amount, institution, r, semantics);

  // Type
  const type = resolveField(mapping, 'type', r,
    'Type', 'Transaction Type', 'type', 'Details', 'kind');

  // Category
  const category = resolveField(mapping, 'category', r,
    'Category', 'mercuryCategory', 'category');

  // Balance after transaction
  let balanceAfter = resolveField(mapping, 'balanceAfter', r,
    'Balance', 'balance_after', 'balance');
  if (typeof balanceAfter === 'string') {
    balanceAfter = parseFloat(balanceAfter.replace(/[$,]/g, ''));
  }
  if (isNaN(balanceAfter)) balanceAfter = null;

  // Status: trust the bank's signal when present (some API exports carry `status: pending`/`sent`).
  // Otherwise default to 'posted' — the absence of a posting date does NOT mean pending,
  // since some institutions (Capital One savings) simply don't expose that column.
  const rawStatus = resolveField(mapping, 'status', r, 'status');
  let status = 'posted';
  if (rawStatus && /pend/i.test(String(rawStatus))) status = 'pending';

  // Bank-provided stable transaction ID (API sources only).
  // Used for dedup when date shifts between pending→posted.
  const stableIdField = semantics?.institutions?.[institution]?.stableIdField;
  const bankTransactionId = stableIdField ? (r[stableIdField] || null) : null;

  return {
    table: 'transactions',
    row: {
      institution,
      account_id: accountId,
      account_type: accountType,
      transaction_date: transactionDate,
      posting_date: postingDate,
      date,
      description: description.trim(),
      amount,
      currency: 'USD',
      type,
      category,
      balance_after: balanceAfter,
      status,
      bank_transaction_id: bankTransactionId ? String(bankTransactionId) : null,
      raw: JSON.stringify(raw),
    },
  };
}

function normalizeInvestmentTransaction(institution, accountId, raw) {
  const r = raw;
  const mapping = semantics?.institutions?.[institution]?.investmentColumnMapping || null;

  let tradeDate = resolveField(mapping, 'tradeDate', r,
    'Trade Date', 'tradeDate', 'time', 'date');
  if (tradeDate) tradeDate = normalizeDate(tradeDate);

  let settlementDate = resolveField(mapping, 'settlementDate', r,
    'settlementDate', 'Settlement Date', 'Clearing Date');
  if (settlementDate) settlementDate = normalizeDate(settlementDate);

  let date = tradeDate || settlementDate;
  if (!date) return null;

  const description = resolveField(mapping, 'description', r,
    'Description', 'description', 'Fund Name');
  if (!description) return null;

  let amount = resolveField(mapping, 'amount', r,
    'Amount', 'amount', 'netAmount');
  if (amount === null || amount === undefined) amount = 0;
  if (typeof amount === 'string') amount = parseFloat(amount.replace(/[$,]/g, ''));
  if (isNaN(amount)) return null;

  const type = resolveField(mapping, 'type', r,
    'Type', 'type', 'Description');
  const symbol = resolveField(mapping, 'symbol', r,
    'symbol', 'Symbol');

  let quantity = resolveField(mapping, 'quantity', r,
    'Shares', 'quantity', 'longQuantity');
  if (typeof quantity === 'string') quantity = parseFloat(quantity.replace(/,/g, ''));

  let price = resolveField(mapping, 'price', r,
    'Price', 'price');
  if (typeof price === 'string') price = parseFloat(price.replace(/[$,]/g, ''));

  // Coerce symbol to empty string (never null) so the natural UNIQUE key works.
  // SQLite treats NULL values in UNIQUE constraints as distinct (NULL ≠ NULL),
  // which would let dividends/cash entries with no symbol bypass dedup.
  const symbolKey = symbol == null ? '' : String(symbol);

  return {
    table: 'investment_transactions',
    row: {
      institution,
      account_id: accountId,
      date,
      description: description.trim(),
      type,
      symbol: symbolKey,
      quantity,
      price,
      amount,
      fees: 0,
      raw: JSON.stringify(raw),
    },
  };
}

function normalizeDate(dateStr) {
  if (!dateStr) return null;

  // Already YYYY-MM-DD
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) return dateStr.substring(0, 10);

  // MM/DD/YYYY
  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;

  // MM/DD/YY
  const mdyShort = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (mdyShort) {
    const year = parseInt(mdyShort[3]) > 50 ? '19' + mdyShort[3] : '20' + mdyShort[3];
    return `${year}-${mdyShort[1].padStart(2, '0')}-${mdyShort[2].padStart(2, '0')}`;
  }

  // ISO 8601 datetime
  const iso = dateStr.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (iso) return iso[1];

  return null;
}

// === Import Logic ===

function importInstitution(db, institution, data) {
  const syncedAt = data.syncedAt || new Date().toISOString();
  let balancesImported = 0;
  let txnsImported = 0;
  let txnsSkipped = 0;
  let holdingsImported = 0;

  // Import balances
  const insertBalance = db.prepare(`
    INSERT OR REPLACE INTO balances (institution, account_id, account_name, account_type, balance, currency, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const bal of (data.balances || [])) {
    // Validate balance value — match the guards used for transaction amounts
    let balance = bal.balance;
    if (typeof balance === 'string') {
      balance = parseFloat(balance.replace(/[$,]/g, ''));
    }
    if (typeof balance !== 'number' || isNaN(balance)) {
      console.warn(`[import] Skipping balance with invalid value for ${bal.accountName || bal.accountId}: ${bal.balance}`);
      continue;
    }

    insertBalance.run(
      institution,
      bal.accountId || bal.account_id,
      bal.accountName || bal.account_name || '',
      bal.accountType || bal.account_type || 'unknown',
      balance,
      bal.currency || 'USD',
      syncedAt
    );
    balancesImported++;
  }

  // Import transactions — two dedup strategies:
  //
  // 1. Bank-ID dedup (API sources): When the bank provides a stable transaction ID
  //    (e.g., an API transaction UUID), check for an existing row with that ID first. If found,
  //    UPDATE it — this handles pending→posted date shifts without creating duplicates.
  //
  // 2. Natural-key UPSERT (all sources): Falls through to the UNIQUE constraint on
  //    (institution, account_id, date, amount, description). Handles re-syncs of the
  //    same data gracefully.
  const updateByBankId = db.prepare(`
    UPDATE transactions SET
      account_type = ?,
      transaction_date = COALESCE(?, transaction_date),
      posting_date = COALESCE(?, posting_date),
      date = ?,
      description = ?,
      amount = ?,
      currency = ?,
      type = ?,
      category = ?,
      balance_after = COALESCE(?, balance_after),
      status = ?,
      raw = ?,
      updated_at = datetime('now')
    WHERE institution = ? AND bank_transaction_id = ?
  `);

  const findByBankId = db.prepare(
    `SELECT id FROM transactions WHERE institution = ? AND bank_transaction_id = ?`
  );

  const insertTxn = db.prepare(`
    INSERT INTO transactions (institution, account_id, account_type, transaction_date, posting_date, date, description, amount, currency, type, category, balance_after, status, bank_transaction_id, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(institution, account_id, date, amount, description) DO UPDATE SET
      posting_date = COALESCE(excluded.posting_date, posting_date),
      transaction_date = COALESCE(excluded.transaction_date, transaction_date),
      status = excluded.status,
      balance_after = COALESCE(excluded.balance_after, balance_after),
      bank_transaction_id = COALESCE(excluded.bank_transaction_id, bank_transaction_id),
      raw = excluded.raw,
      updated_at = datetime('now')
  `);

  const insertInvTxn = db.prepare(`
    INSERT INTO investment_transactions (institution, account_id, date, description, type, symbol, quantity, price, amount, fees, raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(institution, account_id, date, amount, description, symbol) DO UPDATE SET
      raw = excluded.raw,
      updated_at = datetime('now')
  `);

  // Build account type lookup from balances — connectors may omit accountType on transactions
  const accountTypeLookup = {};
  for (const bal of (data.balances || [])) {
    const id = bal.accountId || bal.account_id;
    const type = bal.accountType || bal.account_type;
    if (id && type) accountTypeLookup[id] = type;
  }

  for (const txn of (data.transactions || [])) {
    const raw = txn.raw || {};
    const accountId = txn.accountId || txn.account_id || `${institution}-unknown`;
    const normalized = normalizeTransaction(
      institution,
      accountId,
      txn.accountType || txn.account_type || accountTypeLookup[accountId] || 'checking',
      raw
    );

    if (!normalized) {
      txnsSkipped++;
      continue;
    }

    try {
      if (normalized.table === 'transactions') {
        const r = normalized.row;

        // Strategy 1: Bank-ID dedup — if we have a stable bank ID, check for existing row
        let handledByBankId = false;
        if (r.bank_transaction_id) {
          const existing = findByBankId.get(r.institution, r.bank_transaction_id);
          if (existing) {
            // UPDATE the existing row — date/status/description may have changed (pending→posted)
            updateByBankId.run(
              r.account_type, r.transaction_date, r.posting_date, r.date, r.description,
              r.amount, r.currency, r.type, r.category, r.balance_after, r.status, r.raw,
              r.institution, r.bank_transaction_id
            );
            handledByBankId = true;
          }
        }

        // Strategy 2: Natural-key INSERT/UPSERT (new row, or CSV-source dedup)
        if (!handledByBankId) {
          insertTxn.run(r.institution, r.account_id, r.account_type, r.transaction_date, r.posting_date,
            r.date, r.description, r.amount, r.currency, r.type, r.category, r.balance_after, r.status,
            r.bank_transaction_id, r.raw);
        }
      } else {
        const r = normalized.row;
        insertInvTxn.run(r.institution, r.account_id, r.date, r.description,
          r.type, r.symbol, r.quantity, r.price, r.amount, r.fees, r.raw);
      }
      txnsImported++;
    } catch (e) {
      if (e.message.includes('UNIQUE constraint')) {
        txnsSkipped++; // Already exists, dedup working
      } else {
        console.warn(`[import] Skipping transaction: ${e.message.substring(0, 60)}`);
        txnsSkipped++;
      }
    }
  }

  // Import holdings from both sources:
  // 1. Top-level data.holdings[] (new format — Schwab connector, future brokerages)
  // 2. data.balances[].positions[] (legacy format — embedded in balance records)
  const insertHolding = db.prepare(`
    INSERT OR REPLACE INTO holdings (institution, account_id, symbol, name, quantity, price, market_value, cost_basis,
      underlying, instrument_type, put_call, strike, expiry, multiplier, asset_type, currency, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Determine cost basis format from data-semantics holdingsSemantics
  const holdingsSemantics = semantics?.institutions?.[institution]?.holdingsSemantics || {};
  const costBasisFormat = holdingsSemantics.costBasisFormat || 'total';

  // Collect positions from both sources
  const allPositions = [];

  // Source 1: top-level holdings array
  for (const pos of (data.holdings || [])) {
    if (pos.symbol || pos.name) {
      allPositions.push({
        accountId: pos.accountId || pos.account_id,
        ...pos,
      });
    }
  }

  // Source 2: legacy balances[].positions[] (only if no top-level holdings)
  if (allPositions.length === 0) {
    for (const bal of (data.balances || [])) {
      for (const pos of (bal.positions || [])) {
        if (pos.symbol || pos.name) {
          allPositions.push({
            accountId: bal.accountId || bal.account_id,
            ...pos,
          });
        }
      }
    }
  }

  for (const pos of allPositions) {
    const symbol = pos.symbol || '';
    const parsed = parseSymbol(symbol, pos.name);
    const quantity = pos.quantity || 0;
    const marketValue = pos.marketValue || pos.market_value || 0;
    const rawCostBasis = pos.costBasis ?? pos.cost_basis ?? null;

    // Normalize cost basis: if source gives per-share, multiply by abs(qty) × multiplier
    let costBasis = rawCostBasis;
    if (costBasis !== null && costBasis !== undefined && costBasisFormat === 'per_share') {
      costBasis = costBasis * Math.abs(quantity) * parsed.multiplier;
    }

    insertHolding.run(
      institution,
      pos.accountId,
      symbol,
      pos.name || null,
      quantity,
      pos.price || 0,
      marketValue,
      costBasis,
      parsed.underlying,
      parsed.instrumentType,
      parsed.putCall,
      parsed.strike,
      parsed.expiry,
      parsed.multiplier,
      pos.assetType || pos.asset_type || null,
      'USD',
      syncedAt
    );
    holdingsImported++;
  }

  // Import statement balances (period-end closing balances from statements)
  const insertStmtBal = db.prepare(`
    INSERT INTO statement_balances (institution, account_id, period_start, period_end, opening_balance, closing_balance, source, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(institution, account_id, period_end) DO UPDATE SET
      opening_balance = COALESCE(excluded.opening_balance, opening_balance),
      closing_balance = excluded.closing_balance,
      source = excluded.source,
      raw_text = excluded.raw_text
  `);

  for (const sb of (data.statementBalances || [])) {
    let closing = sb.closingBalance ?? sb.closing_balance;
    if (typeof closing === 'string') closing = parseFloat(closing.replace(/[$,]/g, ''));
    if (typeof closing !== 'number' || isNaN(closing)) continue;

    let opening = sb.openingBalance ?? sb.opening_balance ?? null;
    if (opening !== null) {
      if (typeof opening === 'string') opening = parseFloat(opening.replace(/[$,]/g, ''));
      if (typeof opening !== 'number' || isNaN(opening)) opening = null;
    }

    insertStmtBal.run(
      institution,
      sb.accountId || sb.account_id,
      sb.periodStart || sb.period_start || null,
      sb.periodEnd || sb.period_end,
      opening,
      closing,
      sb.source || 'pdf',
      sb.rawText || sb.raw_text || null
    );
  }

  // Update sync status
  const updateStatus = db.prepare(`
    INSERT INTO sync_status (institution, last_success, last_attempt, balances_count, transactions_count, status)
    VALUES (?, ?, ?, ?, ?, 'ok')
    ON CONFLICT(institution) DO UPDATE SET
      last_success = excluded.last_success,
      last_attempt = excluded.last_attempt,
      balances_count = excluded.balances_count,
      transactions_count = excluded.transactions_count,
      status = 'ok',
      last_error = NULL
  `);
  updateStatus.run(institution, syncedAt, syncedAt, balancesImported, txnsImported);

  return { balancesImported, txnsImported, txnsSkipped, holdingsImported };
}

// === Layer 4: Post-import Reconciliation ===

/**
 * Extract all ID-like tokens from a transaction description.
 * Matches patterns like "id: 1390989781", "web id: paypalsi77", "orig id:3264681992".
 * Returns a Set of lowercase ID values.
 */
function extractTransactionIds(description) {
  const ids = new Set();
  // Match "id:", "orig id:", "web id:", etc. followed by an alphanumeric token
  const idPattern = /(?:orig id|web id|ind id|id)\s*:?\s*(\S+)/gi;
  let m;
  while ((m = idPattern.exec(description)) !== null) {
    ids.add(m[1].toLowerCase());
  }
  return ids;
}

/**
 * Layer 4: Post-import reconciliation — find and merge duplicate transactions
 * that slipped through before description normalization was added.
 *
 * Strategy: For each pair of rows sharing (institution, account_id, date, amount)
 * but with different descriptions, check if they share an embedded transaction ID.
 * If yes, they're the same transaction in two description formats — keep the cleaner
 * one (shorter description, or posted over pending) and delete the other.
 *
 * Safety: Pairs with no shared ID are skipped (e.g., two different $25 purchases
 * on the same day, or two Amazon orders with the same amount).
 */
function reconcileDuplicates(db) {
  // Find all potential duplicate groups: same (institution, account_id, date, amount), 2+ rows
  const groups = db.prepare(`
    SELECT institution, account_id, date, amount, COUNT(*) as cnt
    FROM transactions
    GROUP BY institution, account_id, date, amount
    HAVING cnt > 1
  `).all();

  if (groups.length === 0) return 0;

  let totalCleaned = 0;

  for (const group of groups) {
    const rows = db.prepare(`
      SELECT id, description, status, created_at
      FROM transactions
      WHERE institution = ? AND account_id = ? AND date = ? AND amount = ?
      ORDER BY created_at DESC
    `).all(group.institution, group.account_id, group.date, group.amount);

    // Compare every pair in the group
    const toDelete = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (toDelete.has(rows[i].id)) continue;
      for (let j = i + 1; j < rows.length; j++) {
        if (toDelete.has(rows[j].id)) continue;
        // If descriptions are identical after normalization, they'd be caught by UNIQUE — skip
        if (rows[i].description === rows[j].description) continue;

        // Extract IDs from both descriptions
        const ids1 = extractTransactionIds(rows[i].description);
        const ids2 = extractTransactionIds(rows[j].description);

        // No IDs in either description — can't confirm they're the same transaction
        if (ids1.size === 0 && ids2.size === 0) continue;

        // Check for shared IDs
        let hasSharedId = false;
        for (const id of ids1) {
          if (ids2.has(id)) { hasSharedId = true; break; }
        }
        if (!hasSharedId) continue;

        // High confidence: same date+amount+account AND shared transaction ID.
        // Keep the better row: prefer posted over pending, then shorter description
        // (the condensed form is more readable), then newer created_at.
        let keep, remove;
        if (rows[i].status === 'posted' && rows[j].status !== 'posted') {
          keep = rows[i]; remove = rows[j];
        } else if (rows[j].status === 'posted' && rows[i].status !== 'posted') {
          keep = rows[j]; remove = rows[i];
        } else if (rows[i].description.length <= rows[j].description.length) {
          keep = rows[i]; remove = rows[j];
        } else {
          keep = rows[j]; remove = rows[i];
        }

        toDelete.add(remove.id);
        console.log(`[reconcile] Merging duplicate: ${group.institution} ${group.date} $${group.amount}`);
        console.log(`[reconcile]   KEEP  (id=${keep.id}): ${keep.description.substring(0, 80)}`);
        console.log(`[reconcile]   DELETE(id=${remove.id}): ${remove.description.substring(0, 80)}`);
      }
    }

    if (toDelete.size > 0) {
      const deleteStmt = db.prepare(`DELETE FROM transactions WHERE id = ?`);
      for (const id of toDelete) {
        deleteStmt.run(id);
      }
      totalCleaned += toDelete.size;
    }
  }

  return totalCleaned;
}

/**
 * One-time cleanup: Apply description normalization to existing Chase transactions
 * and remove duplicates that become identical after normalization.
 *
 * This runs during initDb() (idempotent — harmless on subsequent runs since
 * descriptions will already be normalized).
 */
function _normalizeExistingDescriptions(db) {
  if (!semantics) return;

  // Find institutions with descriptionNormalization rules
  for (const [institution, cfg] of Object.entries(semantics.institutions || {})) {
    if (!cfg.descriptionNormalization || cfg.descriptionNormalization.length === 0) continue;

    // Fetch raw JSON too — descriptions may have been mangled by a previous normalization
    // pass (e.g., old hardcoded regex captured IND ID content into the description body).
    // Re-normalizing from the original raw Description field produces the correct result.
    const mapping = cfg.columnMapping || null;
    const rows = db.prepare(
      `SELECT id, description, account_type, raw FROM transactions WHERE institution = ?`
    ).all(institution);

    if (rows.length === 0) continue;

    const updateDesc = db.prepare(`UPDATE transactions SET description = ?, updated_at = datetime('now') WHERE id = ?`);
    const deleteById = db.prepare(`DELETE FROM transactions WHERE id = ?`);
    let updated = 0;
    let collisionDeleted = 0;

    for (const row of rows) {
      // Start from the raw description when available — it preserves the original bank format
      // before any previous normalization attempts. Fall back to stored description.
      let sourceDesc = row.description;
      if (row.raw) {
        try {
          const rawData = JSON.parse(row.raw);
          const rawDesc = resolveField(mapping, 'description', rawData,
            'Description', 'Transaction Description', 'description',
            'Merchant', 'bankDescription', 'counterpartyName', 'note');
          if (rawDesc) sourceDesc = rawDesc;
        } catch {}
      }

      // Apply the regex rules from data-semantics.json
      let normalized = normalizeDescription(institution, sourceDesc, semantics);

      // Apply the same hardcoded normalizations that normalizeDayToDay uses
      if (institution === 'chase' && (row.account_type === 'checking')) {
        normalized = normalized.replace(/\s+/g, ' ').trim();
        normalized = normalized.toLowerCase();
        normalized = normalized.replace(/online transfer \d+ to/i, 'online transfer to');
        normalized = normalized.replace(/transaction\s*#?\s*:?\s*\d+\s*\d{0,2}\/?\d{0,2}/, 'transaction');
        normalized = normalized.replace(/[#x]{4,}\d{4}/gi, m => '****' + m.slice(-4));
      }

      if (normalized !== row.description) {
        try {
          updateDesc.run(normalized, row.id);
          updated++;
        } catch (e) {
          if (e.message.includes('UNIQUE constraint')) {
            // The normalized description already exists as another row in the same
            // (institution, account_id, date, amount) group — this row is the duplicate.
            // Delete it instead of updating.
            deleteById.run(row.id);
            collisionDeleted++;
          } else {
            throw e;
          }
        }
      }
    }

    if (updated > 0) {
      console.log(`[import] Normalized ${updated} ${institution} transaction descriptions`);
    }
    if (collisionDeleted > 0) {
      console.log(`[import] Removed ${collisionDeleted} ${institution} duplicates (normalized description collided with existing row)`);
    }
  }

  // Layer 4: Reconcile remaining duplicates with different descriptions but shared IDs
  const reconciled = reconcileDuplicates(db);
  if (reconciled > 0) {
    console.log(`[import] Reconciled ${reconciled} duplicate transaction(s) via shared transaction IDs`);
  }
}

// === Main ===

// Detect an institution's account list silently shrinking.
//
// Some providers simply omit accounts rather than reporting them at zero — Schwab drops
// zero-balance accounts. When that happens the account disappears from every subsequent
// sync and NOTHING else notices: balance counts still look healthy, sync_status still
// reads ok, and the missing account contributes 0 to net worth, so no total moves.
// `schwab-68651972` vanished after 2026-05-06 (6 accounts -> 5) and went unremarked for
// four months. That instance was harmless — it was always $0.00 with no holdings — but
// the mechanism is not: a funded account would disappear exactly as quietly.
function checkAccountSetShrink(db) {
  const warnings = [];
  const institutions = db.prepare(
    'SELECT DISTINCT institution FROM balances WHERE institution IS NOT NULL'
  ).all().map(r => r.institution);

  for (const inst of institutions) {
    const syncs = db.prepare(
      'SELECT DISTINCT synced_at FROM balances WHERE institution = ? ORDER BY synced_at DESC LIMIT 2'
    ).all(inst).map(r => r.synced_at);
    if (syncs.length < 2) continue;

    const setFor = (ts) => new Set(db.prepare(
      'SELECT DISTINCT account_id FROM balances WHERE institution = ? AND synced_at = ?'
    ).all(inst, ts).map(r => r.account_id));

    const latest = setFor(syncs[0]);
    const previous = setFor(syncs[1]);
    const dropped = [...previous].filter(a => !latest.has(a));

    if (dropped.length > 0) {
      warnings.push(
        `[import] \u26a0 ${inst}: account list SHRANK ${previous.size} -> ${latest.size} ` +
        `since the previous sync. Missing: ${dropped.join(', ')}. ` +
        `An omitted account is not a zero balance — confirm it was closed, not dropped.`
      );
    }
  }

  // Accounts seen historically but absent from their institution's latest sync for a while.
  const persistent = db.prepare(`
    SELECT b.institution, b.account_id, MAX(b.synced_at) AS last_seen
    FROM balances b
    GROUP BY b.institution, b.account_id
    HAVING last_seen < (
      SELECT MAX(b2.synced_at) FROM balances b2 WHERE b2.institution = b.institution
    )
  `).all();

  for (const row of persistent) {
    const days = (Date.now() - new Date(row.last_seen).getTime()) / 86400000;
    if (days >= 30) {
      warnings.push(
        `[import] \u26a0 ${row.institution}: ${row.account_id} has been absent for ` +
        `${days.toFixed(0)} days (last seen ${row.last_seen.slice(0, 10)}).`
      );
    }
  }

  return warnings;
}

function main() {
  if (process.argv.includes('--init')) {
    const db = initDb();
    console.log('[import] Database initialized at', DB_PATH);
    db.close();
    return;
  }

  const db = initDb();

  // Wrap all imports in a transaction for speed
  const importAll = db.transaction(() => {
    // <institution>.result.json files are per-run status sidecars, not institution output
    const files = fs.readdirSync(SYNC_OUTPUT_DIR)
      .filter(f => f.endsWith('.json') && !f.endsWith('.result.json'));
    const results = [];

    for (const file of files) {
      const institution = file.replace('.json', '');
      if (bankFilter && institution !== bankFilter) continue;

      // Slug immutability check
      const slugCheck = validateSlug(institution);
      if (!slugCheck.ok) {
        console.warn(`[import] Slug validation failed for "${institution}":`);
        slugCheck.errors.forEach(e => console.warn(`  ${e}`));
        console.log(`[import] Skipping ${institution} — slug mismatch`);
        results.push({ institution, balancesImported: 0, txnsImported: 0, txnsSkipped: 0, holdingsImported: 0 });
        continue;
      }

      const data = JSON.parse(fs.readFileSync(path.join(SYNC_OUTPUT_DIR, file), 'utf-8'));

      if (data.error && (!data.balances || data.balances.length === 0)) {
        console.log(`[import] Skipping ${institution} — error state: ${data.error}`);
        continue;
      }

      // Data semantics gate: block import for institutions with transactions but no semantics entry
      if ((data.transactions || []).length > 0 && !semantics?.institutions?.[institution]) {
        if (forceImport) {
          console.warn(`[import] WARNING: No data-semantics entry for "${institution}" — importing as-is (--force)`);
        } else {
          console.warn(`[import] BLOCKED: No data-semantics.json entry for "${institution}"`);
          console.warn(`[import]   Run: node scripts/discover-semantics.js ${institution}`);
          console.warn(`[import]   Then add the entry to config/data-semantics.json`);
          console.warn(`[import]   Or use --force to import without sign normalization`);
          console.log(`[import] Skipping ${institution} — data semantics required for transaction import`);
          results.push({ institution, balancesImported: 0, txnsImported: 0, txnsSkipped: 0, holdingsImported: 0 });
          continue;
        }
      }

      // Pre-import validation: check raw data matches expected conventions
      if (semantics && (data.transactions || []).length > 0) {
        const rawWarnings = validateRawData(data.transactions, institution, semantics);
        if (rawWarnings.length > 0) {
          rawWarnings.forEach(w => console.warn(w));
          console.log(`[import] Skipping ${institution} — raw data validation failed`);
          results.push({ institution, balancesImported: 0, txnsImported: 0, txnsSkipped: 0, holdingsImported: 0 });
          continue;
        }
      }

      const result = importInstitution(db, institution, data);
      results.push({ institution, ...result });
      console.log(`[import] ${institution}: ${result.balancesImported}B, ${result.txnsImported}T imported, ${result.txnsSkipped} skipped, ${result.holdingsImported}H`);
    }

    return results;
  });

  const results = importAll();

  // Layer 4: Post-import reconciliation — catch any duplicates the current import
  // may have created (e.g., new sync has condensed description, old row has verbose form).
  // This runs outside the import transaction so it can see all newly inserted rows.
  const reconciled = reconcileDuplicates(db);
  if (reconciled > 0) {
    console.log(`[import] Post-import: reconciled ${reconciled} duplicate(s) via shared transaction IDs`);
  }

  // Re-materialize tag rules against the freshly imported transactions (date-range/filter
  // tags re-apply automatically; manual tags persist by dedup key). Non-fatal on error.
  try {
    const { materializeRules } = require('./tags');
    const tagRes = materializeRules(db);
    if (tagRes.rules > 0) {
      console.log(`[import] Tags: ${tagRes.rules} rule(s) materialized → ${tagRes.tagged} tag association(s)`);
    }
  } catch (e) {
    console.warn(`[import] Tag materialization skipped: ${e.message}`);
  }

  // Summary
  const totalBal = results.reduce((s, r) => s + r.balancesImported, 0);
  const totalTxn = results.reduce((s, r) => s + r.txnsImported, 0);
  const totalSkipped = results.reduce((s, r) => s + r.txnsSkipped, 0);
  const totalHoldings = results.reduce((s, r) => s + r.holdingsImported, 0);

  console.log(`\n[import] Done. ${totalBal} balances, ${totalTxn} transactions (${totalSkipped} deduped), ${totalHoldings} holdings`);

  // Quick stats
  const balCount = db.prepare('SELECT COUNT(*) as c FROM balances').get().c;
  const txnCount = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  const invCount = db.prepare('SELECT COUNT(*) as c FROM investment_transactions').get().c;
  const holdCount = db.prepare('SELECT COUNT(*) as c FROM holdings').get().c;
  console.log(`[import] Database totals: ${balCount} balance records, ${txnCount} transactions, ${invCount} investment transactions, ${holdCount} holdings`);

  // Validate imported data against known anchors
  if (semantics) {
    const institutions = bankFilter ? [bankFilter] : Object.keys(semantics.institutions || {});
    const allWarnings = [];
    for (const inst of institutions) {
      allWarnings.push(...validateAnchors(db, inst, semantics));
    }
    if (allWarnings.length > 0) {
      console.log('\n[import] ⚠ Data semantics validation warnings:');
      allWarnings.forEach(w => console.warn(w));
    } else {
      console.log('[import] ✓ Data semantics validation passed');
    }
  }

  // Account-set integrity: has any institution's account list silently shrunk?
  const shrinkWarnings = checkAccountSetShrink(db);
  if (shrinkWarnings.length > 0) {
    console.log('\n[import] \u26a0 Account-set warnings:');
    shrinkWarnings.forEach(w => console.warn(w));
  }

  db.close();
}

main();
