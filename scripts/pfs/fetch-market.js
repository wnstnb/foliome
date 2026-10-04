#!/usr/bin/env node
/**
 * Fetch public market data at run time (nothing is redistributed with the repo):
 *
 *   History (1928 →):   Damodaran (NYU Stern) "histretSP.xls" — annual S&P 500 total
 *                       return, 3-month T-bill, 10-year Treasury total return.
 *   Inflation:          FRED CPIAUCNS (CPI-U, not seasonally adjusted), Dec-to-Dec.
 *   Current yields:     FRED DFII10 (10-yr TIPS real yield), TB3MS (3-mo T-bill),
 *                       T5YIE (5-yr breakeven inflation).
 *   Stock building block: Damodaran "histimpl.xls" — latest S&P 500 dividend yield and
 *                       the S&P 500 earnings series (real growth since 1960).
 *
 * Writes data/pfs/market.json:
 *   { history: [{year, nominal:{stocks,bonds,bills}, inflation, real:{...}}],
 *     defaults: { stocks, bonds, cash } real returns with their derivation,
 *     classes: data-built capital-market assumptions per asset class }
 *
 * Usage: node scripts/pfs/fetch-market.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
// xlsx is an optional dependency, only needed here (the statement is an optional add-on).
let XLSX;
try { XLSX = require('xlsx'); } catch {
  console.error('fetch-market: the optional "xlsx" package is not installed, so historical returns can\'t be read.\n'
    + 'The statement will use its built-in assumptions and skip the history replay. To enable it: npm install xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(process.env.PFS_DATA_DIR ? path.resolve(process.env.PFS_DATA_DIR) : path.join(ROOT, 'data', 'pfs'), 'market.json');
const PACK = require('./assumptions/capital-markets.json');

const HISTRET = 'https://pages.stern.nyu.edu/~adamodar/pc/datasets/histretSP.xls';
const HISTIMPL = 'https://pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xls';
const FRED = ids => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${ids}`;

function get(url, binary = false) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return resolve(get(res.headers.location, binary));
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve(binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const csvRows = csv => csv.trim().split('\n').map(l => l.split(','));
function lastOf(csv, col) {
  const rows = csvRows(csv), i = rows[0].indexOf(col);
  for (let r = rows.length - 1; r > 0; r--) if (rows[r][i] !== '' && rows[r][i] !== '.' && !isNaN(+rows[r][i])) return { date: rows[r][0], value: +rows[r][i] / 100 };
  return null;
}
const sheetRows = (buf, name) => {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false });
};

async function main() {
  const out = { fetchedAt: new Date().toISOString(), sources: {} };

  // ── Inflation: CPI-U Dec-to-Dec ───────────────────────────────────────────
  const cpiCsv = await get(FRED('CPIAUCNS'));
  const dec = {};
  for (const [d, v] of csvRows(cpiCsv).slice(1)) if (d.slice(5, 7) === '12' && v !== '.') dec[+d.slice(0, 4)] = +v;
  const inflationFor = y => dec[y] && dec[y - 1] ? dec[y] / dec[y - 1] - 1 : null;
  out.sources.inflation = 'FRED CPIAUCNS (CPI-U, NSA), December to December';

  // ── History: annual nominal returns 1928 → ─────────────────────────────────
  const hr = sheetRows(await get(HISTRET, true), 'Returns by year');
  const head = hr.findIndex(r => r[0] === 'Year');
  const cols = hr[head];
  const ci = re => cols.findIndex(c => re.test(String(c)));
  const cS = ci(/^S&P 500 \(includes dividends\)$/), cB = ci(/^3-month T\.?Bill$/i), cT = ci(/^US T\. Bond/);
  const history = [];
  for (const r of hr.slice(head + 1)) {
    if (typeof r[0] !== 'number' || r[0] < 1928 || r[0] > 2100) break;
    const inf = inflationFor(r[0]); if (inf == null) continue;
    const nominal = { stocks: r[cS], bonds: r[cT], bills: r[cB] };
    const real = Object.fromEntries(Object.entries(nominal).map(([k, v]) => [k, (1 + v) / (1 + inf) - 1]));
    history.push({ year: r[0], nominal, inflation: inf, real });
  }
  out.history = history;
  out.sources.history = `Damodaran, NYU Stern, histretSP.xls (${history[0].year}–${history[history.length - 1].year})`;

  // ── Current yields ─────────────────────────────────────────────────────────
  // one series per request: mixed frequencies make FRED return a zip
  const [tips, bill, be] = await Promise.all(['DFII10', 'TB3MS', 'T5YIE'].map(async id => lastOf(await get(FRED(id)), id)));
  if (!tips || !bill || !be) throw new Error('FRED yields missing');

  // ── Stock building block: dividend yield + long-run real earnings growth ────
  const hi = sheetRows(await get(HISTIMPL, true), 'Historical Impl Premiums');
  const h0 = hi.findIndex(r => r[0] === 'Year'); const hc = hi[h0];
  const yrs = hi.slice(h0 + 1).filter(r => typeof r[0] === 'number' && r[0] > 1900 && r[0] < 2100);
  const iDY = hc.indexOf('Dividend Yield'), iE = hc.findIndex(c => /^Earnings\*?$/.test(String(c)));
  const first = yrs.find(r => typeof r[iE] === 'number'), last = yrs[yrs.length - 1];
  const nYears = last[0] - first[0];
  const nominalEpsGrowth = Math.pow(last[iE] / first[iE], 1 / nYears) - 1;
  const infl = Math.pow(dec[last[0]] / dec[first[0]], 1 / nYears) - 1;
  const realEpsGrowth = (1 + nominalEpsGrowth) / (1 + infl) - 1;
  const divYield = last[iDY];
  out.sources.stocks = `Damodaran, NYU Stern, histimpl.xls: S&P 500 dividend yield (${last[0]}) and earnings ${first[0]}–${last[0]}`;

  const stocks = divYield + realEpsGrowth;
  const bonds = tips.value;
  const cash = (1 + bill.value) / (1 + be.value) - 1;
  out.defaults = {
    stocks: { realReturn: +stocks.toFixed(4), how: `dividend yield ${(divYield * 100).toFixed(2)}% (${last[0]}) + real earnings growth ${(realEpsGrowth * 100).toFixed(2)}%/yr (${first[0]}–${last[0]}); assumes no change in valuations` },
    bonds:  { realReturn: +bonds.toFixed(4), how: `10-year TIPS real yield ${(tips.value * 100).toFixed(2)}% (FRED DFII10, ${tips.date})` },
    cash:   { realReturn: +cash.toFixed(4), how: `3-month T-bill ${(bill.value * 100).toFixed(2)}% less 5-year breakeven inflation ${(be.value * 100).toFixed(2)}% (FRED TB3MS, T5YIE, ${bill.date})` },
  };

  // ── Data-built class assumptions: building blocks + the pack's relative spreads
  const broad = PACK.classes['us-equity'].realReturn;
  const classes = {};
  for (const [k, c] of Object.entries(PACK.classes)) {
    let r = c.realReturn;
    if (k === 'us-bonds' || k === 'tips') r = bonds + (c.realReturn - PACK.classes['us-bonds'].realReturn);
    else if (k === 'cash') r = cash;
    else if (k === 'target-date') r = 0.6 * stocks + 0.4 * bonds;
    else if (c.equityLoading >= 0.8 && !c.exclude) r = stocks + (c.realReturn - broad); // keep the pack's spread vs broad US stocks
    classes[k] = { ...c, realReturn: +r.toFixed(4) };
  }
  out.classes = classes;
  out.asOf = { history: history[history.length - 1].year, stocks: last[0], bonds: tips.date, cash: bill.date };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  main().then(o => {
    const g = (k, fn) => { const xs = o.history.map(h => h.real[k]); return (Math.pow(xs.reduce((p, x) => p * (1 + x), 1), 1 / xs.length) - 1) * 100; };
    console.log(`history ${o.history[0].year}–${o.history[o.history.length - 1].year} (${o.history.length} yrs). Real geometric: stocks ${g('stocks').toFixed(1)}%, bonds ${g('bonds').toFixed(1)}%, bills ${g('bills').toFixed(1)}%`);
    for (const [k, v] of Object.entries(o.defaults)) console.log(`default ${k}: ${(v.realReturn * 100).toFixed(2)}% (${v.how})`);
  }).catch(e => { console.error('fetch-market failed:', e.message); process.exit(1); });
}
module.exports = { main };
