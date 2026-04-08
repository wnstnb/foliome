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
const crypto = require('crypto');
const Database = require('better-sqlite3');

const { validateSlug } = require('../scripts/validate-slugs');

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
      dedup_key TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Investment transactions: trades, dividends, contributions
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
      dedup_key TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
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
  const description = resolveField(mapping, 'description', r,
    'Description', 'Transaction Description', 'description',
    'Merchant', 'bankDescription', 'counterpartyName', 'note');
  if (!description) return null;

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

  // Dedup key — prefer raw transaction ID (stable across pending→posted date shifts),
  // fall back to date+amount+desc hash for CSV sources without IDs
  const rawId = r.id || r.transactionId || r.transaction_id || r.referenceNumber || null;
  let dedupKey;
  if (rawId) {
    dedupKey = `${institution}|${accountId}|${rawId}`;
  } else {
    const dedupDate = transactionDate || date;
    const descHash = crypto.createHash('md5').update(description.substring(0, 50)).digest('hex').substring(0, 8);
    dedupKey = `${institution}|${accountId}|${dedupDate}|${amount}|${descHash}`;
  }

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
      status: postingDate ? 'posted' : 'pending',
      raw: JSON.stringify(raw),
      dedup_key: dedupKey,
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

  const rawId = r.id || r.transactionId || r.transaction_id || r.activityId || r.referenceNumber || null;
  let dedupKey;
  if (rawId) {
    dedupKey = `${institution}|${accountId}|${rawId}`;
  } else {
    const descHash = crypto.createHash('md5').update(description.substring(0, 50)).digest('hex').substring(0, 8);
    dedupKey = `${institution}|${accountId}|${date}|${amount}|${descHash}`;
  }

  return {
    table: 'investment_transactions',
    row: {
      institution,
      account_id: accountId,
      date,
      description: description.trim(),
      type,
      symbol,
      quantity,
      price,
      amount,
      fees: 0,
      raw: JSON.stringify(raw),
      dedup_key: dedupKey,
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

  // Import transactions
  const insertTxn = db.prepare(`
    INSERT INTO transactions (institution, account_id, account_type, transaction_date, posting_date, date, description, amount, currency, type, category, balance_after, status, raw, dedup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedup_key) DO UPDATE SET
      posting_date = COALESCE(excluded.posting_date, posting_date),
      date = COALESCE(excluded.posting_date, excluded.date, date),
      status = CASE WHEN excluded.posting_date IS NOT NULL THEN 'posted' ELSE status END,
      balance_after = COALESCE(excluded.balance_after, balance_after),
      updated_at = datetime('now')
  `);

  const insertInvTxn = db.prepare(`
    INSERT INTO investment_transactions (institution, account_id, date, description, type, symbol, quantity, price, amount, fees, raw, dedup_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(dedup_key) DO UPDATE SET
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
        insertTxn.run(r.institution, r.account_id, r.account_type, r.transaction_date, r.posting_date,
          r.date, r.description, r.amount, r.currency, r.type, r.category, r.balance_after, r.status, r.raw, r.dedup_key);
      } else {
        const r = normalized.row;
        insertInvTxn.run(r.institution, r.account_id, r.date, r.description,
          r.type, r.symbol, r.quantity, r.price, r.amount, r.fees, r.raw, r.dedup_key);
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

  // Import holdings (from balance data that includes positions)
  const insertHolding = db.prepare(`
    INSERT OR REPLACE INTO holdings (institution, account_id, symbol, name, quantity, price, market_value, cost_basis, currency, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const bal of (data.balances || [])) {
    const positions = bal.positions || [];
    for (const pos of positions) {
      if (pos.symbol) {
        insertHolding.run(
          institution,
          bal.accountId || bal.account_id,
          pos.symbol,
          pos.name || null,
          pos.quantity || 0,
          pos.price || 0,
          pos.marketValue || pos.market_value || 0,
          pos.costBasis || pos.cost_basis || null,
          'USD',
          syncedAt
        );
        holdingsImported++;
      }
    }
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

// === Main ===

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
    const files = fs.readdirSync(SYNC_OUTPUT_DIR).filter(f => f.endsWith('.json'));
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

  db.close();
}

main();
