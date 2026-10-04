#!/usr/bin/env node
/**
 * Build a synthetic Foliome database for the demo household (scripts/pfs/demo/demo-profile.json).
 * Same schema as data/foliome.db, made-up data only.
 *
 * Usage: node scripts/pfs/demo/make-demo-db.js <out.db> [--as-of YYYY-MM-DD]
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
  it.run('demobank', chk, day(25), 'CARD AUTOPAY', -2100, 'Transfer');
  if (later && m <= 3) it.run('demo529', 'demo529-education-4001', day(10), 'CONTRIBUTION FROM CHECKING', 640, 'Transfer');
}
db.close();
console.log(`Demo database written: ${out} (as of ${asOf})`);
