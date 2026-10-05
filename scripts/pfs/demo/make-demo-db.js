#!/usr/bin/env node
/**
 * Build a synthetic Foliome database for the demo household (scripts/pfs/demo/demo-profile.json).
 * Same schema as data/foliome.db, made-up data only.
 *
 * Usage: node scripts/pfs/demo/make-demo-db.js <out.db> [--as-of YYYY-MM-DD] [--quarter-later] [--history]
 *
 * --history adds what a statement of activity needs and the PFS doesn't: daily balance snapshots that tie out to
 * the transactions, a monthly transfer to savings, card payments on both sides, 401(k) contributions from pay and a
 * mortgage that amortizes. The PFS tests build without it, so their numbers don't move.
 */
const fs = require('fs');
const Database = require('better-sqlite3');

const out = process.argv[2];
if (!out) { console.error('usage: make-demo-db.js <out.db> [--as-of YYYY-MM-DD]'); process.exit(1); }
const asOf = process.argv.includes('--as-of') ? process.argv[process.argv.indexOf('--as-of') + 1] : new Date().toISOString().slice(0, 10);
if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new Database(out);
db.exec(`
CREATE TABLE balances (id INTEGER PRIMARY KEY AUTOINCREMENT, institution TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT,
  account_type TEXT NOT NULL, balance REAL NOT NULL, currency TEXT DEFAULT 'USD', synced_at TEXT NOT NULL, UNIQUE(account_id, synced_at));
CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, institution TEXT NOT NULL, account_id TEXT NOT NULL, account_type TEXT,
  date TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL, category TEXT, user_category TEXT, status TEXT DEFAULT 'posted');
CREATE TABLE holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, institution TEXT NOT NULL, account_id TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT,
  quantity REAL NOT NULL, price REAL, market_value REAL, cost_basis REAL, currency TEXT DEFAULT 'USD', synced_at TEXT NOT NULL,
  instrument_type TEXT, UNIQUE(account_id, symbol, synced_at));
CREATE TABLE sync_status (institution TEXT PRIMARY KEY, last_success TEXT, last_attempt TEXT, last_error TEXT, status TEXT DEFAULT 'ok');
`);
const ts = `${asOf}T14:00:00.000Z`;
// --quarter-later: the same household one quarter on (markets up a bit, mortgage paid down, 529 deposits made)
const later = process.argv.includes('--quarter-later');
const history = process.argv.includes('--history');

const accounts = [
  ['demobank', 'demobank-checking-1001', 'checking', 4200],
  ['demobank', 'demobank-savings-1002', 'savings', 32000],
  ['demobank', 'demobank-credit-6001', 'credit', -2300],
  ['demobroker', 'demobroker-brokerage-2001', 'brokerage', 48000],
  ['demobroker', 'demobroker-ira-2002', 'brokerage', 210000],
  ['demobroker', 'demobroker-roth-2003', 'brokerage', 38000],
  ['demoplan', 'demoplan-401k-3001', 'retirement', 96000],
  ['demo529', 'demo529-education-4001', 'education', 22000],
  ['real-estate', 'home-residence', 'real_estate', 640000],
  ['demolender', 'demolender-mortgage-5001', 'mortgage', -385000],
];
const bump = { 'demobank-savings-1002': 34500, 'demobroker-brokerage-2001': 49900, 'demobroker-ira-2002': 217800, 'demobroker-roth-2003': 39600,
  'demoplan-401k-3001': 103100, 'demo529-education-4001': 24300, 'home-residence': 646000, 'demolender-mortgage-5001': -382400 };
const ib = db.prepare('INSERT INTO balances (institution, account_id, account_type, balance, synced_at) VALUES (?,?,?,?,?)');
for (const [inst, id, type, bal] of accounts) ib.run(inst, id, type, later && bump[id] != null ? bump[id] : bal, ts);
const ss = db.prepare('INSERT INTO sync_status (institution, last_success, last_attempt) VALUES (?,?,?)');
for (const inst of [...new Set(accounts.map(a => a[0]))]) ss.run(inst, ts, ts);

const ih = db.prepare('INSERT INTO holdings (institution, account_id, symbol, name, quantity, price, market_value, synced_at, instrument_type) VALUES (?,?,?,?,?,?,?,?,?)');
const hold = [
  ['demobroker-brokerage-2001', 'VTI', 'Vanguard Total Stock Market ETF', 30000], ['demobroker-brokerage-2001', 'BND', 'Vanguard Total Bond Market ETF', 10000], ['demobroker-brokerage-2001', 'SGOV', 'iShares 0-3 Month Treasury Bond ETF', 8000],
  ['demobroker-ira-2002', 'VTI', 'Vanguard Total Stock Market ETF', 120000], ['demobroker-ira-2002', 'VXUS', 'Vanguard Total International Stock ETF', 50000], ['demobroker-ira-2002', 'BND', 'Vanguard Total Bond Market ETF', 40000],
  ['demobroker-roth-2003', 'QQQ', 'Invesco QQQ Trust', 20000], ['demobroker-roth-2003', 'VTI', 'Vanguard Total Stock Market ETF', 18000],
];
for (const [acct, sym, name, mv] of hold) ih.run('demobroker', acct, sym, name, +(mv / 100).toFixed(4), 100, mv, ts, 'ETF');

// Six full months of transactions before the as-of month
const it = db.prepare('INSERT INTO transactions (institution, account_id, date, description, amount, category) VALUES (?,?,?,?,?,?)');
const end = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`);
let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const jitter = (x, p = 0.08) => +(x * (1 + (rnd() * 2 - 1) * p)).toFixed(2);
let prevCharges = null; const months = [];
for (let m = 6; m >= 1; m--) {
  const d = new Date(end); d.setUTCMonth(d.getUTCMonth() - m);
  const ym = d.toISOString().slice(0, 7);
  const day = n => `${ym}-${String(n).padStart(2, '0')}`;
  const chk = 'demobank-checking-1001', card = 'demobank-credit-6001';
  it.run('demobank', chk, day(15), 'ACME CORP PAYROLL', 3168, 'Income');
  it.run('demobank', chk, day(28), 'ACME CORP PAYROLL', 3168, 'Income');
  it.run('demobank', chk, day(1), 'SCHOOL DISTRICT PAYROLL', 4790, 'Income');
  it.run('demobank', 'demobank-savings-1002', day(28), 'Monthly interest paid', 48, 'Income');
  it.run('demobank', chk, day(1), 'DEMOLENDER MORTGAGE PAYMENT', -2650, 'Mortgage');
  if (m === 6) it.run('demobank', chk, day(10), 'COUNTY TREASURER PROPERTY TAX', -3900, 'Utilities');
  it.run('demobank', chk, day(12), 'CITY UTILITIES', -jitter(260), 'Utilities');
  it.run('demobank', card, day(18), 'INTERNET SERVICE', -80, 'Utilities');
  it.run('demobank', chk, day(5), 'LITTLE SPROUTS CHILDCARE', -1400, 'Childcare');
  it.run('demobank', card, day(3), 'AUTO + HOME INSURANCE', -310, 'Insurance');
  for (let w = 0; w < 4; w++) it.run('demobank', card, day(4 + w * 7), 'NEIGHBORHOOD GROCERY', -jitter(270), 'Groceries');
  for (let w = 0; w < 3; w++) it.run('demobank', card, day(9 + w * 6), 'LOCAL RESTAURANT', -jitter(140), 'Restaurants');
  it.run('demobank', card, day(7), 'STREAMING + APPS', -95, 'Subscription');
  it.run('demobank', card, day(20), 'ONLINE STORE', -jitter(560, 0.3), 'Shopping');
  it.run('demobank', card, day(22), 'GAS STATION', -jitter(180), 'Transportation');
  if (history) {
    // Autopay pays last month's card charges in full, on both sides; savings gets a monthly transfer.
    const pay = +(prevCharges ?? 2100).toFixed(2);
    it.run('demobank', chk, day(25), 'CARD AUTOPAY', -pay, 'Transfer');
    it.run('demobank', card, day(25), 'PAYMENT, THANK YOU', pay, 'Transfer');
    it.run('demobank', chk, day(29), 'TRANSFER TO SAVINGS ...1002', -4000, 'Transfer');
    it.run('demobank', 'demobank-savings-1002', day(29), 'TRANSFER FROM CHECKING ...1001', 4000, 'Transfer');
    prevCharges = -db.prepare(`SELECT SUM(amount) s FROM transactions WHERE account_id = ? AND date LIKE ? AND category != 'Transfer'`).get(card, `${ym}-%`).s;
    months.push(ym);
  } else it.run('demobank', chk, day(25), 'CARD AUTOPAY', -2100, 'Transfer');
  if (later && m <= 3) it.run('demo529', 'demo529-education-4001', day(10), 'CONTRIBUTION FROM CHECKING', 640, 'Transfer');
}
if (history) writeHistory();
db.close();
console.log(`Demo database written: ${out} (as of ${asOf}${history ? ', with history' : ''})`);

// Daily end-of-day balance snapshots for every account, worked backwards from the as-of balances so that
// opening + transactions = closing for cash and cards, and investments, the mortgage and the home move by rule.
function writeHistory() {
  db.exec(`CREATE TABLE IF NOT EXISTS investment_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, institution TEXT NOT NULL,
    account_id TEXT NOT NULL, date TEXT NOT NULL, description TEXT NOT NULL, type TEXT, symbol TEXT, quantity REAL, price REAL,
    amount REAL NOT NULL, fees REAL DEFAULT 0, user_category TEXT, category_source TEXT)`);
  const iit = db.prepare('INSERT INTO investment_transactions (institution, account_id, date, description, type, amount, user_category, category_source) VALUES (?,?,?,?,?,?,?,?)');
  // Card statements close at month end; autopay pays each one in full on the 25th of the next month.
  db.exec(`CREATE TABLE IF NOT EXISTS statement_balances (id INTEGER PRIMARY KEY AUTOINCREMENT, institution TEXT NOT NULL, account_id TEXT NOT NULL,
    period_start TEXT, period_end TEXT NOT NULL, opening_balance REAL, closing_balance REAL NOT NULL, source TEXT, UNIQUE(institution, account_id, period_end))`);
  for (const ym of months) {
    const charges = db.prepare("SELECT COALESCE(SUM(amount), 0) s FROM transactions WHERE account_id = 'demobank-credit-6001' AND date LIKE ? AND category != 'Transfer'").get(`${ym}-%`).s;
    const last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
    db.prepare('INSERT INTO statement_balances (institution, account_id, period_start, period_end, closing_balance, source) VALUES (?,?,?,?,?,?)').run('demobank', 'demobank-credit-6001', `${ym}-01`, last, +charges.toFixed(2), 'pdf');
  }
  const k401 = 'demoplan-401k-3001';
  for (const ym of months) for (const d of ['15', '28']) iit.run('demoplan', k401, `${ym}-${d}`, 'Payroll contribution (employee + match)', 'Contribution', 946.5, 'Contribution', 'rule');

  const close = Object.fromEntries(accounts.map(([, id, , bal]) => [id, bal]));
  const days = []; // every day from the first month through the day before as-of
  for (let d = new Date(`${months[0]}-01T00:00:00Z`); d < new Date(`${asOf}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const eod = day => new Date(`${day}T23:59:00`).toISOString(); // end of day, local time
  const after = (acct, day) => db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM transactions WHERE account_id = ? AND date > ?').get(acct, day).s;
  const contribAfter = (acct, day) => db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM investment_transactions WHERE account_id = ? AND date > ?').get(acct, day).s;
  const kinds = Object.fromEntries(accounts.map(([inst, id, type]) => [id, { inst, type }]));
  const names = { 'demobank-checking-1001': 'Demo Bank Checking (...1001)', 'demobank-savings-1002': 'Demo Bank Savings (...1002)',
    'demobank-credit-6001': 'Demo Bank Visa (...6001)', 'demobroker-brokerage-2001': 'Brokerage (...2001)', 'demobroker-ira-2002': 'Rollover IRA (...2002)',
    'demobroker-roth-2003': 'Roth IRA (...2003)', 'demoplan-401k-3001': '401(k) (...3001)', 'demo529-education-4001': '529 Plan (...4001)',
    'home-residence': 'Home (estimate)', 'demolender-mortgage-5001': 'Mortgage (...5001)' };
  for (const [id, n] of Object.entries(names)) db.prepare('UPDATE balances SET account_name = ? WHERE account_id = ?').run(n, id);
  const put = (id, day, bal) => db.prepare('INSERT INTO balances (institution, account_id, account_name, account_type, balance, synced_at) VALUES (?,?,?,?,?,?)').run(kinds[id].inst, id, names[id], kinds[id].type, +bal.toFixed(2), eod(day));

  // Cash and cards: balance at end of day = as-of balance minus everything posted after it.
  for (const id of ['demobank-checking-1001', 'demobank-savings-1002', 'demobank-credit-6001'])
    for (const day of days) put(id, day, close[id] - after(id, day));

  // Investments: a fixed monthly return path, applied backwards; contributions added on their dates.
  const ret = [0.008, -0.012, 0.015, 0.004, 0.010, 0.00966];
  const invest = ['demobroker-brokerage-2001', 'demobroker-ira-2002', 'demobroker-roth-2003', k401, 'demo529-education-4001'];
  for (const id of invest) {
    const monthEnd = {}; let v = close[id];
    for (let i = months.length - 1; i >= 0; i--) {
      monthEnd[months[i]] = v;
      const c = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM investment_transactions WHERE account_id = ? AND date LIKE ?').get(id, `${months[i]}-%`).s;
      v = (v - c) / (1 + ret.at(i));
    }
    const startOf = Object.fromEntries(months.map((ym, i) => [ym, i ? monthEnd[months[i - 1]] : v]));
    for (const day of days) {
      const ym = day.slice(0, 7);
      if (!monthEnd[ym]) { put(id, day, close[id]); continue; }
      const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate(), f = +day.slice(8) / dim;
      const cIn = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM investment_transactions WHERE account_id = ? AND date LIKE ? AND date <= ?').get(id, `${ym}-%`, day).s;
      const cAll = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM investment_transactions WHERE account_id = ? AND date LIKE ?').get(id, `${ym}-%`).s;
      const growth = monthEnd[ym] - startOf[ym] - cAll;
      put(id, day, startOf[ym] + growth * f + cIn);
    }
  }

  // Mortgage: 5.4% fixed, $2,650 paid on the 1st; owed before each payment worked back from the as-of balance.
  const mort = 'demolender-mortgage-5001', i = 0.054 / 12;
  const owedAfter = {}; let owed = -close[mort];
  for (let k = months.length - 1; k >= 0; k--) { owedAfter[months[k]] = owed; owed = (owed + 2650) / (1 + i); }
  for (const day of days) {
    const ym = day.slice(0, 7);
    put(mort, day, -(owedAfter[ym] ?? -close[mort]));
  }
  // Home: an online estimate refreshed on the 20th, up $2,000 a month.
  months.forEach((ym, k) => put('home-residence', `${ym}-20`, close['home-residence'] - 2000 * (months.length - 1 - k)));
}
