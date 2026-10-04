#!/usr/bin/env node
/**
 * Derive step for the Personal Financial Statement.
 *
 * Pulls everything the statement needs that Foliome can work out from synced
 * data, BEFORE the interview asks anything. The output is a proposal: the
 * skill confirms it with the household and writes the confirmed values into
 * config/pfs-profile.json, each tagged with a `source`.
 *
 * Derives:
 *   - accounts: owner unknown, but tax treatment guessed from type/aliases
 *   - per-account asset mix (holdings → asset class) and the blended real return / volatility
 *   - payroll: recurring paycheck deposits → net per period and cadence
 *   - mortgage: balance, recurring payment, and (if a rate is known) payoff
 *   - property tax: county tax payments → annual amount and installment months
 *   - monthly cash flow categories over the last N full months
 *   - questions: the interview items that still need a human answer
 *
 * Usage: node scripts/pfs/derive.js [--months 6]  → data/pfs/derived.json
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const argOf = f => args.includes(f) ? args[args.indexOf(f) + 1] : null;
const PFS_DIR = process.env.PFS_DATA_DIR ? path.resolve(process.env.PFS_DATA_DIR) : path.join(__dirname, '..', '..', 'data', 'pfs');
const PROFILE_PATH = argOf('--profile') ? path.resolve(argOf('--profile')) : path.join(__dirname, '..', '..', 'config', 'pfs-profile.json');
const CMA = JSON.parse(JSON.stringify(require('./assumptions/capital-markets.json')));
// Data-built defaults (scripts/pfs/fetch-market.js) replace the pack's static figures when present,
// then a household's own assumptions overlay (config/pfs-profile.json → assumptionsOverlay.classes) wins.
try {
  const market = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'market.json'), 'utf8'));
  for (const [k, c] of Object.entries(market.classes || {})) CMA.classes[k] = { ...CMA.classes[k], ...c, source: 'data-built' };
} catch { /* fall back to the static pack */ }
try {
  const overlay = (JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')).assumptionsOverlay || {}).classes || {};
  for (const [k, c] of Object.entries(overlay)) CMA.classes[k] = { ...CMA.classes[k], ...c, source: c.note || 'household overlay' };
} catch { /* no profile */ }
const TICK = require('./assumptions/tickers.json');
const { mixToWeights } = require('./project');
const months = args.includes('--months') ? +args[args.indexOf('--months') + 1] : 6;

const db = new Database(argOf('--db') ? path.resolve(argOf('--db')) : path.join(ROOT, 'data', 'foliome.db'), { readonly: true });
const sum = a => a.reduce((s, x) => s + x, 0);

// ── Accounts ───────────────────────────────────────────────────────────────
const latest = db.prepare(`SELECT b.institution, b.account_id, b.account_name, b.account_type, b.balance, b.synced_at FROM balances b
  INNER JOIN (SELECT account_id, MAX(synced_at) m FROM balances GROUP BY account_id) x ON b.account_id = x.account_id AND b.synced_at = x.m`).all();
let registry = [];
try {
  const raw = require(path.join(ROOT, 'config', 'accounts.json'));
  const walk = v => Array.isArray(v) ? v.forEach(walk) : v && typeof v === 'object' ? (v.accountId ? registry.push(v) : Object.values(v).forEach(walk)) : null;
  walk(raw);
} catch { /* no registry */ }
const aliasesOf = id => ((registry.find(r => r.accountId === id) || {}).aliases || []).join(' ');

function guessTaxType(a) {
  const text = `${a.account_id} ${aliasesOf(a.account_id)}`.toLowerCase();
  if (a.account_type === 'mortgage' || a.account_type === 'credit') return { taxType: 'liability', confidence: 'high' };
  if (a.account_type === 'real_estate') return { taxType: 'property', confidence: 'high' };
  if (a.account_type === 'education' || /529/.test(text)) return { taxType: 'education', confidence: 'high' };
  if (/roth/.test(text)) return { taxType: 'exempt', confidence: 'medium' };
  if (/hsa/.test(text)) return { taxType: 'exempt', confidence: 'medium', note: 'HSA: tax-free for medical use' };
  if (/401|403|457|ira|rollover|retire|tsp|pension/.test(text) || a.account_type === 'retirement') return { taxType: 'deferred', confidence: a.account_type === 'retirement' ? 'medium' : 'low' };
  if (a.account_type === 'brokerage') return { taxType: 'taxable', confidence: 'low', note: 'brokerage accounts can be IRAs. Confirm the registration' };
  return { taxType: 'taxable', confidence: 'high' };
}
const accounts = latest.map(a => ({ id: a.account_id, name: `${a.account_name || a.account_id}${(String(a.account_id).match(/(\d{4})$/) || [])[1] ? ` …${String(a.account_id).match(/(\d{4})$/)[1]}` : ''}`, institution: a.institution, type: a.account_type, balance: a.balance, asOf: a.synced_at.slice(0, 10), ...guessTaxType(a) }));

// ── Holdings → asset mix → blended return / vol ────────────────────────────
function classify(h) {
  if (h.instrument_type && /OPTION/i.test(h.instrument_type)) return 'options';
  if (/\s\d{6}[CP]\d{8}$/.test(h.symbol || '')) return 'options';
  const sym = (h.symbol || '').trim().toUpperCase();
  if (TICK.tickers[sym]) return TICK.tickers[sym];
  const name = (h.name || '').toLowerCase();
  const kw = TICK.nameKeywords.find(k => new RegExp(k.match, 'i').test(name));
  if (kw) return kw.class;
  if (h.instrument_type && TICK.instrumentRules[h.instrument_type.toUpperCase()]) return TICK.instrumentRules[h.instrument_type.toUpperCase()];
  return 'unknown';
}
const holdings = db.prepare(`SELECT h.* FROM holdings h INNER JOIN (SELECT account_id, MAX(synced_at) m FROM holdings GROUP BY account_id) x
  ON h.account_id = x.account_id AND h.synced_at = x.m`).all();
const mixes = {};
for (const h of holdings) {
  const cls = classify(h);
  const m = (mixes[h.account_id] ||= { classes: {}, unclassified: [], total: 0 });
  if (CMA.classes[cls] && CMA.classes[cls].exclude) continue;
  m.classes[cls] = (m.classes[cls] || 0) + (h.market_value || 0);
  m.total += h.market_value || 0;
  if (cls === 'unknown') m.unclassified.push(h.symbol);
}
for (const a of accounts) {
  const m = mixes[a.id];
  const invest = ['brokerage', 'retirement', 'education'].includes(a.type);
  if (!invest || Math.abs(a.balance) < 1) continue;
  // Cash not held in positions counts as cash.
  const held = m ? m.total : 0;
  const cashResidual = m ? Math.max(0, a.balance - held) : 0; // uninvested cash only where positions are known
  const classes = { ...(m ? m.classes : {}) };
  if (cashResidual > 1) classes.cash = (classes.cash || 0) + cashResidual;
  const total = sum(Object.values(classes));
  if (total <= 0) {
    const c = CMA.classes[CMA.unknownAccountMix.class];
    a.mix = { [CMA.unknownAccountMix.class]: 1 }; a.realReturn = c.realReturn; a.vol = c.vol;
    a.weights = mixToWeights(a.mix, CMA.classes);
    a.mixSource = 'no holdings data. Assumed a balanced/target-date mix; ask what it holds';
    continue;
  }
  a.mix = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, +(v / total).toFixed(4)]));
  a.realReturn = +sum(Object.entries(a.mix).map(([k, w]) => w * CMA.classes[k].realReturn)).toFixed(4);
  // volatility: classes share one market factor via equityLoading, so weight vol by loading (near-full correlation for equities)
  a.vol = +sum(Object.entries(a.mix).map(([k, w]) => w * CMA.classes[k].vol)).toFixed(4);
  a.weights = mixToWeights(a.mix, CMA.classes);
  a.mixSource = `holdings as of ${a.asOf}${m && m.unclassified.length ? `; unclassified: ${m.unclassified.join(', ')}` : ''}`;
}

// ── Transactions window ────────────────────────────────────────────────────
const today = new Date();
const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - months);
const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
const tx = db.prepare(`SELECT date, account_id, amount, description, COALESCE(NULLIF(user_category,''), category, 'Other') AS cat
  FROM transactions WHERE date >= ? AND date < ?`).all(from, to);

// Payroll: deposits whose description says payroll / salary / direct dep
const payrollRows = tx.filter(t => t.amount > 0 && /payroll|salary|direct dep|dir dep|paycheck/i.test(t.description));
const payrollBySource = {};
for (const t of payrollRows) {
  const key = t.description.toLowerCase().replace(/[0-9#*]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) + ' → ' + t.account_id;
  (payrollBySource[key] ||= []).push(t);
}
const payroll = Object.entries(payrollBySource).map(([k, rows]) => {
  const perMonth = rows.length / months;
  const cadence = perMonth > 2.05 ? 'biweekly (26/yr)' : perMonth > 1.5 ? 'semi-monthly (24/yr)' : perMonth > 0.8 ? 'monthly (12/yr)' : 'irregular';
  const amounts = rows.map(r => r.amount).sort((a, b) => a - b);
  const typical = amounts[Math.floor(amounts.length / 2)];
  return { source: k, deposits: rows.length, typicalNet: typical, cadence, annualNetObserved: sum(rows.map(r => r.amount)) * 12 / months };
});

// Mortgage
const mortAcct = accounts.find(a => a.type === 'mortgage');
const mortPays = tx.filter(t => t.amount < 0 && (t.cat === 'Mortgage' || /mtg|mortgage|home loan/i.test(t.description)));
let mortgage = null;
if (mortAcct) {
  const pays = mortPays.map(t => -t.amount).sort((a, b) => a - b);
  const payment = pays.length ? pays[Math.floor(pays.length / 2)] : null;
  mortgage = { account: mortAcct.id, balance: -mortAcct.balance, payment, paymentsSeen: pays.length,
    note: payment ? 'Payment from transactions. Ask for the rate (or the scheduled P&I) to compute payoff; or ask for the payoff date to solve the rate.' : 'No payments found in synced accounts. Ask for the payment.' };
}

// Property tax: county / tax collector payments
const ptax = tx.filter(t => t.amount < 0 && /county.*(tax|epayment)|tax collector|property tax|treasurer/i.test(t.description) && !/water|utility/i.test(t.description));
const propertyTax = ptax.length ? {
  payments: ptax.map(t => ({ date: t.date, amount: -t.amount, description: t.description })),
  annualEstimate: ptax.length === 1 ? -ptax[0].amount * 2 : sum(ptax.map(t => -t.amount)) * 12 / months,
  note: ptax.length === 1 ? 'One installment in the window; assumed two per year. Confirm against the tax bill.' : 'Annualized from the window.',
} : null;

// Category cash flow (outflows, monthly average)
const cats = {};
for (const t of tx) if (t.amount < 0 && t.cat !== 'Transfer' && t.cat !== 'Income') cats[t.cat] = (cats[t.cat] || 0) - t.amount / months;

// ── Questions the data can't answer ────────────────────────────────────────
let answered = {};
try { answered = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')); } catch { /* no profile yet */ }
const questions = [
  { id: 'household', ask: 'Who is in the household? Birth month and year for each person (adults and children), and any other dependents.' },
  { id: 'ownership', ask: 'Which accounts are joint, and whose are the others?', prefill: accounts.filter(a => !['liability', 'property'].includes(a.taxType)).map(a => a.id) },
  ...accounts.filter(a => a.confidence !== 'high' && !['liability', 'property'].includes(a.taxType) && Math.abs(a.balance) >= 1 && !(answered.accountMeta || {})[a.id]).map(a => ({ id: `taxtype:${a.id}`, ask: `Is ${a.name} a taxable account, a traditional IRA/401(k), or a Roth? (I guessed ${a.taxType}.)`, hint: 'Check the account registration on the statement.' })),
  { id: 'unsynced', ask: 'Are there accounts Foliome doesn\'t sync (a spouse\'s accounts, a workplace plan, a pension)? Rough balance and date for each.' },
  { id: 'pay', ask: 'For each earner: salary (or hourly rate × hours per pay period), pay periods per year, bonus, employer match.', hint: 'Your paystub has all of this.', crossCheck: payroll },
  { id: 'deductions', ask: 'Pre-tax deductions per paycheck: 401(k)/403(b)/457, pension contribution, health premiums.', hint: 'Paystub, "deductions" section.' },
  { id: 'stability', ask: 'How steady is each income: very steady, typical, or variable? Any side income, and should it count or be treated as upside?' },
  { id: 'retirementAge', ask: 'When would you like to retire? (I\'ll also show 5 years earlier and 2 years later.)' },
  { id: 'offSideSpending', ask: 'Roughly how much is spent each month from accounts Foliome doesn\'t sync?' },
  ...(mortgage ? [{ id: 'mortgageRate', ask: 'What is the mortgage interest rate, and are you paying extra principal?', hint: 'Mortgage statement.' }] : []),
  { id: 'goals', ask: 'What are you saving for? For each: what, by when, roughly how much, and is it a must, a want, or a nice-to-have?', hint: 'College gets cost options to pick from.' },
  { id: 'protection', ask: 'Life and disability insurance amounts; will, guardianship and beneficiary status.' },
  { id: 'targetMix', optional: true, ask: 'Is your target investment mix different from what you hold today? Any planned change at retirement?', prefill: accounts.filter(a => a.mix).map(a => ({ id: a.id, mix: a.mix })) },
];

// A question stays open until its profile section is answered (the template lists sample sections in _examples)
const SECTION = { household: 'household', ownership: 'accountMeta', unsynced: 'offSyncAccounts', pay: 'humanCapital', deductions: 'humanCapital', stability: 'humanCapital',
  retirementAge: 'retirement', offSideSpending: 'spending', mortgageRate: 'mortgage', goals: 'goals', protection: 'protection' };
const hasProfile = Object.keys(answered).length > 0;
const isOpen = q => { const sec = SECTION[q.id]; if (!sec || !hasProfile) return true; return (answered._examples || []).includes(sec) || answered[sec] == null; };
const openQuestions = questions.filter(isOpen);
questions.length = 0; questions.push(...openQuestions);
const out = { generatedAt: new Date().toISOString(), window: { from, to, months }, accounts, payroll, mortgage, propertyTax,
  monthlyOutflowsByCategory: Object.fromEntries(Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round(v)])), questions };
fs.mkdirSync(PFS_DIR, { recursive: true });
fs.writeFileSync(path.join(PFS_DIR, 'derived.json'), JSON.stringify(out, null, 2));
if (require.main === module) {
  console.log(`accounts ${accounts.length}, payroll sources ${payroll.length}, mortgage ${mortgage ? 'yes' : 'no'}, property tax ${propertyTax ? 'yes' : 'no'}, questions ${questions.length}`);
  for (const a of accounts.filter(a => a.mix)) console.log(`  ${a.id}: ${(a.realReturn * 100).toFixed(1)}% real, vol ${(a.vol * 100).toFixed(0)}%. ${Object.entries(a.mix).map(([k, w]) => `${k} ${Math.round(w * 100)}%`).join(', ')} (${a.mixSource})`);
  for (const p of payroll) console.log(`  payroll: ${p.source}: ${p.deposits} deposits, typical $${p.typicalNet}, ${p.cadence}`);
  if (mortgage) console.log(`  mortgage: balance $${Math.round(mortgage.balance)}, payment $${mortgage.payment}`);
  if (propertyTax) console.log(`  property tax ≈ $${Math.round(propertyTax.annualEstimate)}/yr`);
}
module.exports = { classify };
