#!/usr/bin/env node
// Household picture — one builder for the whole-household view.
//
// The morning brief's "Household Picture" section renders from this object, and the
// retirement runway will read the same totals and flows, so every consumer sees the
// same numbers. Reads foliome.db (read-only) plus config/payment-schedule.json and
// config/obligations.json.
//
// Usage:
//   node scripts/household-picture.js            # full picture as JSON
//   node scripts/household-picture.js --section  # brief section only

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DB = path.join(ROOT, 'data', 'foliome.db');
const TZ = 'America/Los_Angeles';
const COMMIT_WINDOW_DAYS = 14;
const STALE_HOURS = 48;
// Real estate refreshes monthly by design, so it is never "stale" on the daily clock.
const STALE_EXEMPT = new Set(['real-estate']);

const CLASS_BY_TYPE = {
  checking: 'cash',
  savings: 'cash',
  brokerage: 'investable',
  retirement: 'retirement',
  education: 'education',
  real_estate: 'real_estate',
  credit: 'credit',
  mortgage: 'mortgage',
};
const CLASSES = ['cash', 'investable', 'retirement', 'education', 'real_estate', 'credit', 'mortgage'];

const round2 = (n) => Math.round(n * 100) / 100;

// YYYY-MM-DD for a Date in the household's timezone
function localDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

// UTC instant of local midnight for a YYYY-MM-DD, as an ISO string comparable to synced_at
function localMidnightIso(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 12));
  const offsetMin = (new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' })) -
    new Date(guess.toLocaleString('en-US', { timeZone: TZ }))) / 60000;
  return new Date(Date.UTC(y, m - 1, d) + offsetMin * 60000).toISOString();
}

function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

function readJson(rel, fallback) {
  const p = path.join(ROOT, rel);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Latest balance per account, optionally only snapshots taken before `beforeIso`
function latestBalances(db, beforeIso) {
  const cond = beforeIso ? 'WHERE synced_at < $before' : '';
  return db.prepare(`
    SELECT b.institution, b.account_id, b.account_name, b.account_type, b.balance, b.synced_at
    FROM balances b
    INNER JOIN (SELECT account_id, MAX(synced_at) AS ms FROM balances ${cond} GROUP BY account_id) m
    ON b.account_id = m.account_id AND b.synced_at = m.ms
  `).all(beforeIso ? { before: beforeIso } : {});
}

function summarize(rows) {
  const byClass = Object.fromEntries(CLASSES.map(c => [c, 0]));
  for (const r of rows) {
    const cls = CLASS_BY_TYPE[r.account_type];
    if (cls) byClass[cls] += r.balance;
    else console.warn(`[household-picture] unmapped account_type "${r.account_type}" (${r.account_id}) left out of totals`);
  }
  for (const c of CLASSES) byClass[c] = round2(byClass[c]);
  const netWorth = round2(CLASSES.reduce((s, c) => s + byClass[c], 0));
  return {
    byClass,
    netWorth,
    // Spendable-or-sellable money minus revolving debt
    liquidNetWorth: round2(byClass.cash + byClass.investable + byClass.credit),
    // Home equity out: both the estimate and the mortgage against it
    netWorthExRealEstate: round2(netWorth - byClass.real_estate - byClass.mortgage),
  };
}

// Effective category matches getSpending(): user override, then bank/model category
function flows(db, from, to) {
  const r = db.prepare(`
    SELECT
      SUM(CASE WHEN amount > 0 AND COALESCE(user_category, category, '') = 'Income' THEN amount ELSE 0 END) AS income,
      SUM(CASE WHEN amount < 0 AND COALESCE(user_category, category, '') NOT IN ('Transfer', 'Income') THEN amount ELSE 0 END) AS spending,
      SUM(CASE WHEN COALESCE(user_category, category, '') = 'Transfer' THEN ABS(amount) ELSE 0 END) AS transfers
    FROM transactions
    WHERE date >= $from AND date <= $to
  `).get({ from, to });
  const income = round2(r.income || 0);
  const spending = round2(-(r.spending || 0));
  return { income, spending, transfersExcluded: round2(r.transfers || 0), net: round2(income - spending) };
}

// Next occurrence on/after `today` for a card or obligation
function nextDue(entry, today) {
  if (entry.cadence === 'every_n_days') {
    const gap = daysBetween(entry.anchorDate, today);
    const k = Math.max(0, Math.ceil(gap / entry.intervalDays));
    return addDays(entry.anchorDate, k * entry.intervalDays);
  }
  if (entry.nextDueDate && entry.nextDueDate >= today) return entry.nextDueDate;
  const day = entry.dayOfMonth ?? entry.dueDay;
  if (!day) return null;
  const [y, m] = today.split('-').map(Number);
  for (let i = 0; i < 2; i++) {
    const mm = m + i;
    const yy = y + Math.floor((mm - 1) / 12);
    const month = ((mm - 1) % 12) + 1;
    const last = new Date(Date.UTC(yy, month, 0)).getUTCDate();
    const cand = `${yy}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
    if (cand >= today) return cand;
  }
  return null;
}

function committedCash(today, latestById) {
  const horizon = addDays(today, COMMIT_WINDOW_DAYS);
  const items = [];

  for (const o of readJson('config/obligations.json', { obligations: [] }).obligations || []) {
    // every_n_days can land more than once inside the window
    let due = nextDue(o, today);
    while (due && due <= horizon) {
      items.push({ name: o.name, class: o.class, amount: round2(o.amount), dueDate: due, estimate: false });
      if (o.cadence !== 'every_n_days') break;
      due = addDays(due, o.intervalDays);
    }
  }

  for (const c of readJson('config/payment-schedule.json', { cards: [] }).cards || []) {
    const due = nextDue(c, today);
    if (!due || due > horizon) continue;
    const known = c.lastStatementBalance != null && c.nextDueDate === due;
    const current = latestById[c.accountId]?.balance;
    const amount = known ? Math.abs(c.lastStatementBalance) : Math.abs(current ?? c.currentBalance ?? 0);
    if (!amount) continue;
    items.push({ name: c.cardName || c.accountId, class: 'credit', amount: round2(amount), dueDate: due, estimate: !known });
  }

  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  return { windowDays: COMMIT_WINDOW_DAYS, items, total: round2(items.reduce((s, i) => s + i.amount, 0)) };
}

function staleSources(db, now) {
  return db.prepare('SELECT institution, last_success FROM sync_status').all()
    .filter(r => !STALE_EXEMPT.has(r.institution))
    .map(r => ({ institution: r.institution, lastSuccess: r.last_success,
      ageHours: r.last_success ? (now - new Date(r.last_success)) / 3600000 : Infinity }))
    .filter(r => r.ageHours > STALE_HOURS)
    .map(r => ({ institution: r.institution, lastSuccess: r.lastSuccess, ageDays: Math.floor(r.ageHours / 24) }));
}

function buildHouseholdPicture(dbPath) {
  const db = new Database(dbPath || DEFAULT_DB, { readonly: true });
  const now = new Date();
  const today = localDate(now);

  const current = latestBalances(db);
  const yesterday = latestBalances(db, localMidnightIso(today));
  const cur = summarize(current);
  const prev = summarize(yesterday);

  const monthStart = `${today.slice(0, 8)}01`;
  const dayOfMonth = Number(today.slice(8));
  const mtd = flows(db, monthStart, today);
  // Trailing 90 full days before today, scaled to a 30-day month
  const t90 = flows(db, addDays(today, -90), addDays(today, -1));
  const perMonth = (v) => round2(v / 3);
  const typicalMonth = { income: perMonth(t90.income), spending: perMonth(t90.spending), net: perMonth(t90.net) };
  const spendingPaceToDate = round2(t90.spending / 90 * dayOfMonth);

  const latestById = Object.fromEntries(current.map(b => [b.account_id, b]));
  const committed = committedCash(today, latestById);

  const picture = {
    generatedAt: now.toISOString(),
    asOfDate: today,
    totals: {
      ...cur,
      change: {
        since: 'yesterday',
        netWorth: round2(cur.netWorth - prev.netWorth),
        liquidNetWorth: round2(cur.liquidNetWorth - prev.liquidNetWorth),
        netWorthExRealEstate: round2(cur.netWorthExRealEstate - prev.netWorthExRealEstate),
      },
    },
    flows: {
      monthToDate: { from: monthStart, to: today, ...mtd },
      typicalMonth: { basis: 'trailing 90 days / 3', ...typicalMonth },
      spendingPaceToDate,
    },
    committed,
    freeCash: round2(cur.byClass.cash - committed.total),
    stale: staleSources(db, now),
  };
  db.close();
  return picture;
}

const fmt = (n) => `$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
const signed = (n) => `${n >= 0 ? '+' : '−'}${fmt(n)}`;
const change = (n) => (Math.round(n) === 0 ? 'flat' : signed(n));

// Display name for a slug, from the account registry's bankName
function bankName(slug) {
  const reg = readJson('config/accounts.json', {});
  const inst = (reg.institutions || reg)[slug];
  return inst?.accounts?.[0]?.bankName || slug;
}

// Brief section: four lines, plus a freshness line only when something is stale
function renderBriefSection(p) {
  const t = p.totals;
  const f = p.flows;
  const vsPace = f.monthToDate.spending - f.spendingPaceToDate;
  const lines = [
    `Liquid ${fmt(t.liquidNetWorth)} (${change(t.change.liquidNetWorth)}). Without the house ${fmt(t.netWorthExRealEstate)} (${change(t.change.netWorthExRealEstate)}).`,
    `Month to date: ${fmt(f.monthToDate.income)} in, ${fmt(f.monthToDate.spending)} out, net ${signed(f.monthToDate.net)}. ` +
      `Spending is ${fmt(vsPace)} ${vsPace > 0 ? 'above' : 'below'} the 90-day pace.`,
    `Committed next ${p.committed.windowDays} days: ${fmt(p.committed.total)}` +
      (p.committed.items.length ? ` (${p.committed.items.map(i => `${i.name} ${fmt(i.amount)}`).join(', ')}).` : '.'),
    `Free cash after that: ${fmt(p.freeCash)}.`,
  ];
  if (p.stale.length) {
    lines.push(`Older data: ${p.stale.map(s => `${bankName(s.institution)} ${s.ageDays}d`).join(', ')}.`);
  }
  return { type: 'household_picture', title: 'Household Picture', body: lines.join('\n') };
}

module.exports = { buildHouseholdPicture, renderBriefSection };

if (require.main === module) {
  const picture = buildHouseholdPicture();
  const out = process.argv.includes('--section') ? renderBriefSection(picture) : picture;
  console.log(JSON.stringify(out, null, 2));
}
