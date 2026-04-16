#!/usr/bin/env node
/**
 * One-time migration: drop synthetic dedup_key, switch to natural-key UNIQUE.
 *
 * Why: the synthetic dedup_key (institution|account|date|amount|hash(description))
 * was stored with a UNIQUE constraint. Any change to the formula invalidates every
 * historical row — exactly what happened on 2026-04-15 when a normalization tweak
 * caused the next sync to re-insert ~1800 duplicates. Replacing it with a natural-key
 * UNIQUE on (institution, account_id, date, amount, description) removes the
 * derived-state-as-schema fragility entirely.
 *
 * Steps:
 *  1. Collapse duplicate rows in transactions (keep newest by id).
 *  2. Same for investment_transactions (natural key includes symbol; NULL symbols
 *     are coerced to '' first since SQLite UNIQUE treats NULLs as distinct).
 *  3. Fix fake-pending rows: institutions with no posting_date column were getting
 *     status='pending' for every row. Promote to 'posted'.
 *  4. Recreate both tables without dedup_key column and with new UNIQUE constraint.
 *  5. VACUUM to reclaim space.
 *
 * Logs every collapse decision to data/migrations/<timestamp>-dedup-collapse.log.
 *
 * Idempotent: if dedup_key column is already gone, exits cleanly.
 *
 * Usage: node scripts/migrate-dedup-natural-key.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'foliome.db');
const LOG_DIR = path.join(__dirname, '..', 'data', 'migrations');

function tableHasColumn(db, table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some(c => c.name === col);
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`[migrate] Database not found at ${DB_PATH}`);
    process.exit(1);
  }

  fs.mkdirSync(LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = path.join(LOG_DIR, `${ts}-dedup-collapse.log`);
  const log = (msg) => fs.appendFileSync(logPath, msg + '\n');
  log(`# Dedup natural-key migration — started ${new Date().toISOString()}`);

  const db = new Database(DB_PATH);
  db.pragma('foreign_keys = OFF');

  if (!tableHasColumn(db, 'transactions', 'dedup_key')) {
    console.log('[migrate] dedup_key column already removed — nothing to do.');
    log('No-op: schema already migrated.');
    db.close();
    return;
  }

  console.log('[migrate] Starting transaction…');
  db.exec('BEGIN');

  try {
    // ---- Phase 1: collapse duplicates in `transactions` ----
    console.log('[migrate] Phase 1: collapsing duplicates in transactions…');
    const txnRows = db.prepare(`
      SELECT id, institution, account_id, date, amount, description
      FROM transactions
    `).all();

    const txnGroups = new Map();
    for (const r of txnRows) {
      const key = [r.institution, r.account_id, r.date, r.amount, r.description].join('||');
      if (!txnGroups.has(key)) txnGroups.set(key, []);
      txnGroups.get(key).push(r.id);
    }

    let txnDeleted = 0;
    const txnDeleteStmt = db.prepare('DELETE FROM transactions WHERE id = ?');
    const byInstitution = {};
    for (const [key, ids] of txnGroups) {
      if (ids.length > 1) {
        ids.sort((a, b) => a - b);
        const keepId = ids[ids.length - 1];      // newest (highest id) wins
        const deleteIds = ids.slice(0, -1);       // delete the rest
        for (const delId of deleteIds) {
          txnDeleteStmt.run(delId);
          txnDeleted++;
        }
        const inst = key.split('||')[0];
        byInstitution[inst] = (byInstitution[inst] || 0) + deleteIds.length;
        log(`txn collapse | key=${key} | kept=${keepId} | deleted=${deleteIds.join(',')}`);
      }
    }
    console.log(`[migrate]   Collapsed ${txnDeleted} duplicate transaction rows`);
    console.log(`[migrate]   By institution: ${JSON.stringify(byInstitution)}`);

    // ---- Phase 2: collapse duplicates in `investment_transactions` ----
    // First coerce NULL symbols to '' — SQLite UNIQUE treats NULLs as distinct,
    // which would silently let dividend/cash entries (no symbol) bypass dedup.
    console.log('[migrate] Phase 2: collapsing duplicates in investment_transactions…');
    const nullSymCount = db.prepare(`SELECT count(*) as c FROM investment_transactions WHERE symbol IS NULL`).get().c;
    if (nullSymCount > 0) {
      db.prepare(`UPDATE investment_transactions SET symbol = '' WHERE symbol IS NULL`).run();
      console.log(`[migrate]   Coerced ${nullSymCount} NULL symbols to ''`);
      log(`Coerced ${nullSymCount} NULL symbols to '' before dedup`);
    }

    const invRows = db.prepare(`
      SELECT id, institution, account_id, date, amount, description, symbol
      FROM investment_transactions
    `).all();

    const invGroups = new Map();
    for (const r of invRows) {
      const key = [r.institution, r.account_id, r.date, r.amount, r.description, r.symbol || ''].join('||');
      if (!invGroups.has(key)) invGroups.set(key, []);
      invGroups.get(key).push(r.id);
    }

    let invDeleted = 0;
    const invDeleteStmt = db.prepare('DELETE FROM investment_transactions WHERE id = ?');
    for (const [key, ids] of invGroups) {
      if (ids.length > 1) {
        ids.sort((a, b) => a - b);
        const keepId = ids[ids.length - 1];
        const deleteIds = ids.slice(0, -1);
        for (const delId of deleteIds) {
          invDeleteStmt.run(delId);
          invDeleted++;
        }
        log(`inv collapse | key=${key} | kept=${keepId} | deleted=${deleteIds.join(',')}`);
      }
    }
    console.log(`[migrate]   Collapsed ${invDeleted} duplicate investment_transaction rows`);

    // ---- Phase 3: fix fake-pending rows ----
    // Before this migration, status was set as `postingDate ? 'posted' : 'pending'`.
    // Institutions with no posting_date column (e.g. Capital One savings) had every row
    // labeled pending even after the transaction fully settled. Promote those to posted.
    //
    // But preserve real pending rows from institutions that emit an actual status field
    // (e.g. Mercury's `status: 'pending'`/`'sent'`). Detect by scanning the raw JSON for
    // a status-like value — if nothing in raw says pending, it's fake-pending.
    console.log('[migrate] Phase 3: fixing fake-pending status…');
    const candidates = db.prepare(`
      SELECT id, raw FROM transactions
      WHERE status = 'pending' AND posting_date IS NULL
    `).all();

    const promoteStmt = db.prepare(`UPDATE transactions SET status = 'posted' WHERE id = ?`);
    const pendPattern = /^(pend(ing)?|sent|processing|settling|queued|authoriz)/i;
    let promoted = 0, kept = 0;
    for (const row of candidates) {
      let rawObj = null;
      try { rawObj = JSON.parse(row.raw || '{}'); } catch { rawObj = {}; }
      const hasRealPendingSignal = Object.values(rawObj).some(v =>
        typeof v === 'string' && pendPattern.test(v));
      if (hasRealPendingSignal) {
        kept++;
      } else {
        promoteStmt.run(row.id);
        promoted++;
      }
    }
    console.log(`[migrate]   Promoted ${promoted} fake-pending rows to posted (kept ${kept} real-pending)`);
    log(`Promoted ${promoted} rows pending→posted; preserved ${kept} rows with real pending signal in raw`);

    // ---- Phase 4: recreate transactions table with new schema ----
    console.log('[migrate] Phase 4: recreating transactions table…');
    db.exec(`
      CREATE TABLE transactions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        institution TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account_type TEXT,
        transaction_date TEXT,
        posting_date TEXT,
        date TEXT NOT NULL,
        description TEXT NOT NULL,
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        type TEXT,
        category TEXT,
        user_category TEXT,
        category_source TEXT,
        category_confidence REAL,
        balance_after REAL,
        status TEXT DEFAULT 'posted',
        raw TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(institution, account_id, date, amount, description)
      );
    `);
    db.exec(`
      INSERT INTO transactions_new (
        id, institution, account_id, account_type, transaction_date, posting_date,
        date, description, amount, currency, type, category, user_category,
        category_source, category_confidence, balance_after, status, raw,
        created_at, updated_at
      )
      SELECT
        id, institution, account_id, account_type, transaction_date, posting_date,
        date, description, amount, currency, type, category, user_category,
        category_source, category_confidence, balance_after, status, raw,
        created_at, updated_at
      FROM transactions;
    `);
    db.exec('DROP TABLE transactions');
    db.exec('ALTER TABLE transactions_new RENAME TO transactions');
    db.exec('CREATE INDEX idx_transactions_account_date ON transactions(account_id, date)');
    db.exec('CREATE INDEX idx_transactions_date ON transactions(date)');

    // ---- Phase 5: recreate investment_transactions table ----
    console.log('[migrate] Phase 5: recreating investment_transactions table…');
    db.exec(`
      CREATE TABLE investment_transactions_new (
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
    `);
    db.exec(`
      INSERT INTO investment_transactions_new (
        id, institution, account_id, date, description, type, symbol, quantity,
        price, amount, fees, raw, created_at, updated_at
      )
      SELECT
        id, institution, account_id, date, description, type, symbol, quantity,
        price, amount, fees, raw, created_at, updated_at
      FROM investment_transactions;
    `);
    db.exec('DROP TABLE investment_transactions');
    db.exec('ALTER TABLE investment_transactions_new RENAME TO investment_transactions');
    db.exec('CREATE INDEX idx_investment_transactions_account ON investment_transactions(account_id, date)');

    db.exec('COMMIT');
    console.log('[migrate] Committed.');
  } catch (e) {
    console.error('[migrate] Failed, rolling back:', e.message);
    db.exec('ROLLBACK');
    throw e;
  }

  // VACUUM (must run outside transaction)
  console.log('[migrate] Vacuuming…');
  db.exec('VACUUM');

  // Final stats
  const txnCount = db.prepare('SELECT count(*) as c FROM transactions').get().c;
  const invCount = db.prepare('SELECT count(*) as c FROM investment_transactions').get().c;
  const pendCount = db.prepare("SELECT count(*) as c FROM transactions WHERE status='pending'").get().c;
  console.log(`[migrate] Done. transactions=${txnCount}, investment_transactions=${invCount}, pending=${pendCount}`);
  console.log(`[migrate] Log: ${logPath}`);
  log(`# Migration complete: transactions=${txnCount}, investment_transactions=${invCount}, pending=${pendCount}`);

  db.close();
}

if (require.main === module) main();
