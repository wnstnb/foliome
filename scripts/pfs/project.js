/**
 * Year-by-year projection for the Personal Financial Statement.
 *
 * Everything is in real (today's) dollars. Components are modelled separately:
 *   - retirement portfolio (per-account real returns, contributions until retirement,
 *     withdrawals in retirement), with Monte Carlo bands
 *   - education (529s: monthly plan contributions, then 4 years of draws per child)
 *   - cash (held, small real return)
 *   - home equity (home value flat in real terms; mortgage amortizes in nominal
 *     dollars, so the real balance shrinks faster)
 *
 * Spending is phased (the old flat "lifestyle" figure double-counted the mortgage):
 *   core      = visible cash out excluding mortgage and childcare, plus an
 *               allowance for spending in accounts Foliome can't see
 *   childcare = until it ends
 *   mortgage  = the actual fixed payment, until payoff (deflated to real terms)
 *   health    = per person, from retirement until Medicare age
 */

// Deterministic PRNG so every rebuild of a snapshot gives identical bands.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Mortgage: solve the rate that pays off `balance` with `payment` in `months`. */
function solveMortgageRate(balance, payment, months) {
  let lo = 0.0001, hi = 0.15;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    let b = balance, m = 0;
    while (b > 0 && m < 1000) { b = b * (1 + mid / 12) - payment; m++; }
    if (m > months) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}
/** Annual nominal schedule: [{ year, interest, principal, endBalance, paid }] */
function mortgageSchedule(balance, payment, rate) {
  const out = []; let b = balance;
  for (let y = 0; b > 0.01 && y < 60; y++) {
    let interest = 0, principal = 0, paid = 0;
    for (let m = 0; m < 12 && b > 0.01; m++) {
      const i = b * rate / 12, p = Math.min(b, payment - i);
      interest += i; principal += p; paid += i + p; b -= p;
    }
    out.push({ year: y, interest, principal, paid, endBalance: b });
  }
  return out;
}

/** Real after-tax household spending by year (index 0 = this year). */
function spendingPath({ years, core, childcare, childcareYears, mortgageSched, inflation, healthPerPerson, adults, retireYear, medicareAge }) {
  const rows = [];
  for (let y = 0; y < years; y++) {
    const defl = Math.pow(1 + inflation, y);
    const mort = mortgageSched[y] ? mortgageSched[y].paid / defl : 0;
    const kids = y < childcareYears ? childcare : 0;
    const health = y >= retireYear ? adults.filter(a => a.age0 + y < medicareAge).length * healthPerPerson : 0;
    rows.push({ y, core, childcare: kids, mortgage: mort, health, total: core + kids + mort + health });
  }
  return rows;
}

/**
 * Retirement portfolio simulation.
 * accounts: [{ id, balance, mu (real), sigma }]  contributions: real $/yr until retireYear
 * withdrawals: array by year (real, pre-tax, from retireYear on)
 * Uses one market shock per year applied to every account (assets move together),
 * scaled by each account's own volatility. Returns p10/p50/p90 paths and success rate.
 */
function simulateRetirement({ accounts, contributions, retireYear, withdrawals, years, paths = 3000, seed = 42, muShift = 0 }) {
  const rand = mulberry32(seed);
  const totals = Array.from({ length: years + 1 }, () => new Float64Array(paths));
  let survived = 0;
  for (let p = 0; p < paths; p++) {
    const bal = accounts.map(a => a.balance);
    totals[0][p] = bal.reduce((s, x) => s + x, 0);
    let broke = false;
    for (let y = 0; y < years; y++) {
      const z = normal(rand);
      for (let i = 0; i < bal.length; i++) {
        const a = accounts[i];
        const mu = a.mu + muShift;
        // lognormal; `mu` is the typical (median, compound) real growth rate
        const r = Math.exp(Math.log(1 + mu) + a.sigma * z) - 1;
        bal[i] = bal[i] * (1 + r);
      }
      let total = bal.reduce((s, x) => s + x, 0);
      if (y < retireYear) {
        total += contributions;
        for (let i = 0; i < bal.length; i++) bal[i] += contributions * (accounts[i].contribShare || 0);
      } else {
        const w = withdrawals[y] || 0;
        const scale = total > 0 ? Math.max(0, (total - w) / total) : 0;
        for (let i = 0; i < bal.length; i++) bal[i] *= scale;
        total = Math.max(0, total - w);
        if (total <= 0 && !broke) broke = true;
      }
      totals[y + 1][p] = total;
    }
    if (!broke) survived++;
  }
  const q = (arr, k) => { const s = Array.from(arr).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(k * s.length))]; };
  return {
    p10: totals.map(t => q(t, 0.10)), p50: totals.map(t => q(t, 0.50)), p90: totals.map(t => q(t, 0.90)),
    success: survived / paths, paths,
  };
}

/** Largest constant real after-tax spend (per year) with success >= target. */
function safeSpend({ sim, base, toWithdrawals, target = 0.9, lo = 0, hi = 400000 }) {
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    const r = sim({ ...base, withdrawals: toWithdrawals(mid) });
    if (r.success >= target) lo = mid; else hi = mid;
  }
  return lo;
}

/** 529s: deterministic real growth, plan contributions until each child starts, then 4 equal draws. */
function educationPath({ goals, years, rate }) {
  const per = goals.map(g => ({ id: g.id, bal: g.have, monthly: g.monthly, start: g.startsInYears, years: g.years, annual: g.annual }));
  const out = [];
  for (let y = 0; y <= years; y++) {
    out.push(per.reduce((s, g) => s + Math.max(0, g.bal), 0));
    for (const g of per) {
      g.bal *= 1 + rate;
      if (y < g.start) g.bal += g.monthly * 12;
      else if (y < g.start + g.years) g.bal -= g.annual;
    }
  }
  return out;
}


/**
 * History replay: block bootstrap of actual annual real returns (stocks / bonds / bills).
 * Each path stitches together random 5-year runs of real history (wrapping at the end),
 * so bad stretches like 1929-32, 1973-74 and 2000-02 keep their shape.
 * accounts: [{ balance, weights: { stocks, bonds, bills }, contribShare }]
 * trim: subtracted from the stock return each year (e.g. 0.02 = "history, trimmed 2 pts").
 */
function simulateHistory({ accounts, contributions, retireYear, withdrawals, years, history, paths = 3000, seed = 7, trim = 0.02, block = 5 }) {
  const rand = mulberry32(seed);
  const n = history.length;
  const totals = Array.from({ length: years + 1 }, () => new Float64Array(paths));
  let survived = 0;
  for (let p = 0; p < paths; p++) {
    const bal = accounts.map(a => a.balance);
    totals[0][p] = bal.reduce((s, x) => s + x, 0);
    let broke = false, start = 0, k = block;
    for (let y = 0; y < years; y++) {
      if (k >= block) { start = Math.floor(rand() * n); k = 0; }
      const h = history[(start + k) % n].real; k++;
      for (let i = 0; i < bal.length; i++) {
        const w = accounts[i].weights;
        const r = w.stocks * (h.stocks - trim) + w.bonds * h.bonds + w.bills * h.bills;
        bal[i] *= 1 + r;
      }
      let total = bal.reduce((s, x) => s + x, 0);
      if (y < retireYear) {
        for (let i = 0; i < bal.length; i++) bal[i] += contributions * (accounts[i].contribShare || 0);
        total += contributions;
      } else {
        const w = withdrawals[y] || 0;
        const scale = total > 0 ? Math.max(0, (total - w) / total) : 0;
        for (let i = 0; i < bal.length; i++) bal[i] *= scale;
        total = Math.max(0, total - w);
        if (total <= 0) broke = true;
      }
      totals[y + 1][p] = total;
    }
    if (!broke) survived++;
  }
  const q = (arr, f) => { const s = Array.from(arr).sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  return { p10: totals.map(t => q(t, 0.1)), p50: totals.map(t => q(t, 0.5)), p90: totals.map(t => q(t, 0.9)), success: survived / paths, paths };
}

/** Asset-class mix → history weights. Equity-like classes ride stocks; bonds/TIPS ride bonds; cash rides bills. */
function mixToWeights(mix, classes) {
  const w = { stocks: 0, bonds: 0, bills: 0 };
  for (const [k, f] of Object.entries(mix || {})) {
    if (k === 'cash') w.bills += f;
    else if (k === 'us-bonds' || k === 'tips') w.bonds += f;
    else if (k === 'target-date') { w.stocks += 0.6 * f; w.bonds += 0.4 * f; }
    else if (classes && classes[k] && classes[k].exclude) continue;
    else w.stocks += f;
  }
  const t = w.stocks + w.bonds + w.bills;
  return t > 0 ? { stocks: w.stocks / t, bonds: w.bonds / t, bills: w.bills / t } : { stocks: 0.6, bonds: 0.4, bills: 0 };
}

module.exports = { simulateHistory, mixToWeights, solveMortgageRate, mortgageSchedule, spendingPath, simulateRetirement, safeSpend, educationPath };
