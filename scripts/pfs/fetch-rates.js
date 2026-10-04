#!/usr/bin/env node
/**
 * Fetch the real risk-free rate inputs from FRED (no API key needed):
 *   DGS10  — 10-year Treasury constant-maturity yield (nominal)
 *   T5YIE  — 5-year breakeven inflation
 * Writes data/pfs/rates.json. Falls back to assumptions/household.json when offline.
 *
 * Usage: node scripts/pfs/fetch-rates.js
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(process.env.PFS_DATA_DIR ? path.resolve(process.env.PFS_DATA_DIR) : path.join(ROOT, 'data', 'pfs'), 'rates.json');
const FALLBACK = require('./assumptions/household.json').riskFreeFallback;

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let body = ''; res.on('data', d => (body += d)); res.on('end', () => resolve(body));
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

function lastValue(csv, col) {
  const rows = csv.trim().split('\n'); const head = rows[0].split(',');
  const i = head.indexOf(col);
  for (let r = rows.length - 1; r > 0; r--) {
    const c = rows[r].split(',');
    if (c[i] !== '' && c[i] !== '.' && !isNaN(+c[i])) return { date: c[0], value: +c[i] / 100 };
  }
  return null;
}

async function fetchRates() {
  try {
    const csv = await get('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10,T5YIE');
    const t10 = lastValue(csv, 'DGS10'), be = lastValue(csv, 'T5YIE');
    if (!t10 || !be) throw new Error('missing series');
    return { source: 'FRED (DGS10, T5YIE)', nominal10y: t10.value, nominal10yDate: t10.date, breakevenInflation: be.value, breakevenDate: be.date,
      realRiskFree: (1 + t10.value) / (1 + be.value) - 1, fetchedAt: new Date().toISOString() };
  } catch (e) {
    return { source: `fallback (${e.message})`, nominal10y: FALLBACK.nominal10y, breakevenInflation: FALLBACK.breakevenInflation,
      realRiskFree: (1 + FALLBACK.nominal10y) / (1 + FALLBACK.breakevenInflation) - 1, asOf: FALLBACK.asOf, fetchedAt: new Date().toISOString() };
  }
}

if (require.main === module) {
  fetchRates().then(r => {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2));
  });
}
module.exports = { fetchRates };
