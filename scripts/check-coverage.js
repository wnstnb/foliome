#!/usr/bin/env node
/**
 * Transaction coverage detector.
 *
 * Every other check in this repo asks whether the data is CURRENT. This one asks
 * whether it is COMPLETE — per account, is anything still arriving?
 *
 * Written 2026-09-05 after Capital One spent four months downloading transactions
 * for 1 of its 5 accounts while every sync reported `ok`. The gap was found by
 * the user remembering a utility bill, not by any check. This is that check.
 * See data/wiki/findings/capital-one-per-account-download-silent.md
 *
 * Method: an account is stale when its most recent transaction is older than its
 * own observed rhythm — the 90th-percentile gap between its transactions, floored
 * at 21 days so genuinely quiet accounts are not nagged. Each account is judged
 * against itself, so a monthly-mortgage account and a daily-spend card get
 * different thresholds without any hardcoded per-account config.
 *
 * Usage: node scripts/check-coverage.js [--json] [--all]
 *          --json  machine-readable output
 *          --all   list healthy accounts too
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB = path.join(__dirname, '..', 'data', 'foliome.db');
const FLOOR_DAYS = 21;      // never flag an account quieter than this
const PERCENTILE = 0.9;     // "normal" gap = 90th percentile of observed gaps
const MULTIPLIER = 1.5;     // stale once silence exceeds normal-gap x this

const asJson = process.argv.includes('--json');
const showAll = process.argv.includes('--all');

function days(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[i];
}

// Which table an account's activity lands in. Investment accounts post to
// `investment_transactions`; a real-estate holding has no transactions by design.
// Checking the wrong table is how a detector manufactures 12 false positives.
const INVESTMENT_TYPES = new Set(['brokerage', 'retirement', 'education']);
const NO_TXN_TYPES = new Set(['real_estate']);
const NO_TXN_INSTITUTIONS = new Set(['real-estate']);
const ZERO_EPS = 1.00;   // an account holding under a dollar and posting nothing is consistent, not broken
const FLAT_EPS = 1.00;   // ...and so is one whose balance has never moved

function loadAccountTypes() {
  const types = {};
  try {
    const cfg = JSON.parse(require('fs').readFileSync(
      path.join(__dirname, '..', 'config', 'accounts.json'), 'utf-8'));
    for (const inst of Object.values(cfg)) {
      for (const a of (inst.accounts || [])) types[a.accountId] = a.accountType;
    }
  } catch {}
  return types;
}

function main() {
  const db = new Database(DB, { readonly: true });
  const now = new Date().toISOString().slice(0, 10);
  const types = loadAccountTypes();

  // Roster comes from `balances`, not `transactions`: an account with zero
  // transactions is invisible to a transactions-only query, which is exactly the
  // failure this detects. Deduped by account_id — duplicate institution slugs
  // (us-bank/usbank, capital-one/capitalone) would otherwise list it twice.
  const accounts = db.prepare(`
    SELECT b.account_id, MAX(b.institution) AS institution, MAX(b.synced_at) AS last_sync,
           (SELECT balance FROM balances b2 WHERE b2.account_id = b.account_id
            ORDER BY b2.synced_at DESC LIMIT 1) AS balance,
           MAX(b.balance) - MIN(b.balance) AS balance_range,
           COUNT(*) AS balance_snapshots
    FROM balances b GROUP BY b.account_id
  `).all();

  const report = [];

  for (const a of accounts) {
    const type = types[a.account_id] || 'unknown';
    if (NO_TXN_TYPES.has(type) || NO_TXN_INSTITUTIONS.has(a.institution)) continue;

    const read = (t) => db.prepare(
      `SELECT date FROM ${t} WHERE account_id = $id ORDER BY date`
    ).all({ id: a.account_id }).map(r => String(r.date).slice(0, 10));

    // A known type picks its table. An unknown type is probed against both rather
    // than guessed — guessing the table is how an account gets reported empty when
    // its rows are simply somewhere else.
    let table, rows;
    if (type === 'unknown') {
      const t1 = read('transactions'), t2 = read('investment_transactions');
      [table, rows] = t2.length > t1.length ? ['investment_transactions', t2] : ['transactions', t1];
    } else {
      table = INVESTMENT_TYPES.has(type) ? 'investment_transactions' : 'transactions';
      rows = read(table);
    }

    const lastSync = String(a.last_sync).slice(0, 10);

    if (rows.length === 0) {
      // Two ways an empty ledger is CORRECT rather than broken:
      //  - the account holds nothing, or
      //  - its balance has never moved across every snapshot we hold.
      // The second is the load-bearing one. The user, 2026-09-05, on a mortgage-linked checking account:
      // "they required us to open a checking account when we got the mortgage but we
      // don't use it, hence why it's been at $100 balance the whole time." An unused
      // account SHOULD have no transactions — flagging it is a false positive, and the
      // signal that says so is already in the data. A ledger is only missing when
      // something moved that it fails to explain.
      const zero = Math.abs(Number(a.balance) || 0) < ZERO_EPS;
      const flat = a.balance_snapshots > 1 && Math.abs(Number(a.balance_range) || 0) < FLAT_EPS;
      const empty = zero || flat;
      report.push({
        account_id: a.account_id, institution: a.institution, type, table,
        balance: a.balance,
        txn_count: 0, first: null, last: null,
        silent_days: null, normal_gap: null,
        balance_range: a.balance_range,
        state: empty ? 'EMPTY' : 'NO_TRANSACTIONS',
        note: zero
          ? `holds ${Number(a.balance || 0).toFixed(2)} and posts nothing — consistent`
          : flat
            ? `balance has never moved from ${Number(a.balance || 0).toFixed(2)} across ${a.balance_snapshots} snapshots — an unused account, consistent`
            : `balance moves (range ${Number(a.balance_range || 0).toFixed(2)}) but has never produced a row in ${table} to explain it`,
      });
      continue;
    }

    const first = rows[0], last = rows[rows.length - 1];
    const gaps = [];
    for (let i = 1; i < rows.length; i++) {
      const g = days(rows[i - 1], rows[i]);
      if (g > 0) gaps.push(g);
    }
    gaps.sort((x, y) => x - y);

    const normalGap = Math.max(percentile(gaps, PERCENTILE), 1);
    const silent = days(last, now);
    const threshold = Math.max(Math.ceil(normalGap * MULTIPLIER), FLOOR_DAYS);

    // A gap only counts against the reader if the account was actually synced more
    // recently than its last transaction — otherwise the account is simply stale
    // overall and that is a different (already-detected) problem.
    const syncedSince = days(last, lastSync);

    let state = 'OK';
    if (silent > threshold) state = syncedSince > threshold ? 'STALE' : 'QUIET';

    report.push({
      account_id: a.account_id, institution: a.institution, type, table,
      txn_count: rows.length, first, last,
      silent_days: silent, normal_gap: normalGap, threshold,
      synced_days_past_last_txn: syncedSince,
      state,
    });
  }

  const rank = { NO_TRANSACTIONS: 0, STALE: 1, QUIET: 2, EMPTY: 3, OK: 4 };
  report.sort((x, y) => rank[x.state] - rank[y.state] || (y.silent_days || 1e9) - (x.silent_days || 1e9));

  const problems = report.filter(r => r.state === 'NO_TRANSACTIONS' || r.state === 'STALE');

  if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), problems: problems.length, accounts: report }, null, 2));
    process.exit(problems.length ? 1 : 0);
  }

  console.log('\nTransaction coverage — is anything still arriving per account?\n');
  const hdr = 'account'.padEnd(30) + 'txns'.padStart(6) + '  last txn   ' + 'silent'.padStart(7) + 'normal'.padStart(8) + '  state';
  console.log(hdr);
  console.log('-'.repeat(hdr.length));

  for (const r of report) {
    if (!showAll && (r.state === 'OK' || r.state === 'EMPTY')) continue;
    const mark = (r.state === 'OK' || r.state === 'EMPTY') ? ' ' : r.state === 'QUIET' ? '·' : '!';
    console.log(
      mark + r.account_id.padEnd(29) +
      String(r.txn_count).padStart(6) + '  ' +
      String(r.last || '—').padEnd(12) +
      String(r.silent_days === null ? '—' : r.silent_days + 'd').padStart(7) +
      String(r.normal_gap === null ? '—' : r.normal_gap + 'd').padStart(8) +
      '  ' + r.state
    );
  }

  console.log();
  if (problems.length === 0) {
    const empties = report.filter(r => r.state === 'EMPTY').length;
    console.log(`✓ All ${report.length - empties} funded accounts are producing transactions on their own rhythm.` +
      (empties ? ` (${empties} zero-balance accounts post nothing, which is consistent.)` : ''));
  } else {
    console.log(`🔴 ${problems.length} of ${report.length} accounts are not producing transactions:\n`);
    for (const p of problems) {
      if (p.state === 'NO_TRANSACTIONS') {
        console.log(`  ${p.account_id} (${p.type}) — ${p.note}`);
      } else {
        console.log(`  ${p.account_id} — last transaction ${p.last} (${p.silent_days}d ago); its normal gap is ${p.normal_gap}d, and it has synced ${p.synced_days_past_last_txn}d since.`);
      }
    }
    console.log('\nA balance that syncs while transactions do not is a reader coverage gap, not a quiet account.');
  }
  console.log();
  process.exit(problems.length ? 1 : 0);
}

main();
