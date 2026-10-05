#!/usr/bin/env node
/**
 * Personal Financial Statement builder.
 *
 * Method: an explicit
 * balance sheet (what we own / owe), a family extended balance sheet (adds human
 * capital and the present value of lifestyle and goals), goals-based funding,
 * liquidity, and what-ifs. All implicit values are real (today's dollars).
 *
 * Inputs:  data/foliome.db (synced balances) + config/pfs-profile.json (everything
 *          Foliome can't observe: household, pay, goals, assumptions).
 * Outputs: data/pfs/<YYYY-MM-DD>/snapshot.json   frozen inputs + results
 *          data/pfs/<YYYY-MM-DD>/statement.html  the statement
 *          data/pfs/<YYYY-MM-DD>/statement.pdf   (unless --no-pdf)
 *
 * Usage: node scripts/pfs/build.js [--no-pdf] [--date YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const argOf = f => process.argv.includes(f) ? process.argv[process.argv.indexOf(f) + 1] : null;
const DB_PATH = argOf('--db') ? path.resolve(argOf('--db')) : path.join(ROOT, 'data', 'foliome.db');
// Where derived.json / market.json / rates.json live (data/pfs by default; PFS_DATA_DIR for demos and tests)
const PFS_DIR = process.env.PFS_DATA_DIR ? path.resolve(process.env.PFS_DATA_DIR) : path.join(ROOT, 'data', 'pfs');
const PROFILE_PATH = process.argv.includes('--profile') ? path.resolve(process.argv[process.argv.indexOf('--profile') + 1]) : path.join(ROOT, 'config', 'pfs-profile.json');
const OUT_ROOT = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : path.join(ROOT, 'data', 'pfs');

const args = process.argv.slice(2);
const noPdf = args.includes('--no-pdf');
const dateArg = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const asOf = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const asOfYear = Number(asOf.slice(0, 4));

// ── Inputs ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(PROFILE_PATH)) {
  console.error('Missing config/pfs-profile.json. Copy config-templates/pfs-profile.json and fill it in (the /financial-statement skill interviews you for it).');
  process.exit(1);
}
const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
// ── Scenario overlay (--scenario name): config/pfs-scenarios/<name>.json ─────
// { "label", "description", "set": { "dotted.path": value }, "goalsPatch": [{ id, ...fields }], "addGoals": [...], "removeGoals": [ids] }
const scenarioName = args.includes('--scenario') ? args[args.indexOf('--scenario') + 1] : null;
let scenario = null;
if (scenarioName) {
  const sp = [path.join(ROOT, 'config', 'pfs-scenarios', `${scenarioName}.json`), path.resolve(scenarioName)].find(f => fs.existsSync(f));
  if (!sp) { console.error(`Scenario not found: config/pfs-scenarios/${scenarioName}.json`); process.exit(1); }
  scenario = JSON.parse(fs.readFileSync(sp, 'utf8'));
  scenario.name = path.basename(sp, '.json');
  for (const [k, v] of Object.entries(scenario.set || {})) {
    const keys = k.split('.'); let o = profile;
    for (const key of keys.slice(0, -1)) o = (o[key] ??= {});
    o[keys[keys.length - 1]] = v;
  }
  for (const gp of scenario.goalsPatch || []) { const g = profile.goals.find(x => x.id === gp.id); if (g) Object.assign(g, gp); }
  if (scenario.removeGoals) profile.goals = profile.goals.filter(g => !scenario.removeGoals.includes(g.id));
  if (scenario.addGoals) profile.goals.push(...scenario.addGoals);
}

let previous = null; // last statement before this one (never a scenario)
if (fs.existsSync(OUT_ROOT)) {
  const dirs = fs.readdirSync(OUT_ROOT).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < asOf).sort();
  if (dirs.length) {
    const p = path.join(OUT_ROOT, dirs[dirs.length - 1], 'snapshot.json');
    if (fs.existsSync(p)) previous = JSON.parse(fs.readFileSync(p, 'utf8'));
  }
}


// ── Dates: profiles hold real dates; the engine works in years from the statement date ──
// So goals, ages and phases count down by themselves between quarterly reviews.
const yearsBetween = (a, b) => (new Date(b + (b.length === 7 ? '-01' : '')) - new Date(a + (a.length === 7 ? '-01' : ''))) / (365.25 * 86400000);
const q = x => Math.round(x * 4) / 4; // quarter-year precision for horizons
for (const m of profile.household.members) {
  if (!m.born && m.age != null && m.asOf) { const d = new Date(m.asOf); d.setUTCFullYear(d.getUTCFullYear() - m.age); m.born = d.toISOString().slice(0, 7); }
  if (m.born) { m.exactAge = yearsBetween(m.born, asOf); m.age = Math.floor(m.exactAge); }
}
for (const g of profile.goals || []) {
  if (g.startsOn) g.startsInYears = Math.max(0, q(yearsBetween(asOf, g.startsOn)));
  if (g.by) g.inYears = Math.max(0, q(yearsBetween(asOf, g.by)));
}
{ const ph0 = profile.spending.phased || {};
  if (ph0.childcareEndsOn) ph0.childcareYears = Math.max(0, Math.ceil(yearsBetween(asOf, ph0.childcareEndsOn))); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addYears = y => { const d = new Date(asOf + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + Math.round(y * 12)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const frac = y => { const t = Math.round(y * 4) / 4, w = Math.floor(t), f = Math.round((t - w) * 4); return `${w || (f ? '' : '0')}${['', '¼', '½', '¾'][f]}`; };
const fmtYm = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const horizon = (y, ym) => `${ym ? fmtYm(ym) : addYears(y)} (in ${frac(y)} yr${Math.round(y * 4) / 4 === 1 ? '' : 's'})`;

// ── Assumptions pack: fill anything the household profile doesn't set ───────
const PACK = path.join(__dirname, 'assumptions');
const packJson = f => JSON.parse(fs.readFileSync(path.join(PACK, f), 'utf8'));
const assumptionsUsed = [];
(function applyDefaults() {
  const hh = packJson('household.json');
  if (!profile.tax) {
    const fed = packJson('tax/federal-2026.json');
    const stCode = (profile.household.state || '').toUpperCase();
    const stFile = path.join(PACK, 'tax', `state-${stCode}.json`);
    const st = stCode && fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : null;
    const filing = profile.household.members.filter(m => m.role === 'adult').length > 1 ? 'mfj' : 'single';
    profile.tax = {
      _note: `From the assumptions pack: federal ${fed.year}${st ? `, ${st.state} ${st.year}` : ', state flat-rate fallback'}`,
      year: fed.year, filing: filing.toUpperCase(), dependentsUnder17: profile.household.members.filter(m => m.role === 'child' && (m.age ?? 99) < 17).length,
      federal: { ...fed[filing], childTaxCredit: fed.childTaxCredit },
      state: st ? { name: st.state, ...st[filing] || st.mfj, sdiRate: st.sdiRate } : (() => {
        const fb = packJson('tax/state-default.json');
        if (!stCode || fb.noIncomeTaxStates.includes(stCode)) return null;
        return { name: `${stCode} (flat ${(fb.flatRate * 100).toFixed(0)}% estimate)`, standardDeduction: 0, brackets: [[null, fb.flatRate]] };
      })(),
      fica: { ...fed.fica, addlMedicareThreshold: filing === 'mfj' ? fed.fica.addlMedicareThreshold : fed.addlMedicareThresholdSingle },
    };
    assumptionsUsed.push('tax parameters');
  }
  // Per-account return/volatility from derived holdings mix when the profile doesn't give them
  const derivedPath = path.join(PFS_DIR, 'derived.json');
  if (profile.retirement && fs.existsSync(derivedPath)) {
    const derived = JSON.parse(fs.readFileSync(derivedPath, 'utf8'));
    for (const a of profile.retirement.accounts || []) {
      if (a.mu != null && a.sigma != null) continue;
      const d = derived.accounts.find(x => x.id === a.id);
      const cma = packJson('capital-markets.json');
      const fb = cma.classes[cma.unknownAccountMix.class];
      a.mu = d && d.realReturn != null ? d.realReturn : fb.realReturn;
      a.sigma = d && d.vol != null ? d.vol : fb.vol;
      a.source = d ? `derived from holdings (${d.mixSource})` : 'assumptions pack: balanced mix (no holdings data)';
      assumptionsUsed.push(`returns for ${a.id}`);
    }
  }
  const sp = profile.spending.phased || (profile.spending.phased = {});
  if (sp.healthPerPersonPreMedicare == null) { sp.healthPerPersonPreMedicare = hh.health.preMedicarePerPersonYear; sp.medicareAge = hh.health.medicareAge; sp.healthSource = hh.health.source; assumptionsUsed.push('pre-Medicare health'); }
  if (profile.plan && profile.plan.emergencyFundMonths == null) { profile.plan.emergencyFundMonths = hh.emergencyFundMonths; assumptionsUsed.push('emergency fund months'); }
  // Live rates (data/pfs/rates.json from fetch-rates.js) for inflation if not set
  const ratesPath = path.join(PFS_DIR, 'rates.json');
  if (sp.inflation == null) {
    const r = fs.existsSync(ratesPath) ? JSON.parse(fs.readFileSync(ratesPath, 'utf8')) : hh.riskFreeFallback;
    sp.inflation = r.breakevenInflation; sp.inflationSource = r.source || 'fallback'; assumptionsUsed.push('inflation');
  }
})();

// Manual-only mode: profile.manualOnly = true, or no database at all. Everything comes from the profile.
const manualOnly = !!profile.manualOnly || !fs.existsSync(DB_PATH);
const db = manualOnly ? null : new Database(DB_PATH, { readonly: true });

const latest = manualOnly ? [] : db.prepare(`
  SELECT b.institution, b.account_id, b.account_name, b.account_type, b.balance, b.synced_at
  FROM balances b
  INNER JOIN (SELECT account_id, MAX(synced_at) AS m FROM balances GROUP BY account_id) x
    ON b.account_id = x.account_id AND b.synced_at = x.m`).all();
const syncStatus = manualOnly ? [] : db.prepare('SELECT institution, last_success FROM sync_status').all();

// ── Helpers ─────────────────────────────────────────────────────────────────
const members = Object.fromEntries(profile.household.members.map(m => [m.id, m]));
const nameOf = id => (id === 'joint' ? 'Joint' : (members[id] || {}).name || id);
function ageOf(id) {
  const m = members[id];
  if (!m) return null;
  if (m.birthYear) return asOfYear - m.birthYear;
  if (m.age != null) return m.age;
  return null;
}
const missing = [];
function need(v, what) { if (v == null) missing.push(what); return v; }
if (Array.isArray(profile._examples) && profile._examples.length) missing.push(`still sample values from the template: ${profile._examples.join(', ')} (answer these in the interview)`);
const pv = (amount, rate, t) => amount / Math.pow(1 + rate, t);
const sum = a => a.reduce((s, x) => s + x, 0);
const daysOld = iso => Math.floor((new Date(asOf + 'T23:59:59Z') - new Date(iso).getTime()) / 86400000); // age relative to the statement date

// ── Tax model (household, joint return) ─────────────────────────────────────
const { estimateHousehold } = require('./tax');
const payInputs = profile.humanCapital.earners.map(er => ({
  member: er.member,
  gross: sum(er.streams.filter(st => !st.id.includes('match')).map(st => st.annual)),
  preTax: er.preTax || [],
}));
const taxEst = profile.tax ? estimateHousehold(payInputs, profile.tax) : null;
const taxRateOf = member => {
  if (!taxEst) return profile.humanCapital.effectiveTaxRate;
  const r = taxEst.rows.find(x => x.member === member);
  return r ? r.totalTax / Math.max(1, r.gross - r.incomeTaxPreTax) : profile.humanCapital.effectiveTaxRate; // tax per dollar of cash pay
};
// Bonus is taxed at the margin: household tax with vs. without it.
function bonusAfterTax(member) {
  const er = profile.humanCapital.earners.find(e => e.member === member);
  const bonus = er && er.streams.find(st => /bonus/i.test(st.id));
  if (!bonus || !taxEst) return null;
  const without = estimateHousehold(payInputs.map(p => p.member === member ? { ...p, gross: p.gross - bonus.annual } : p), profile.tax);
  return { gross: bonus.annual, tax: taxEst.totalTax - without.totalTax, net: bonus.annual - (taxEst.totalTax - without.totalTax) };
}
// Calibration: estimated vs. observed paychecks (base pay only, no bonus).
function calibration() {
  const out = [];
  for (const er of profile.humanCapital.earners.filter(e => e.observedNetPay)) {
    const bonus = er.streams.find(st => /bonus/i.test(st.id));
    const est = estimateHousehold(payInputs.map(p => p.member === er.member ? { ...p, gross: p.gross - (bonus ? bonus.annual : 0) } : p), profile.tax);
    const row = est.rows.find(r => r.member === er.member);
    const observed = er.observedNetPay.perPeriod * er.observedNetPay.periods;
    out.push({ member: er.member, estimated: row.takeHome, observed, gap: row.takeHome - observed, source: er.observedNetPay.source });
  }
  return out;
}
const calib = taxEst ? calibration() : [];

// ── Explicit balance sheet ──────────────────────────────────────────────────
const CLASS_BY_TYPE = {
  checking: 'cash', savings: 'cash', brokerage: 'investments', retirement: 'retirement',
  education: 'education', real_estate: 'home', credit: 'cards', mortgage: 'mortgage',
};
const lines = [];
for (const r of latest) {
  const meta = profile.accountMeta[r.account_id] || {};
  let cls = CLASS_BY_TYPE[r.account_type] || 'other';
  if (meta.taxType === 'business') cls = 'business';
  if (r.account_type === 'brokerage' && (meta.taxType === 'deferred' || meta.taxType === 'exempt')) cls = 'retirement';
  if (Math.abs(r.balance) < 1 && cls !== 'mortgage') continue; // dust and empty accounts
  lines.push({
    id: r.account_id, label: meta.label || r.account_name || r.account_id,
    last4: (r.account_id.match(/(\d{4}[A-Z]?)$/) || [])[1] || '',
    owner: meta.owner || 'unassigned', taxType: meta.taxType || 'taxable', cls,
    balance: r.balance, asOf: r.synced_at.slice(0, 10), source: `synced ${r.institution}`,
    synced: true, ageDays: daysOld(r.synced_at),
  });
}
for (const o of [...(profile.offSyncAccounts || []), ...(profile.manualAccounts || [])]) {
  const i = lines.findIndex(l => l.id === o.id);
  if (i >= 0) lines.splice(i, 1); // a manual entry with a synced account's id overrides it for this run
  lines.push({
    id: o.id, label: o.label, last4: '', owner: o.owner, taxType: o.taxType, cls: o.class,
    balance: o.balance, asOf: o.asOf || asOf, source: o.source || 'entered by hand', synced: false, ageDays: daysOld(o.asOf || asOf),
  });
}
const conv = profile.conventions;
const assetLines = lines.filter(l => l.balance > 0);
const liabLines = lines.filter(l => l.balance < 0);
const byClass = cls => sum(lines.filter(l => l.cls === cls).map(l => l.balance));
const explicitAssets = sum(assetLines.map(l => l.balance));
const explicitLiabs = -sum(liabLines.map(l => l.balance));
const netWorth = explicitAssets - explicitLiabs;

const deferredBal = sum(lines.filter(l => l.taxType === 'deferred').map(l => l.balance));
const deferredTax = deferredBal * conv.deferredAccountTaxRate;
const homeValue = byClass('home');
const homeSelling = homeValue * conv.homeSellingCost;
const netWorthAfterTax = netWorth - deferredTax - homeSelling;
const cash = byClass('cash');
const investable = byClass('investments') + byClass('retirement') + byClass('education');

// ── Human capital (implicit asset) ──────────────────────────────────────────
const retBase = profile.retirement.base;
function humanCapital({ retireAge = retBase, stopMember = null, stopAfterYears = null } = {}) {
  const out = [];
  for (const e of profile.humanCapital.earners) {
    const age0 = need(ageOf(e.member), `${e.member} birth year`);
    if (age0 == null) continue;
    let years = Math.max(0, retireAge - (primaryAge ?? age0));
    if (e.member === stopMember && stopAfterYears != null) years = Math.min(years, stopAfterYears);
    for (const s of e.streams) {
      let total = 0, factor = 1;
      for (let y = 0; y < years; y++) {
        const age = age0 + y;
        if (y > 0) factor *= 1 + (e.realGrowth.find(g => age <= g.toAge) || { rate: 0 }).rate;
        const gross = s.annual * factor;
        const net = s.id.includes('match') ? gross : gross * (1 - taxRateOf(e.member)); // match lands pre-tax in the 401(k)
        total += pv(net, s.discountReal, y + 0.5);
      }
      out.push({ member: e.member, id: s.id, label: s.label, years, rate: s.discountReal, pv: total, source: s.source, risk: s.risk });
    }
  }
  return out;
}

// ── Implicit liabilities ────────────────────────────────────────────────────
const sp = profile.spending;
const adultAges = profile.household.members.filter(m => m.role === 'adult').map(m => ageOf(m.id)).filter(a => a != null);
const youngestAdult = adultAges.length ? Math.min(...adultAges) : null;
const horizonYears = youngestAdult != null ? profile.retirement.planningHorizonAge - youngestAdult : null;

function annuityPV(amount, rate, years, startIn = 0) {
  let total = 0;
  for (let y = 0; y < years; y++) total += pv(amount, rate, startIn + y + 0.5);
  return total;
}
function implicitLiabs({ coreAdj = 0, retireAge = retBase } = {}) {
  const items = [];
  const r = sp.discountReal.essential;
  if (horizonYears != null) {
    items.push({ id: 'lifestyle', label: `Everyday spending, ${fmtK(coreSpend + coreAdj)}/yr for ${horizonYears} yrs (excl. mortgage and childcare)`, pv: annuityPV(coreSpend + coreAdj, r, horizonYears), rate: r, source: sp.lifestyleSource });
  } else missing.push('planning horizon (needs adult birth years)');
  items.push({ id: 'childcare', label: `Childcare, ${fmtK(childcareAnnual)}/yr for ${childcareYears} yrs`, pv: annuityPV(childcareAnnual, r, childcareYears), rate: r, source: ph.childcareSource || sp.childcare.source });
  if (mortSched.length) {
    const pvInt = mortSched.reduce((a, m) => a + (m.interest / Math.pow(1 + inflation, m.year)) / Math.pow(1 + r, m.year + 0.5), 0);
    items.push({ id: 'mortgage-interest', label: `Mortgage interest until payoff in ${mortSched.length} yrs (principal is on the debt side)`, pv: pvInt, rate: r, source: mortCfg.source });
  }
  const rows = spendRowsFor(retireAge);
  const pvHealth = rows.reduce((a, x) => a + x.health / Math.pow(1 + r, x.y + 0.5), 0);
  if (pvHealth > 0) items.push({ id: 'health', label: `Health insurance from retirement until Medicare`, pv: pvHealth, rate: r, source: ph.healthSource });
  for (const g of profile.goals.filter(g => g.annualOptions)) {
    const amt = g.annualOptions[g.selected];
    const gr = profile.goalDiscountReal[g.tier === 'essential' ? 'essential' : g.tier === 'important' ? 'important' : 'aspirational'];
    items.push({ id: g.id, label: `${g.label} (${g.selected}, $${Math.round(amt / 1000)}K/yr × ${g.years})`, pv: annuityPV(amt, gr, g.years, g.startsInYears), rate: gr, source: g.source, goal: g });
  }
  return items;
}

function extended(opts = {}) {
  const hc = humanCapital(opts);
  const il = implicitLiabs({ coreAdj: opts.coreAdj || 0, retireAge: opts.retireAge || retBase });
  const marketFactor = opts.marketShock != null ? 1 + opts.marketShock : 1;
  const assets = explicitAssets - investable * (1 - marketFactor) + sum(hc.map(h => h.pv));
  const liabs = explicitLiabs + deferredTax * marketFactor + homeSelling + sum(il.map(i => i.pv));
  return { hc, il, assets, liabs, surplus: assets - liabs };
}

// ── Monthly cash (actual, from synced transactions) ─────────────────────────
function monthlyCash(opts = {}) {
  const cf = profile.cashFlow;
  if (!cf) return null;
  if (manualOnly || cf.manual) { // hand-entered monthly figures: { inflows: {label: amt}, outflows: {category: amt} }
    const m = cf.manual || { inflows: {}, outflows: {} };
    const groups = (cf.groups || [{ label: 'Spending', categories: Object.keys(m.outflows) }]).map(g => ({ label: g.label, lines: g.categories.filter(c => m.outflows[c]).map(c => ({ cat: c, amount: m.outflows[c], note: (cf.lineNotes || {})[c] })) }))
      .filter(g => g.lines.length);
    const grouped = new Set(groups.flatMap(g => g.lines.map(l => l.cat)));
    const rest = Object.entries(m.outflows).filter(([c]) => !grouped.has(c)).map(([c, v]) => ({ cat: c, amount: v }));
    if (rest.length) groups.push({ label: 'Other', lines: rest });
    for (const g of groups) g.total = sum(g.lines.map(l => l.amount));
    const totalIn = sum(Object.values(m.inflows)), totalOut = sum(groups.map(g => g.total));
    return { from: 'entered', to: 'by hand', label: 'entered by hand', months: 1, inflows: m.inflows, estimatedInflows: {}, memo: {}, groups, totalIn, totalOut, net: totalIn - totalOut, oneOff: [], invisible: 'Monthly figures were entered by hand.' };
  }
  const end = new Date(`${asOf.slice(0, 7)}-01T00:00:00Z`); // first day of the statement month (exclusive)
  const start = new Date(end);
  if (opts.period) { // the statement period: since the last statement, or the last 3 full months
    if (previous && !scenario) { start.setTime(new Date(`${previous.asOf.slice(0, 7)}-01T00:00:00Z`).getTime()); if (start >= end) start.setUTCMonth(start.getUTCMonth() - 3); }
    else start.setUTCMonth(start.getUTCMonth() - 3);
  } else start.setUTCMonth(start.getUTCMonth() - (opts.months || cf.windowMonths || 6)); // planning basis
  let windowMonths = Math.max(1, Math.round((end - start) / (30.44 * 86400000)));
  const from = start.toISOString().slice(0, 10), to = end.toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT date, amount, description, COALESCE(NULLIF(user_category,''), category, 'Other') AS cat
    FROM transactions WHERE date >= ? AND date < ?`).all(from, to);
  // Only average over months that actually have data (e.g. an account linked mid-window)
  const firstTx = rows.reduce((a, r) => (r.date && (!a || r.date < a) ? r.date : a), null);
  if (firstTx && firstTx > from) { const f0 = new Date(`${firstTx.slice(0, 7)}-01T00:00:00Z`); windowMonths = Math.max(1, Math.round((end - f0) / (30.44 * 86400000))); }
  const has = (d, m) => d.toLowerCase().includes(m.toLowerCase());
  const inflow = {}, outflow = {}, oneOff = [], memo = {};
  for (const r of rows) {
    const d = r.description || '';
    if (cf.excludeOneOff.some(m => has(d, m))) { oneOff.push(r); continue; }
    let cat = r.cat;
    const re = cf.reclassify.find(x => has(d, x.match)); if (re) cat = re.as;
    if (cat === 'Transfer') {
      const st = cf.spendTransfers.find(x => has(d, x.match));
      if (!st || r.amount > 0) continue; // moves between our own accounts / card payoffs already itemized
      cat = st.as;
    }
    if (r.amount > 0 && cf.inflowCategories.includes(cat)) {
      const hit = cf.inflowLabels.find(x => has(d, x.match)) || { as: 'Other income' };
      if (hit.internal) { memo[hit.as] = (memo[hit.as] || 0) + r.amount; continue; }
      inflow[hit.as] = (inflow[hit.as] || 0) + r.amount;
    } else if (r.amount < 0 && cat !== 'Income') {
      outflow[cat] = (outflow[cat] || 0) - r.amount;
    } else if (r.amount < 0 && cat === 'Income') {
      outflow.Other = (outflow.Other || 0) - r.amount;
    } else if (r.amount > 0) {
      outflow[cat] = (outflow[cat] || 0) - r.amount; // refunds reduce that category
    }
  }
  const per = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v / windowMonths]));
  const inM = per(inflow), outM = per(outflow), memoM = per(memo);
  const estimated = {};
  for (const id of cf.estimatedInflows || []) {
    if (id.endsWith('-takehome') && taxEst) {
      const m = id.replace('-takehome', ''); const r = taxEst.rows.find(x => x.member === m);
      if (r) estimated[`${nameOf(m)}'s take-home (estimate)`] = r.takeHome / 12;
    }
    if (id.endsWith('-bonus')) {
      const b = bonusAfterTax(id.replace('-bonus', ''));
      if (b) estimated[`${nameOf(id.replace('-bonus', ''))}'s bonus after tax, averaged (estimate)`] = b.net / 12;
    }
  }
  const groups = cf.groups.map(g => ({ label: g.label, lines: g.categories.filter(c => outM[c] > 0.5).map(c => ({ cat: c, amount: outM[c], note: (cf.lineNotes || {})[c] })) }));
  const grouped = new Set(cf.groups.flatMap(g => g.categories));
  const other = Object.entries(outM).filter(([c, v]) => !grouped.has(c) && v > 0.5).map(([c, v]) => ({ cat: c, amount: v }));
  if (other.length) groups.push({ label: 'Other', lines: other });
  for (const g of groups) g.total = sum(g.lines.map(l => l.amount));
  const totalIn = sum(Object.values(inM)) + sum(Object.values(estimated)), totalOut = sum(groups.map(g => g.total));
  const M3 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d0 = new Date(end); d0.setUTCMonth(d0.getUTCMonth() - windowMonths); const d1 = new Date(end - 86400000);
  const label = `${M3[d0.getUTCMonth()]} 1${d0.getUTCFullYear() !== d1.getUTCFullYear() ? `, ${d0.getUTCFullYear()}` : ''} – ${M3[d1.getUTCMonth()]} ${d1.getUTCDate()}, ${d1.getUTCFullYear()} (${windowMonths} month${windowMonths === 1 ? '' : 's'})`;
  const short = `${M3[d0.getUTCMonth()]}${d0.getUTCFullYear() !== d1.getUTCFullYear() ? ` ${d0.getUTCFullYear()}` : ''}–${M3[d1.getUTCMonth()]} ${d1.getUTCFullYear()}`;
  return { from, to, label, short, months: windowMonths, inflows: inM, estimatedInflows: estimated, memo: memoM, groups: groups.filter(g => g.total > 0), totalIn, totalOut, net: totalIn - totalOut,
    oneOff: oneOff.map(r => ({ amount: r.amount, description: r.description })), invisible: cf.invisible };
}
const monthly = monthlyCash(); // planning basis: longer average, so seasonal costs (property tax, bonus) are in it
const monthlyPeriod = monthlyCash({ period: true }); // what happened in the statement period (reported flows)
let monthlyEssential = monthly && monthly.totalOut > 0 ? monthly.totalOut : (sp.lifestyleAfterTax + sp.childcare.annual) / 12;

// ── Phased spending (replaces one flat lifestyle number) ──────────────────────
const { solveMortgageRate, mortgageSchedule, spendingPath, simulateRetirement, safeSpend, educationPath, simulateHistory, mixToWeights } = require('./project');
const ph = sp.phased || {};
const catAnnual = c => monthly ? ((monthly.groups.flatMap(g => g.lines).find(l => l.cat === c) || { amount: 0 }).amount * 12) : 0;
const childcareAnnual = monthly ? catAnnual('Childcare') : sp.childcare.annual;
const childcareYears = ph.childcareYears ?? sp.childcare.years;
const coreVisible = monthly ? monthly.totalOut * 12 - catAnnual('Mortgage') - catAnnual('Childcare') : sp.lifestyleAfterTax;
const coreSpend = coreVisible + (ph.offSideAllowance || 0);
const mortCfg = profile.mortgage;
const mortLine = mortCfg && lines.find(l => l.id === mortCfg.account);
const mortBal = mortLine ? -mortLine.balance : 0;
const mortRate = mortLine ? (mortCfg.rate || solveMortgageRate(mortBal, mortCfg.payment, mortCfg.payoffMonths)) : 0;
const mortSched = mortLine ? mortgageSchedule(mortBal, mortCfg.payment, mortRate) : [];
const inflation = ph.inflation ?? 0.024;
const primaryId = profile.retirement.primaryMember || profile.household.members.find(m => m.role === 'adult').id;
const primaryAge = ageOf(primaryId);
const primaryExact = (profile.household.members.find(m => m.id === primaryId) || {}).exactAge ?? primaryAge;
const mortMonths = mortLine ? (() => { let b = mortBal, m = 0; const i = mortRate / 12; while (b > 0.01 && m < 1200) { b = b * (1 + i) - mortCfg.payment; m++; } return m; })() : 0;
const adultsAges = profile.household.members.filter(m => m.role === 'adult').map(m => ({ id: m.id, age0: ageOf(m.id) }));
const retireYearFor = age => Math.max(0, age - primaryAge);
function spendRowsFor(retireAge, coreAdj = 0) {
  return spendingPath({ years: horizonYears, core: coreSpend + coreAdj, childcare: childcareAnnual, childcareYears, mortgageSched: mortSched,
    inflation, healthPerPerson: ph.healthPerPersonPreMedicare || 0, adults: adultsAges, retireYear: retireYearFor(retireAge), medicareAge: ph.medicareAge || 65 });
}

const base = extended();

// ── Goals & funding (priority order: each goal claims what's left) ─────────
const goalRows = base.il.map(i => ({ ...i }));
// Education goals are first funded by their dedicated accounts.
for (const g of goalRows.filter(r => r.goal)) {
  const dedicated = sum(lines.filter(l => (g.goal.fundedBy || []).includes(l.id)).map(l => l.balance));
  g.dedicated = dedicated;
  g.fundedPct = g.pv ? Math.min(1, dedicated / g.pv) : 0;
}

// ── Liquidity ───────────────────────────────────────────────────────────────


// ── Cash-flow reconciliation: does take-home minus known uses tie out? ─────
const grossPay = sum(profile.humanCapital.earners.flatMap(er => er.streams.filter(st => !st.id.includes('match')).map(st => st.annual)));
const takeHome = taxEst ? taxEst.takeHome : grossPay * (1 - profile.humanCapital.effectiveTaxRate) - sp.contributionsFromPay;
const unaccounted = takeHome - (monthly ? monthly.totalOut * 12 : sp.lifestyleAfterTax + sp.childcare.annual) - (ph.offSideAllowance || 0);
const runwayMonths = cash / monthlyEssential;
const ef = profile.protection.emergencyFund;
const efBal = (lines.find(l => l.id === ef.account) || {}).balance || 0;

const scen = profile.careerScenarios;
// ── Monthly action plan: what each goal needs, per month ───────────────────
function actionPlan() {
  const pl = profile.plan; if (!pl) return null;
  const R = pl.expectedRealReturn;
  const mrate = r => Math.pow(1 + r, 1 / 12) - 1;
  const fv = (pvAmt, r, years) => pvAmt * Math.pow(1 + r, years);
  // monthly payment that grows a fund to `target` in `months` at real rate r
  const pmt = (target, r, months) => { const i = mrate(r); return months <= 0 ? target : target * i / (Math.pow(1 + i, months) - 1); };
  const items = [];

  // Education goals
  for (const g of profile.goals.filter(x => x.annualOptions)) {
    const r = R.education, annual = g.annualOptions[g.selected];
    let need = 0; for (let y = 0; y < g.years; y++) need += annual / Math.pow(1 + r, y); // value at start of college
    const have = sum(lines.filter(l => (g.fundedBy || []).includes(l.id)).map(l => l.balance));
    const months = g.startsInYears * 12;
    const gap = Math.max(0, need - fv(have, r, g.startsInYears));
    const monthlyAmt = pmt(gap, r, months);
    items.push({ id: g.id, goal: g.label, kind: 'education', target: need, have, months, monthly: monthlyAmt,
      status: have ? 'on its way' : 'account not opened', how: have ? 'Add to the existing 529' : 'Open a 529, then automate this monthly',
      basis: `${g.selected} ${fmtK(annual)}/yr × ${g.years}, starting ${g.startsOn ? fmtYm(g.startsOn) : addYears(g.startsInYears)}; ${pct(r)} real return` });
  }

  // Retirement
  const wAge = ageOf((scen.B && scen.B.member) || profile.household.members.find(m => m.role === 'adult').id);
  if (wAge != null) {
    const yrsTo = retBase - wAge, yrsIn = profile.retirement.planningHorizonAge - retBase;
    const spendPreTax = coreSpend / (1 - pl.retirementTaxRate);
    let need = 0; for (let y = 0; y < yrsIn; y++) need += spendPreTax / Math.pow(1 + R.retirementDrawdown, y);
    const have = sum(lines.filter(l => pl.retirementAccounts.includes(l.id)).map(l => l.balance));
    const contrib = sum(pl.retirementContributions.map(c => c.annual));
    const a = R.retirementAccumulation;
    const projected = fv(have, a, yrsTo) + contrib * ((Math.pow(1 + a, yrsTo) - 1) / a);
    const gap = need - projected;
    items.push({ id: 'retirement', goal: `Retire at ${retBase}, spending ${fmtK(sp.lifestyleAfterTax)}/yr after tax to ${profile.retirement.planningHorizonAge}`, kind: 'retirement',
      target: need, have, projected, contrib, months: yrsTo * 12,
      monthly: gap > 0 ? pmt(gap, a, yrsTo * 12) : 0, surplusAt: gap < 0 ? -gap : 0,
      status: gap <= 0 ? 'on track with current contributions' : 'short', how: gap <= 0 ? `Keep current contributions (${fmtK(contrib / 12)}/mo, already taken from pay)` : 'Raise contributions by this much',
      basis: `need ${fmtK(need)} at ${retBase} (${pct(R.retirementDrawdown)} real in retirement, ${pct(pl.retirementTaxRate)} tax on withdrawals); have ${fmtK(have)} + ${fmtK(contrib)}/yr at ${pct(a)} real → ${fmtK(projected)}. No Social Security or pension counted.` });
  }

  // Emergency fund
  const efTarget = pl.emergencyFundMonths * monthlyEssential;
  const efGap = Math.max(0, efTarget - efBal);
  items.push({ id: 'emergency', goal: `Emergency fund: ${pl.emergencyFundMonths} months of cash out`, kind: 'reserve', target: efTarget, have: efBal,
    monthly: efGap > efTarget * 0.1 ? efGap / 12 : 0, status: efGap > efTarget * 0.1 ? 'below target' : 'funded',
    how: efGap > efTarget * 0.1 ? `Top up ${fmtK(efGap)} over 12 months` : efGap > 0 ? `Within 10% of target. Top up ${fmtK(efGap)} when convenient.` : 'Nothing needed; keep it there', basis: `${pl.emergencyFundMonths} × ${fmtK(monthlyEssential)}/mo actual cash out` });

  // Sinking funds (already in cash out)
  for (const f of pl.sinkingFunds || []) items.push({ id: 'sink-' + f.label, goal: f.label, kind: 'sinking', target: f.annual, monthly: f.annual / 12, inCashOut: true, status: 'set aside monthly', how: 'Set aside monthly so the installments are never a surprise', basis: f.note || '' });

  // Lump sum by a date: sinking fund at a horizon-appropriate return
  for (const g of profile.goals.filter(x => x.type === 'lumpSum')) {
    const r = g.inYears <= 3 ? R.cash : g.inYears <= 7 ? (R.cash + R.education) / 2 : R.education;
    const have = sum(lines.filter(l => (g.fundedBy || []).includes(l.id)).map(l => l.balance));
    const months = g.inYears * 12;
    const gap = Math.max(0, g.amount - fv(have, r, g.inYears));
    const delays = [1, 2].filter(d => d < g.inYears).map(d => ({ years: d, monthly: pmt(gap, r, months - d * 12) }));
    items.push({ id: g.id, goal: g.label, kind: 'lumpSum', target: g.amount, have, months, monthly: pmt(gap, r, months), delays, rate: r,
      status: gap <= 0 ? 'funded' : have > 0 ? 'on its way' : 'not started', how: gap <= 0 ? 'Nothing needed' : `Set aside monthly${g.inYears <= 3 ? ' in cash' : ''}`,
      basis: `${fmt(g.amount)} by ${g.by ? fmtYm(g.by) : addYears(g.inYears)}; ${pct(r)} real return${g.inYears <= 3 ? ' (cash, short horizon)' : ''}` });
  }
  // Debt payoff by a date: amortization with the current payment vs the payment needed
  for (const g of profile.goals.filter(x => x.type === 'debtPayoff')) {
    const line = lines.find(l => l.id === g.account); if (!line) continue;
    const bal = -line.balance;
    let derivedMort = null;
    try { const d = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'derived.json'), 'utf8')); derivedMort = d.mortgage && d.mortgage.account === g.account ? d.mortgage : null; } catch { /* no derive output */ }
    const payNow = g.payment || (mortCfg && mortCfg.account === g.account ? mortCfg.payment : null) || (derivedMort && derivedMort.payment);
    const rate = g.rate || (mortCfg && mortCfg.account === g.account ? mortRate : null);
    if (!payNow || !rate) { missing.push(`${g.label}: needs the payment and rate`); continue; }
    const i = rate / 12;
    const amort = p => { let b = bal, m = 0, interest = 0; while (b > 0.01 && m < 1200) { const it = b * i; interest += it; b = b + it - p; m++; } return { months: m, interest }; };
    const targetMonths = g.targetAge != null && primaryAge != null ? (g.targetAge - primaryAge) * 12 : (g.inYears || 0) * 12;
    const need = i * bal / (1 - Math.pow(1 + i, -targetMonths));
    const now = amort(payNow);
    const sched = g.scheduledPayment ? amort(g.scheduledPayment) : null;
    const extraNeeded = Math.max(0, need - payNow);
    items.push({ id: g.id, goal: g.label, kind: 'debt', target: targetMonths, have: bal, months: targetMonths, monthly: extraNeeded,
      status: now.months <= targetMonths ? 'on pace' : 'behind', payNow, need, rate, now, sched,
      how: now.months <= targetMonths ? `Keep paying ${fmt(payNow)}/mo` : `Raise the payment to ${fmt(need)}/mo`,
      basis: `${fmt(bal)} at ~${pct(rate)}; at ${fmt(payNow)}/mo it's paid off in ${(now.months / 12).toFixed(1)} yrs`, inCashOut: now.months <= targetMonths });
  }
  const newMonthly = sum(items.filter(i => !i.inCashOut && i.kind !== 'retirement').map(i => i.monthly)) + sum(items.filter(i => i.kind === 'retirement').map(i => i.monthly));
  const leftBefore = monthly ? monthly.net : null;
  return { items, newMonthly, leftBefore, leftAfter: leftBefore != null ? leftBefore - newMonthly : null };
}
const plan = actionPlan();

// ── Projection: retirement portfolio (Monte Carlo), 529s, cash, home equity ──
function projection() {
  const rc = profile.retirement;
  if (primaryAge == null) return null;
  if (!rc.accounts) { // default: every tax-deferred / Roth account, returns from the derived holdings mix
    rc.accounts = lines.filter(l => l.cls === 'retirement' && l.balance > 0).map(l => ({ id: l.id }));
    const derivedPath = path.join(PFS_DIR, 'derived.json');
    const derived = fs.existsSync(derivedPath) ? JSON.parse(fs.readFileSync(derivedPath, 'utf8')) : { accounts: [] };
    const fb = packJson('capital-markets.json').classes[packJson('capital-markets.json').unknownAccountMix.class];
    for (const a of rc.accounts) { const d = derived.accounts.find(x => x.id === a.id); a.mu = d?.realReturn ?? fb.realReturn; a.sigma = d?.vol ?? fb.vol; a.source = d?.mixSource || 'assumptions pack'; }
    if (rc.accounts.length) rc.accounts[0].contribShare = 1;
    assumptionsUsed.push('retirement accounts (all tax-advantaged)');
  }
  if (!rc.accounts.length) return null;
  if (!rc.scenarios) rc.scenarios = packJson('household.json').retirement.defaultScenarios.map(d => rc.base + d);
  const years = rc.planningHorizonAge - primaryAge; // chart runs on the primary member's age
  const accts = rc.accounts.map(a => ({ ...a, balance: (lines.find(l => l.id === a.id) || { balance: 0 }).balance }));
  const contributions = sum((profile.plan.retirementContributions || []).map(c => c.annual));
  const tax = profile.plan.retirementTaxRate;
  const target = rc.successTarget || 0.9;
  const withdrawalsFor = (retireAge, flatSpend = null) => {
    const rows = spendRowsFor(retireAge); const ry = retireYearFor(retireAge);
    return Array.from({ length: years }, (_, y) => y < ry ? 0 : ((flatSpend != null ? flatSpend + (rows[y] ? rows[y].health : 0) : (rows[y] ? rows[y].total : coreSpend)) / (1 - tax)));
  };
  const runFor = age => simulateRetirement({ accounts: accts, contributions, retireYear: retireYearFor(age), withdrawals: withdrawalsFor(age), years });
  const scenarios = {};
  for (const age of rc.scenarios) scenarios[age] = runFor(age);
  const baseSim = scenarios[retBase];
  const ry = retireYearFor(retBase);
  const safe = safeSpend({ sim: simulateRetirement, base: { accounts: accts, contributions, retireYear: ry, years }, toWithdrawals: sp2 => withdrawalsFor(retBase, sp2), target });
  // If today's contributions fall short of the target, find the extra yearly saving that reaches it.
  let extraNeeded = 0;
  if (baseSim.success < target && ry > 0) {
    let lo = 0, hi = 200000;
    const ok = extra => simulateRetirement({ accounts: accts, contributions: contributions + extra, retireYear: ry, withdrawals: withdrawalsFor(retBase), years, paths: 1500 }).success >= target;
    if (ok(hi)) { for (let i = 0; i < 16; i++) { const mid = (lo + hi) / 2; if (ok(mid)) hi = mid; else lo = mid; } extraNeeded = hi; } else extraNeeded = null; // not reachable by saving alone
  }
  // conservative run: returns 2 pts/yr lower than assumed
  const conservative = simulateRetirement({ accounts: accts, contributions, retireYear: ry, withdrawals: withdrawalsFor(retBase), years, muShift: -0.02 });
  // 529s
  const eduGoals = (plan ? plan.items.filter(i => i.kind === 'education') : []).map(i => {
    const g = profile.goals.find(x => x.id === i.id);
    return { id: i.id, have: i.have, monthly: i.monthly, startsInYears: g.startsInYears, years: g.years, annual: g.annualOptions[g.selected] };
  });
  const education = educationPath({ goals: eduGoals, years, rate: profile.plan.expectedRealReturn.education });
  const cashPath = Array.from({ length: years + 1 }, (_, y) => cash * Math.pow(1 + profile.plan.expectedRealReturn.cash, y));
  const homeEq = Array.from({ length: years + 1 }, (_, y) => {
    const mb = y === 0 ? mortBal : (mortSched[y - 1] ? mortSched[y - 1].endBalance : 0);
    return homeValue - mb / Math.pow(1 + inflation, y);
  });
  const spendRows = spendRowsFor(retBase);
  let crossCheck = null;
  const marketPath = path.join(PFS_DIR, 'market.json');
  const useFile = rc.crossCheck && rc.crossCheck.file && fs.existsSync(path.join(ROOT, rc.crossCheck.file));
  if (!useFile && fs.existsSync(marketPath)) {
    // In-house "history, trimmed": replay 1928+ real returns with stocks cut 2 pts/yr
    const market = JSON.parse(fs.readFileSync(marketPath, 'utf8'));
    let derived = { accounts: [] };
    try { derived = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'derived.json'), 'utf8')); } catch { /* none */ }
    const hAccts = accts.map(a => { const d = derived.accounts.find(x => x.id === a.id); return { ...a, weights: (d && d.weights) || mixToWeights({ 'target-date': 1 }) }; });
    const trim = rc.historyTrim ?? 0.02;
    const h = simulateHistory({ accounts: hAccts, contributions, retireYear: ry, withdrawals: withdrawalsFor(retBase), years, history: market.history, trim });
    const yrs = `${market.history[0].year}–${market.history[market.history.length - 1].year}`;
    crossCheck = { label: `History, trimmed (${yrs} replay)`, success: h.success, p10: h.p10, p50: h.p50, p90: h.p90,
      note: `Replays real annual returns from ${yrs} in random 5-year runs (3,000 paths), with stock returns cut ${(trim * 100).toFixed(0)} pts/yr. Each account follows its own stock / bond / cash mix. Sources: Damodaran (NYU Stern) annual returns; FRED CPI.` };
  } else if (useFile) {
    const rowsCsv = fs.readFileSync(path.join(ROOT, rc.crossCheck.file), 'utf8').split('\n').filter(l => l && !l.startsWith('"#') && !l.startsWith('#'));
    const head = rowsCsv[0].split(','); const col = k => head.indexOf(rc.crossCheck[k]);
    const byAge = {}; for (const l of rowsCsv.slice(1)) { const c = l.split(','); byAge[+c[head.indexOf(rc.crossCheck.ageColumn)]] = c; }
    const series = k => Array.from({ length: years + 1 }, (_, y) => { const c = byAge[primaryAge + y]; return c ? +c[col(k)] : NaN; });
    crossCheck = { label: rc.crossCheck.label, note: rc.crossCheck.note, success: rc.crossCheck.success, p10: series('p10'), p50: series('p50'), p90: series('p90') };
  }
  return { crossCheck,
    years, startAge: primaryAge, retireAge: retBase, retireYear: ry, contributions, tax,
    scenarios: Object.fromEntries(Object.entries(scenarios).map(([a, r]) => [a, { p10: r.p10, p50: r.p50, p90: r.p90, success: r.success }])),
    conservativeSuccess: conservative.success, safeSpendYear: safe, target, extraNeeded,
    retirementSpend: { core: coreSpend, firstYear: spendRows[ry] ? spendRows[ry].total : coreSpend },
    education, cash: cashPath, homeEquity: homeEq,
    phases: [
      { label: 'Today', spend: spendRows[0].total, detail: 'everything, incl. mortgage and childcare' },
      { label: `Childcare ends (${addYears(childcareYears)})`, spend: (spendRows[childcareYears] || spendRows[0]).total, detail: 'mortgage still running' },
      { label: `Mortgage paid off (${addYears(mortMonths / 12)})`, spend: (spendRows[mortSched.length] || spendRows[0]).total, detail: 'core spending only' },
      { label: `Retired at ${retBase}`, spend: spendRows[ry] ? spendRows[ry].total : coreSpend, detail: 'core + health insurance until Medicare' },
    ],
    accounts: accts.map(a => ({ id: a.id, balance: a.balance, mu: a.mu, sigma: a.sigma, source: a.source })),
    mortgage: { rate: mortRate, payoffYears: mortSched.length, balance: mortBal },
  };
}
const proj = projection();
// ── Today's path vs. the plan (same markets, habits unchanged) ─────────────
function statusQuo() {
  if (!plan || !proj) return null;
  const r = profile.plan.expectedRealReturn.education;
  const mrate = Math.pow(1 + r, 1 / 12) - 1;
  const pmt = (target, months) => months <= 0 ? target : target * mrate / (Math.pow(1 + mrate, months) - 1);
  const edu = plan.items.filter(i => i.kind === 'education').map(i => {
    const g = profile.goals.find(x => x.id === i.id);
    const atStartToday = i.have * Math.pow(1 + r, g.startsInYears);
    const delays = [1, 2, 4].map(d => {
      const months = (g.startsInYears - d) * 12;
      const gap = Math.max(0, i.target - i.have * Math.pow(1 + r, g.startsInYears));
      return { years: d, monthly: pmt(gap, months) };
    });
    return { id: i.id, label: g.label, need: i.target, todayAtStart: atStartToday, todayPct: Math.min(1, atStartToday / i.target),
      shortfall: Math.max(0, i.target - atStartToday), planMonthly: i.monthly, startsInYears: g.startsInYears, delays };
  });
  const b = proj.scenarios[retBase], ry = proj.retireYear;
  const retire = { p50: b.p50[ry], success: b.success, safe: proj.safeSpendYear };
  const est = profile.protection.estateDocs;
  return {
    edu, retire, totalShortfall: sum(edu.map(e => e.shortfall)), planMonthly: plan.newMonthly,
    estate: { today: [est.will, est.guardianship, est.beneficiaries].every(x => /not started/i.test(x)) ? 'No will, no named guardian, beneficiaries unchecked' : 'Partly in place', plan: 'Wills, guardian named, beneficiaries checked' },
    leftoverToday: monthly ? monthly.net : null, leftoverPlan: plan.leftAfter,
  };
}
const sq = statusQuo();

// The plan's retirement row now comes from the simulation, not a single-path formula.
if (plan && proj) {
  const it = plan.items.find(i => i.kind === 'retirement');
  const b = proj.scenarios[retBase];
  if (it) Object.assign(it, {
    goal: `Retire at ${retBase}, spending ${fmtK(proj.retirementSpend.core)}/yr after tax (+ health until Medicare) to ${profile.retirement.planningHorizonAge}`,
    status: b.success >= proj.target ? `on track: lasts to ${profile.retirement.planningHorizonAge} in ${Math.round(b.success * 100)}% of markets` : `short: lasts in ${Math.round(b.success * 100)}%`,
    monthly: proj.extraNeeded ? proj.extraNeeded / 12 : 0,
    how: b.success >= proj.target ? `Keep current contributions (${fmtK(proj.contributions / 12)}/mo, already taken from pay)` : proj.extraNeeded != null ? `Save ${fmt(proj.extraNeeded / 12)}/mo more for retirement, on top of today's ${fmtK(proj.contributions / 12)}/mo` : 'Saving more alone won\'t reach the target; retire later or spend less',
    basis: `${fmtK(sum(proj.accounts.map(a => a.balance)))} today + ${fmtK(proj.contributions)}/yr → typical ${fmtK(b.p50[proj.retireYear])} at ${retBase}. Safe spend about ${fmtK(proj.safeSpendYear / 12)}/mo after tax. No Social Security or pension counted.`,
  });
}

// ── What-ifs ────────────────────────────────────────────────────────────────
const whatIfs = [
  { id: 'base', label: `Base: both work to ${retBase}`, r: base },
  ...profile.retirement.scenarios.filter(a => a !== retBase).map(a => ({ id: `retire-${a}`, label: `Both retire at ${a}`, r: extended({ retireAge: a }) })),
  ...(scen.B && scen.B.member ? (scen.B.stopsAfterYears != null ? [scen.B.stopsAfterYears] : [5, 10]).map(n => ({ id: `${scen.B.member}-stops-${n}`, label: `${nameOf(scen.B.member)} leaves salaried work in ${n} yrs (${scen.sideIncomeLabel || 'side income'} at $0)`, r: extended({ stopMember: scen.B.member, stopAfterYears: n }), illustrative: scen.B.stopsAfterYears == null })) : []),
  { id: 'market-30', label: 'Markets fall 30% (investments, retirement, 529)', r: extended({ marketShock: -0.30 }) },
  { id: 'spend-110', label: 'Everyday spending runs 10% higher', r: extended({ coreAdj: coreSpend * 0.10 }) },
  ...(unaccounted > 0 ? [{ id: 'spend-all', label: `The unaccounted ${fmtK(unaccounted)}/yr is spent, not saved`, r: extended({ coreAdj: unaccounted }) }] : []),
];

// Re-total the plan now that retirement may need extra saving
if (plan) {
  plan.newMonthly = sum(plan.items.filter(i => !i.inCashOut).map(i => i.monthly || 0));
  if (plan.leftBefore != null) plan.leftAfter = plan.leftBefore - plan.newMonthly;
}

// ── Goals model: one record per goal, same fields for every goal type ───────
function goalModel() {
  const out = [];
  const P = proj, Q = sq;
  const tierOrder = { essential: 0, important: 1, aspirational: 2 };
  if (P) {
    const b = P.scenarios[retBase];
    out.push({ id: 'retirement', type: 'retirement', label: `Retire at ${retBase}`, tier: 'essential', tick: P.target,
      caption: `Lasts to ${profile.retirement.planningHorizonAge} in ${Math.round(b.success * 100)}% of markets; target ${Math.round(P.target * 100)}%`,
      facts: [[`Today`, `lasts to ${profile.retirement.planningHorizonAge} in ${Math.round(b.success * 100)}% of markets (target ${Math.round(P.target * 100)}%)`],
        [`Each month`, b.success >= P.target ? `keep today's ${fmt(P.contributions / 12)}` : P.extraNeeded != null ? `${fmt(P.extraNeeded / 12)} more on top of today's ${fmt(P.contributions / 12)}` : `retire later or spend less`],
        [`Retire earlier or later`, Object.entries(P.scenarios).filter(([a]) => +a !== retBase).map(([a, r]) => `${a}: ${Math.round(r.success * 100)}%`).join(' · ')]],
      what: `Stop working at ${retBase} and spend ${fmt(P.retirementSpend.core / 12)}/mo after tax (today's dollars), plus health insurance until Medicare, through age ${profile.retirement.planningHorizonAge}.`,
      when: horizon(retBase - primaryExact), target: P.retirementSpend.core,
      today: { text: `Lasts to ${profile.retirement.planningHorizonAge} in ${Math.round(b.success * 100)}% of markets`, pct: b.success, ok: b.success >= P.target },
      plan: b.success >= P.target ? { text: 'Same. Current contributions already carry it.', pct: b.success, ok: true }
        : P.extraNeeded != null ? { text: `Lasts in ${Math.round(P.target * 100)}% of markets with ${fmt(P.extraNeeded / 12)}/mo more saved`, pct: P.target, ok: true }
        : { text: 'Saving more alone won\'t get there. Retire later or spend less.', pct: b.success, ok: false },
      action: b.success >= P.target ? { monthly: 0, text: `Keep contributing ${fmt(P.contributions / 12)}/mo (already taken from pay).` }
        : { monthly: P.extraNeeded ? P.extraNeeded / 12 : 0, text: P.extraNeeded != null ? `Save ${fmt(P.extraNeeded / 12)}/mo more for retirement, on top of today's ${fmt(P.contributions / 12)}/mo.` : 'Retire later or plan to spend less.' },
      waiting: Object.entries(P.scenarios).filter(([a]) => +a !== retBase).map(([a, r]) => ({ label: `Retire at ${a}`, value: `${Math.round(r.success * 100)}% of markets` })),
      confidence: `${Math.round(b.success * 100)}% of markets with forward assumptions; ${Math.round(P.conservativeSuccess * 100)}% if returns run 2 pts lower${P.crossCheck ? `; ${Math.round(P.crossCheck.success * 1000) / 10}% with history, trimmed` : ''}. Safe spend ${fmt(P.safeSpendYear / 12)}/mo.` });
  }
  const efItem = plan && plan.items.find(i => i.id === 'emergency');
  if (efItem) {
    const pctEf = efItem.target ? Math.min(1, efItem.have / efItem.target) : 1;
    out.push({ id: 'emergency', type: 'emergency', label: 'Emergency fund', tier: 'essential',
      caption: `${fmt(efItem.have)} of ${fmt(efItem.target)}`,
      facts: [[`Today`, `${fmt(efItem.have)} (${Math.round(pctEf * 100)}%)`], [`Each month`, efItem.monthly ? `${fmt(efItem.monthly)} for 12 months` : 'nothing needed'], [`Markets`, 'held in cash']],
      what: `${profile.plan.emergencyFundMonths} months of actual cash out (${fmt(efItem.target)}), kept in cash.`, when: 'now', target: efItem.target,
      today: { text: `${fmt(efItem.have)} (${Math.round(pctEf * 100)}%)`, pct: pctEf, ok: efItem.status === 'funded' },
      plan: { text: efItem.status === 'funded' ? 'Funded' : `Funded within 12 months`, pct: 1, ok: true },
      action: { monthly: efItem.monthly, text: efItem.how }, waiting: [], confidence: 'Held in cash, so markets don\'t touch it.' });
  }
  for (const e of (Q ? Q.edu : [])) {
    const g = profile.goals.find(x => x.id === e.id);
    out.push({ id: e.id, type: 'education', label: e.label, tier: g.tier || 'important',
      caption: e.todayAtStart > 0 ? `On today's habits: ${Math.round(e.todayPct * 100)}% by the start (${fmt(e.shortfall)} short)` : `No 529 yet: 0% (${fmt(e.shortfall)} short)`,
      facts: [[`Today`, e.todayAtStart > 0 ? `${fmt(e.todayAtStart)} by then (${Math.round(e.todayPct * 100)}%)` : 'no 529 yet (0%)'], [`Each month`, `${fmt(e.planMonthly)} into ${e.todayAtStart > 0 ? 'the 529' : 'a new 529'}`], [`If we wait`, e.delays.slice(0, 2).map(d => `${d.years} yr ${fmt(d.monthly)}`).join(' · ')]],
      what: `${g.selected}: ${fmt(g.annualOptions[g.selected])}/yr for ${g.years} years, starting ${g.startsOn ? fmtYm(g.startsOn) : addYears(g.startsInYears)} (${fmt(e.need)} needed then).`,
      when: horizon(g.startsInYears, g.startsOn), target: e.need,
      today: { text: `${fmt(e.todayAtStart)} saved by then (${Math.round(e.todayPct * 100)}%). Short ${fmt(e.shortfall)}.`, pct: e.todayPct, ok: e.shortfall <= 0 },
      plan: { text: 'Fully funded', pct: 1, ok: true },
      action: { monthly: e.planMonthly, text: `${fmt(e.planMonthly)}/mo into ${e.todayAtStart > 0 ? 'the existing 529' : 'a new 529 (open one first)'}.` },
      waiting: e.delays.map(d => ({ label: `Start in ${d.years} yr${d.years > 1 ? 's' : ''}`, value: `${fmt(d.monthly)}/mo` })),
      confidence: `Assumes ${pct(profile.plan.expectedRealReturn.education)} a year of real growth and ${g.selected} cost of ${fmt(g.annualOptions[g.selected])}/yr. Other choices: ${Object.entries(g.annualOptions).filter(([k]) => k !== g.selected).map(([k, v]) => `${k} ${fmt(v)}/yr`).join(', ')}.` });
  }
  for (const it of (plan ? plan.items.filter(i => i.kind === 'lumpSum') : [])) {
    const g = profile.goals.find(x => x.id === it.id);
    const todayAt = it.have * Math.pow(1 + it.rate, g.inYears), pctT = g.amount ? Math.min(1, todayAt / g.amount) : 1;
    out.push({ id: g.id, type: 'lumpSum', label: g.label, tier: g.tier || 'want',
      caption: it.have > 0 ? `${fmt(todayAt)} by then (${Math.round(pctT * 100)}%)` : `Nothing set aside yet (${fmt(g.amount)} short)`,
      facts: [[`Today`, it.have > 0 ? `${fmt(todayAt)} by then` : 'nothing set aside'], [`Each month`, `${fmt(it.monthly)}${g.inYears <= 3 ? ', kept in cash' : ''}`], [`If we wait`, it.delays.slice(0, 1).map(d => `${d.years} yr ${fmt(d.monthly)}`).join(' · ') || '—']], what: `${fmt(g.amount)} (today's dollars) by ${g.by ? fmtYm(g.by) : addYears(g.inYears)}.`, when: horizon(g.inYears, g.by), target: g.amount,
      today: { text: `${fmt(todayAt)} by then (${Math.round(pctT * 100)}%)${pctT < 1 ? `. Short ${fmt(g.amount - todayAt)}.` : ''}`, pct: pctT, ok: pctT >= 1 },
      plan: { text: 'Fully funded', pct: 1, ok: true }, action: { monthly: it.monthly, text: `${fmt(it.monthly)}/mo, ${g.inYears <= 3 ? 'kept in cash' : 'invested moderately'}.` },
      waiting: it.delays.map(d => ({ label: `Start in ${d.years} yr${d.years > 1 ? 's' : ''}`, value: `${fmt(d.monthly)}/mo` })), confidence: `Assumes ${pct(it.rate)} a year of real growth.` });
  }
  for (const it of (plan ? plan.items.filter(i => i.kind === 'debt') : [])) {
    const g = profile.goals.find(x => x.id === it.id);
    const yrs = m => (m / 12).toFixed(1);
    const onPace = it.status === 'on pace';
    const waiting = [];
    if (it.sched) waiting.push({ label: 'Without the extra principal', value: `paid off in ${yrs(it.sched.months)} yrs, ${fmt(it.sched.interest - it.now.interest)} more interest` });
    out.push({ id: g.id, type: 'debt', label: g.label, tier: g.tier || 'important',
      caption: `Paid off ${addYears(it.now.months / 12)} (age ${frac(primaryExact + it.now.months / 12)}) at today's payment`,
      facts: [[`Today's payment`, `paid off ${addYears(it.now.months / 12)} (age ${frac(primaryExact + it.now.months / 12)})`], [`Each month`, onPace ? `keep paying ${fmt(it.payNow)}` : `${fmt(it.monthly)} extra principal`], [`Interest to go`, fmt(it.now.interest)]],
      what: `Pay off ${fmt(it.have)} at ~${pct(it.rate)} ${g.targetAge != null ? `by ${nameOf(primaryId)}'s ${g.targetAge}th birthday (${addYears(g.targetAge - primaryExact)})` : `in ${g.inYears} years`}.`, when: g.targetAge != null ? `by age ${g.targetAge}, ${addYears(g.targetAge - primaryExact)}` : horizon(g.inYears), target: it.target,
      today: { text: `Paid off in ${yrs(it.now.months)} yrs at ${fmt(it.payNow)}/mo; ${fmt(it.now.interest)} interest to go`, pct: Math.min(1, it.target / it.now.months), ok: onPace },
      plan: { text: onPace ? 'Same. Already on pace.' : `On pace at ${fmt(it.need)}/mo`, pct: 1, ok: true },
      action: { monthly: onPace ? 0 : it.monthly, text: it.how + '.' }, waiting, confidence: 'Fixed-rate debt: no market risk. Paying it down earns the loan rate, guaranteed.' });
  }
  for (const g of out) g.short = g.type === 'retirement' ? 'retirement' : g.type === 'emergency' ? 'the emergency fund'
    : g.type === 'education' ? g.label.replace(/^College, (.*)$/i, 'college for the $1').toLowerCase()
    : g.type === 'debt' ? `paying off ${g.label.replace(/ paid off$/i, '').toLowerCase().replace(/^(?!the )/, 'the ')}`
    : g.label.charAt(0).toLowerCase() + g.label.slice(1);
  return out.sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
}
function esc0(x) { return String(x ?? ''); }
const goalsOut = goalModel();

// ── Staleness ───────────────────────────────────────────────────────────────
const stale = [
  ...lines.filter(l => l.ageDays > 7).map(l => `${l.label}: ${l.synced ? 'last synced' : 'stated'} ${l.asOf} (${l.ageDays} days old)`),
];
for (const st of syncStatus) {
  const lastOk = st.last_success ? daysOld(st.last_success) : null;
  if (lastOk != null && lastOk > 3) stale.push(`${st.institution}: last successful sync ${st.last_success.slice(0, 10)} (${lastOk} days ago).`);
}
if (Array.isArray(profile.knownIssues)) stale.push(...profile.knownIssues);


// ── Quarterly review: what changed, and did we do the plan? ────────────────
function quarterlyReview() {
  if (!previous || scenario) return null;
  const P = previous, from = P.asOf;
  const days = Math.max(1, (new Date(asOf) - new Date(from)) / 86400000), months = days / 30.44;
  // Net worth change by where it happened
  const byCls = (snap, classes) => snap.explicit.lines.filter(l => classes.includes(l.cls)).reduce((a, l) => a + l.balance, 0);
  const parts = [
    { label: 'Cash, cards and debt paydown', classes: ['cash', 'cards', 'mortgage', 'business'] },
    { label: 'Investments and retirement', classes: ['investments', 'retirement', 'education'] },
    { label: 'Home estimate', classes: ['home'] },
  ].map(x => ({ label: x.label, change: byCls({ explicit: { lines } }, x.classes) - byCls(P, x.classes) }));
  const nwChange = netWorth - P.explicit.netWorth;
  // Plan follow-through: each action that asked for money, checked against transactions since the last review
  const adherence = [];
  for (const it of (P.plan ? P.plan.items : []).filter(i => (i.monthly || 0) > 1 && !i.inCashOut)) {
    const g = profile.goals.find(x => x.id === it.id) || {};
    const expected = it.monthly * months;
    let actual = null, how = '';
    if (!manualOnly && (g.fundedBy || []).length) {
      const rows = db.prepare(`SELECT amount FROM transactions WHERE date > ? AND date <= ? AND amount > 0 AND account_id IN (${g.fundedBy.map(() => '?').join(',')})`).all(from, asOf, ...g.fundedBy);
      if (rows.length || lines.some(l => g.fundedBy.includes(l.id))) { actual = sum(rows.map(r => r.amount)); how = 'deposits into the goal\'s account'; }
    }
    if (actual == null && !manualOnly && g.contributionMatch) {
      const rows = db.prepare(`SELECT amount, description FROM transactions WHERE date > ? AND date <= ? AND amount < 0`).all(from, asOf).filter(r => new RegExp(g.contributionMatch, 'i').test(r.description));
      actual = -sum(rows.map(r => r.amount)); how = `payments matching "${g.contributionMatch}"`;
    }
    if (actual == null && it.kind === 'reserve') { // emergency fund: growth of its synced account
      const acct = profile.protection.emergencyFund.account;
      const now = lines.find(l => l.id === acct), then = P.explicit.lines.find(l => l.id === acct);
      if (now && then && now.synced) { actual = Math.max(0, now.balance - then.balance); how = 'growth of the emergency-fund account'; }
    }
    if (actual == null && it.kind === 'debt' && !manualOnly && mortCfg && g.account === mortCfg.account) { // extra principal: payments above the base payment
      const paid = -sum(db.prepare(`SELECT amount FROM transactions WHERE date > ? AND date <= ? AND amount < 0`).all(from, asOf)
        .filter(r => /mortgage|mtg/i.test(r.description)).map(r => r.amount));
      actual = Math.max(0, paid - (P.plan.items.find(x => x.id === it.id).payNow || 0) * Math.round(months)); how = 'mortgage payments above the base payment';
    }
    let reported = false;
    if (actual == null) { // self-reported: the household told us the amount (profile.selfReported, dated inside this review period)
      const rep = (profile.selfReported || []).filter(r => r.goal === it.id && r.asOf > from && r.asOf <= asOf);
      if (rep.length) { actual = sum(rep.map(r => +r.amount || 0)); how = `self-reported (${rep.map(r => r.source || 'household').join('; ')})`; reported = true; }
    }
    const ratio = actual == null ? null : actual / expected;
    adherence.push({ id: it.id, goal: (goalsOut.find(x => x.id === it.id) || {}).label || it.goal, planned: it.monthly, expected, actual, how, reported,
      status: actual == null ? 'unverified' : ratio >= 0.9 ? 'done' : ratio >= 0.3 ? 'partly' : 'not yet' });
  }
  // Goal movement: funded share then vs now
  const goalMoves = (goalsOut || []).map(g => { const pg = (P.goals || []).find(x => x.id === g.id); return pg ? { id: g.id, label: g.label, before: pg.today.pct, now: g.today.pct, ok: g.today.ok } : null; }).filter(Boolean);
  // Contributions into investment accounts during the period (to separate them from market growth)
  const contributions = (proj ? proj.contributions : 0) * months / 12 + sum(adherence.filter(a => (profile.goals.find(x => x.id === a.id) || {}).fundedBy && a.actual).map(a => a.actual));
  return { from, months: +months.toFixed(1), nwChange, parts, surplusChange: base.surplus - P.extended.surplus, adherence, goalMoves, contributions };
}
const review = quarterlyReview();
// ── Retirement track: actual retirement savings vs. the ORIGINAL plan path ──
// The plan path comes from the first statement (the baseline), so later reviews measure
// against the plan as it was set, not a re-planned one.
function retirementTrack() {
  if (!proj || scenario) return null;
  const retBal = snap => (snap.projection && snap.projection.accounts ? snap.projection.accounts.reduce((a, x) => a + x.balance, 0) : null);
  const past = [];
  if (fs.existsSync(OUT_ROOT)) for (const d of fs.readdirSync(OUT_ROOT).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < asOf).sort()) {
    const f = path.join(OUT_ROOT, d, 'snapshot.json');
    if (fs.existsSync(f)) { try { const sn = JSON.parse(fs.readFileSync(f, 'utf8')); if (sn.projection) past.push(sn); } catch { /* skip */ } }
  }
  const baseline = past.length ? past[0] : null;
  const bp = baseline ? baseline.projection : proj;
  const sc = bp.scenarios[bp.retireAge] || bp.scenarios[retBase];
  const years = 4;
  return {
    baselineDate: baseline ? baseline.asOf : asOf, startAge: bp.startAge, retireAge: bp.retireAge,
    plan: { p10: sc.p10.slice(0, years + 1), p50: sc.p50.slice(0, years + 1), p90: sc.p90.slice(0, years + 1) },
    actual: [...past.map(sn => ({ date: sn.asOf, value: retBal(sn) })), { date: asOf, value: sum(proj.accounts.map(a => a.balance)) }].filter(x => x.value != null),
  };
}
const retTrack = retirementTrack();


// ── Decisions ───────────────────────────────────────────────────────────────
const decisions = [];
for (const a of (review ? review.adherence : []).filter(x => x.status === 'not yet' || x.status === 'partly')) {
  decisions.push(`Behind plan pace on "${a.goal}": ${fmt(a.actual)} vs ${fmt(a.expected)} since ${review.from}. Automate the ${fmt(a.planned)}/mo so it happens without a decision.`);
}
if (monthly && monthly.net > 500) {
  const offSide = (ph.offSideAllowance || 0) > 0 || Object.keys(monthly.memo || {}).length > 0 || (profile.offSyncAccounts || []).some(o => o.class === 'cash');
  const shortSurplus = extended({ coreAdj: Math.max(0, unaccounted) }).surplus;
  decisions.push(offSide
    ? `Settle the biggest unknown: of the ~${fmtK(monthly.net)}/mo that stays where Foliome can't see it, how much is spent vs saved? Mostly saved: surplus ${fmtK(base.surplus)}. Mostly spent: ${fmtK(shortSurplus)}. Essentials are covered either way.`
    : `Give the ~${fmtK(monthly.net)}/mo left over a job. After the plan's ${fmtK(plan ? plan.newMonthly : 0)}/mo, about ${fmtK(plan && plan.leftAfter != null ? plan.leftAfter : monthly.net)}/mo remains. Unless it's moved on purpose, it tends to get spent: the surplus is ${fmtK(base.surplus)} if it's saved, ${fmtK(shortSurplus)} if it's spent.`);
} else if (unaccounted > 10000) decisions.push(`Find out where about ${fmtK(unaccounted)}/yr of take-home goes. If it's spent rather than saved, the surplus drops by about ${fmtK(base.surplus - extended({ coreAdj: unaccounted }).surplus)}.`);
const est = profile.protection.estateDocs;
if ([est.will, est.beneficiaries, est.guardianship].some(s => /not started/i.test(s))) {
  decisions.push('Start wills, name a guardian, and check beneficiaries on every account and policy. The biggest gap, and the cheapest to fix.');
}
for (const g of goalRows.filter(r => r.goal && r.goal.annualOptions && !r.dedicated)) {
  const pi = plan && plan.items.find(i => i.id === g.id);
  decisions.push(`Open a 529 for "${g.goal.label.replace(/^College, /, '')}" and automate ${pi ? fmt(pi.monthly) : fmtK(g.pv / g.goal.startsInYears / 12)}/mo.`);
}
decisions.push('Choose a college target per child (in-state public, private, or a share). It moves the education numbers more than anything else.');
const lifeGaps = profile.humanCapital.earners.map(er => {
  const hcm = sum(base.hc.filter(h => h.member === er.member).map(h => h.pv));
  const cover = sum((profile.protection.life || []).filter(l => l.member === er.member).map(l => l.amount));
  return { member: er.member, hcm, cover };
}).filter(g => g.hcm > g.cover * 2);
if (lifeGaps.length) decisions.push(`Life insurance: ${lifeGaps.map(g => `${nameOf(g.member)} has ${fmtK(g.cover)} of cover against about ${fmtK(g.hcm)} of future earnings`).join('; ')}. Is that enough if either income stopped?`);
if (scen.B && scen.B.member && scen.B.stopsAfterYears == null) decisions.push(`Pick a realistic number of years before ${nameOf(scen.B.member)} leaves salaried work. The plan shows 5 and 10 as examples.`);

function fmtK(n) { const a = Math.abs(n); const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : `$${Math.round(a / 1000)}K`; return n < 0 ? `−${s}` : s; }
function fmt(n) { return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US'); }
function pct(n) { return `${(n * 100).toFixed(1)}%`; }

// ── Snapshot ────────────────────────────────────────────────────────────────
const snapshot = {
  asOf, generatedAt: new Date().toISOString(), profile, missing: [...new Set(missing)],
  explicit: { lines, explicitAssets, explicitLiabs, netWorth, deferredTax, homeSelling, netWorthAfterTax, cash, investable },
  extended: { humanCapital: base.hc, implicitLiabs: base.il, assets: base.assets, liabs: base.liabs, surplus: base.surplus, horizonYears },
  liquidity: { monthlyEssential, runwayMonths, emergencyFund: efBal },
  cashFlow: { grossPay, takeHome, unaccounted }, period: monthlyPeriod,
  tax: taxEst, calibration: calib, plan, projection: proj, statusQuo: sq, assumptionsUsed, goals: goalsOut, review, retirementTrack: retTrack,
  marketDefaults: (() => { try { const m = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'market.json'), 'utf8')); return { defaults: m.defaults, sources: m.sources, asOf: m.asOf, fetchedAt: m.fetchedAt }; } catch { return null; } })(),
  returnAssumptions: (() => { // per retirement account: the data-built default vs what was used, so overrides are visible
    let d = { accounts: [] }; try { d = JSON.parse(fs.readFileSync(path.join(PFS_DIR, 'derived.json'), 'utf8')); } catch { /* none */ }
    return (profile.retirement.accounts || []).map(a => { const x = d.accounts.find(y => y.id === a.id); const def = x ? x.realReturn : null;
      return { id: a.id, used: a.mu, vol: a.sigma, default: def, overridden: def != null && Math.abs(def - a.mu) > 0.0005, source: a.source }; });
  })(),
  spendModel: { coreVisible, offSide: ph.offSideAllowance || 0, offSideSource: ph.offSideSource, offSideLabel: ph.offSideLabel, mortgage: catAnnual('Mortgage'), childcare: childcareAnnual, childcareYears, core: coreSpend },
  monthly,
  whatIfs: whatIfs.map(w => ({ id: w.id, label: w.label, surplus: w.r.surplus, illustrative: !!w.illustrative })),
  decisions, stale,
};

// ── Render ──────────────────────────────────────────────────────────────────
const { render } = require('./render');
let baseSnap = null;
if (scenario) { const bp = path.join(OUT_ROOT, asOf, 'snapshot.json'); if (fs.existsSync(bp)) baseSnap = JSON.parse(fs.readFileSync(bp, 'utf8')); snapshot.scenario = { name: scenario.name, label: scenario.label || scenario.name, description: scenario.description || '' }; }
const html = render(snapshot, { previous: scenario ? null : previous, base: baseSnap, goalRows, fmt, fmtK, pct, whatIfs, nameOf });

const outDir = scenario ? path.join(OUT_ROOT, asOf, 'scenarios', scenario.name) : path.join(OUT_ROOT, asOf);
fs.mkdirSync(outDir, { recursive: true });
// A statement is never overwritten: a same-day rebuild keeps the earlier one as revisions/rev-N.
if (!scenario && fs.existsSync(path.join(outDir, 'snapshot.json'))) {
  const revRoot = path.join(outDir, 'revisions');
  const n = (fs.existsSync(revRoot) ? fs.readdirSync(revRoot).filter(d => /^rev-\d+$/.test(d)).length : 0) + 1;
  const keep = path.join(revRoot, `rev-${n}`);
  fs.mkdirSync(keep, { recursive: true });
  for (const f of ['snapshot.json', 'statement.html', 'statement.pdf']) if (fs.existsSync(path.join(outDir, f))) fs.renameSync(path.join(outDir, f), path.join(keep, f));
}
fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
fs.writeFileSync(path.join(outDir, 'statement.html'), html);
let pdfPath = null;
if (!noPdf) {
  pdfPath = path.join(outDir, 'statement.pdf');
  const chrome = ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
  if (chrome) {
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--virtual-time-budget=5000', `--print-to-pdf=${pdfPath}`, `file://${path.join(outDir, 'statement.html')}`], { stdio: 'ignore' });
  } else { pdfPath = null; console.error('Chrome not found; skipped PDF.'); }
}
console.log(JSON.stringify({
  outDir, pdf: pdfPath, netWorth: Math.round(netWorth), surplus: Math.round(base.surplus),
  humanCapital: Math.round(sum(base.hc.map(h => h.pv))), runwayMonths: +runwayMonths.toFixed(1),
  missing: snapshot.missing,
}, null, 2));
