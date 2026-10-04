// Transaction tagging — multi-valued, user-curated labels orthogonal to categories.
// Design: docs/design/transaction-tagging.md
//
// Tags live in SQLite (not JSON config): they are row data about transactions, and
// the transactions already live in the DB. Two tables:
//   - transaction_tags(txn_key, tag, source)  — the tag↔transaction links
//   - tag_rules(id, tag, match)               — declarative date-range/filter rules
// Rules are materialized into transaction_tags as a post-import step, so every tag
// read is a plain indexed JOIN. Manual tags insert directly.
//
// txn_key is the import dedup key, so tags survive the 2×/day re-import. It is
// computed identically in SQL (a generated column) and in JS (txnKey below) — both
// canonicalize amount to 2 decimals so the strings always match.

/**
 * Stable per-transaction key, mirroring import.js's two dedup strategies:
 *   - bank-ID sources:  institution|bid:<bank_transaction_id>
 *   - natural key:      institution|account_id|date|amount(2dp)|description
 * Accepts either camelCase (sync output) or snake_case (DB row) fields.
 */
function txnKey(t) {
  const inst = t.institution;
  const bid = t.bank_transaction_id ?? t.bankTransactionId ?? null;
  if (bid) return `${inst}|bid:${bid}`;
  const acct = t.account_id ?? t.accountId;
  const amt = Number(t.amount).toFixed(2);
  return `${inst}|${acct}|${t.date}|${amt}|${t.description}`;
}

// SQL expression that produces the identical key as a generated column.
const DEDUP_KEY_SQL =
  "institution || '|' || CASE WHEN bank_transaction_id IS NOT NULL " +
  "THEN 'bid:' || bank_transaction_id " +
  "ELSE account_id || '|' || date || '|' || printf('%.2f', amount) || '|' || description END";

/** Create tag tables + the dedup_key generated column. Idempotent. */
function ensureTagSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_tags (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      txn_key    TEXT NOT NULL,
      tag        TEXT NOT NULL,
      source     TEXT NOT NULL,              -- 'manual' | 'rule:<rule_id>'
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(txn_key, tag, source)
    );
    CREATE INDEX IF NOT EXISTS idx_txn_tags_key ON transaction_tags(txn_key);
    CREATE INDEX IF NOT EXISTS idx_txn_tags_tag ON transaction_tags(tag);

    CREATE TABLE IF NOT EXISTS tag_rules (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      tag        TEXT NOT NULL,
      match      TEXT NOT NULL,              -- JSON: {dateFrom,dateTo,accounts?,categories?,categoriesExclude?,descriptionContains?}
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Virtual generated column so tag JOINs are pure SQL with no parity risk vs txnKey().
  // VIRTUAL (not STORED) because ALTER TABLE can only add virtual generated columns.
  try {
    db.exec(`ALTER TABLE transactions ADD COLUMN dedup_key TEXT GENERATED ALWAYS AS (${DEDUP_KEY_SQL}) VIRTUAL`);
  } catch { /* already exists */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_dedup_key ON transactions(dedup_key)`);
  } catch { /* index needs the column; ignore if add failed */ }
}

/** Build the WHERE clause + params for a rule's match criteria. */
function ruleWhere(match) {
  const clauses = [];
  const params = [];
  if (match.dateFrom) { clauses.push('date >= ?'); params.push(match.dateFrom); }
  if (match.dateTo)   { clauses.push('date <= ?'); params.push(match.dateTo); }
  if (Array.isArray(match.accounts) && match.accounts.length) {
    clauses.push(`account_id IN (${match.accounts.map(() => '?').join(',')})`);
    params.push(...match.accounts);
  }
  if (Array.isArray(match.categories) && match.categories.length) {
    clauses.push(`user_category IN (${match.categories.map(() => '?').join(',')})`);
    params.push(...match.categories);
  }
  if (Array.isArray(match.categoriesExclude) && match.categoriesExclude.length) {
    // exclude these resolved categories (e.g. a trip tag dropping recurring bills/transfers)
    clauses.push(`(user_category IS NULL OR user_category NOT IN (${match.categoriesExclude.map(() => '?').join(',')}))`);
    params.push(...match.categoriesExclude);
  }
  if (Array.isArray(match.descriptionContains) && match.descriptionContains.length) {
    clauses.push('(' + match.descriptionContains.map(() => 'description LIKE ?').join(' OR ') + ')');
    params.push(...match.descriptionContains.map((s) => `%${s}%`));
  }
  return { where: clauses.length ? clauses.join(' AND ') : '1=1', params };
}

/** (Re)materialize one rule's matched rows into transaction_tags. */
function materializeRule(db, rule) {
  const match = typeof rule.match === 'string' ? JSON.parse(rule.match) : rule.match;
  const source = `rule:${rule.id}`;
  db.prepare('DELETE FROM transaction_tags WHERE source = ?').run(source);
  const { where, params } = ruleWhere(match);
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO transaction_tags (txn_key, tag, source, created_at)
    SELECT dedup_key, ?, ?, datetime('now') FROM transactions WHERE ${where}
  `).run(rule.tag, source, ...params);
  return inserted.changes;
}

/** Re-materialize all rules. Call as a post-import step. */
function materializeRules(db) {
  ensureTagSchema(db);
  const rules = db.prepare('SELECT id, tag, match FROM tag_rules').all();
  let total = 0;
  for (const rule of rules) total += materializeRule(db, rule);
  return { rules: rules.length, tagged: total };
}

/** Create a date-range/filter rule and materialize it immediately. */
function addRule(db, tag, match) {
  ensureTagSchema(db);
  const info = db.prepare('INSERT INTO tag_rules (tag, match, created_at) VALUES (?, ?, datetime(\'now\'))')
    .run(tag, JSON.stringify(match));
  const rule = { id: info.lastInsertRowid, tag, match };
  const tagged = materializeRule(db, rule);
  return { ruleId: rule.id, tagged };
}

/** Tag a single transaction manually (by its txn_key). */
function addManualTag(db, key, tag) {
  ensureTagSchema(db);
  return db.prepare(`INSERT OR IGNORE INTO transaction_tags (txn_key, tag, source, created_at)
    VALUES (?, ?, 'manual', datetime('now'))`).run(key, tag).changes;
}

/** Remove a tag from a transaction (manual rows only by default). */
function removeManualTag(db, key, tag) {
  return db.prepare("DELETE FROM transaction_tags WHERE txn_key = ? AND tag = ? AND source = 'manual'")
    .run(key, tag).changes;
}

/** Map of txn_key -> [tags] for a set of keys (for attaching to query results). */
function tagsForKeys(db, keys) {
  if (!keys.length) return new Map();
  const rows = db.prepare(
    `SELECT DISTINCT txn_key, tag FROM transaction_tags WHERE txn_key IN (${keys.map(() => '?').join(',')})`
  ).all(...keys);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.txn_key)) m.set(r.txn_key, []);
    m.get(r.txn_key).push(r.tag);
  }
  return m;
}

/** Spend + count + date span per tag — the cross-category rollup. */
function tagSummary(db) {
  ensureTagSchema(db);
  return db.prepare(`
    SELECT tt.tag,
           COUNT(DISTINCT t.id)                       AS count,
           ROUND(SUM(CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END), 2) AS totalSpend,
           MIN(t.date)                                AS dateFrom,
           MAX(t.date)                                AS dateTo
    FROM transaction_tags tt
    JOIN transactions t ON t.dedup_key = tt.txn_key
    GROUP BY tt.tag
    ORDER BY totalSpend DESC
  `).all();
}

/** List distinct tags. */
function allTags(db) {
  ensureTagSchema(db);
  return db.prepare('SELECT DISTINCT tag FROM transaction_tags ORDER BY tag').all().map((r) => r.tag);
}

module.exports = {
  txnKey, DEDUP_KEY_SQL, ensureTagSchema,
  addRule, materializeRule, materializeRules,
  addManualTag, removeManualTag,
  tagsForKeys, tagSummary, allTags,
};
