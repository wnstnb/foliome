#!/usr/bin/env node
/**
 * End-to-end test of the Personal Financial Statement on a synthetic household.
 * Builds a demo database, runs derive + build in an isolated directory, and checks
 * the invariants that make a statement trustworthy.
 *
 * Usage: node scripts/pfs/demo/test.js [--keep] [--sample docs/pfs-sample.pdf]
 * Exit code 0 = all checks passed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..', '..');
const keep = process.argv.includes('--keep');
const samplePath = process.argv.includes('--sample') ? path.resolve(process.argv[process.argv.indexOf('--sample') + 1]) : null;
const asOf = '2026-10-01';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfs-demo-'));
const dbPath = path.join(dir, 'demo.db');
const profile = path.join(__dirname, 'demo-profile.json');
const env = { ...process.env, PFS_DATA_DIR: dir };
const run = (script, args) => execFileSync('node', [path.join(ROOT, 'scripts', 'pfs', script), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Reuse fetched market data when available so the test runs offline; the build falls back to the pack otherwise.
const market = path.join(ROOT, 'data', 'pfs', 'market.json');
if (fs.existsSync(market)) fs.copyFileSync(market, path.join(dir, 'market.json'));

execFileSync('node', [path.join(__dirname, 'make-demo-db.js'), dbPath, '--as-of', asOf], { encoding: 'utf8' });
run('derive.js', ['--db', dbPath, '--profile', profile]);
run('build.js', ['--db', dbPath, '--profile', profile, '--out', dir, '--date', asOf, ...(samplePath ? [] : ['--no-pdf'])]);

const snap = JSON.parse(fs.readFileSync(path.join(dir, asOf, 'snapshot.json'), 'utf8'));
const html = fs.readFileSync(path.join(dir, asOf, 'statement.html'), 'utf8');
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

const e = snap.explicit;
check('net worth = assets − liabilities', near(e.netWorth, e.explicitAssets - e.explicitLiabs), `${e.netWorth}`);
check('net worth = synced + stated balances', near(e.netWorth, 4200 + 32000 - 2300 + 48000 + 210000 + 38000 + 96000 + 22000 + 640000 - 385000 + 61000), `${e.netWorth}`);
check('stated account shows as stated', e.lines.some(l => l.id === 'sam-403b' && !l.synced));
check('all five goal types present', ['retirement', 'emergency', 'education', 'lumpSum', 'debt'].every(t => snap.goals.some(g => g.type === t)), snap.goals.map(g => g.type).join(','));
check('plan total = sum of goal actions', near(snap.plan.newMonthly, snap.plan.items.filter(i => !i.inCashOut).reduce((a, i) => a + (i.monthly || 0), 0), 0.01));
check('monthly cash: in − out = left over', near(snap.monthly.totalIn - snap.monthly.totalOut, snap.monthly.net, 0.01));
check('property tax reclassified from utilities', snap.monthly.groups.some(g => g.lines.some(l => l.cat === 'Property tax')));
check('state tax falls back to a flat rate (CO has no pack)', snap.tax && snap.tax.rows.every(r => r.state > 0) && /flat/.test(snap.profile.tax.state.name), snap.tax && snap.tax.rows.map(r => Math.round(r.state)).join(','));
check('tax model calibrated against payroll', (snap.calibration || []).length === 1 && Math.abs(snap.calibration[0].gap / snap.calibration[0].observed) < 0.15, JSON.stringify(snap.calibration));
check('retirement simulation ran', snap.projection && snap.projection.scenarios[65].success > 0 && snap.projection.scenarios[65].success <= 1);
check('history replay ran (if market data present)', !fs.existsSync(market) || (snap.projection.crossCheck && snap.projection.crossCheck.success > 0));
check('decisions present', snap.decisions.length >= 2);
check('no NaN / undefined in the statement', !/NaN|undefined|\[object Object\]/.test(html));
check('no internal crumbs', !/foliome\.db|config\/pfs|\bCFA\b/i.test(html));
check('estimates are labeled', /src est/.test(html));
// Every person named in the statement must come from this household's profile (no names baked into the renderer)
const demoProfile = JSON.parse(fs.readFileSync(profile, 'utf8'));
const people = new Set(demoProfile.household.members.map(m => m.name));
const strayNames = [...new Set((html.replace(/<[^>]*>/g, ' ').match(/\b[A-Z][a-z]+'s\b/g) || []).map(w => w.slice(0, -2)))]
  .filter(n => !people.has(n) && !['It', 'That', 'Today', 'What', 'There', 'Here', 'Who', 'Let', 'Year', 'Month'].includes(n));
check('only household members are named', strayNames.length === 0, strayNames.join(', '));

// ── Quarterly review: build the same household a quarter later; the review should find the 529 deposits ──
const asOf2 = '2027-01-01';
const db2 = path.join(dir, 'demo-q2.db');
execFileSync('node', [path.join(__dirname, 'make-demo-db.js'), db2, '--as-of', asOf2, '--quarter-later'], { encoding: 'utf8' });
run('build.js', ['--db', db2, '--profile', profile, '--out', dir, '--date', asOf2, '--no-pdf']);
const snap2 = JSON.parse(fs.readFileSync(path.join(dir, asOf2, 'snapshot.json'), 'utf8'));
const html2 = fs.readFileSync(path.join(dir, asOf2, 'statement.html'), 'utf8');
check('quarterly review links to the previous snapshot', snap2.review && snap2.review.from === asOf, snap2.review && snap2.review.from);
check('review: net worth change splits into its parts', snap2.review && near(snap2.review.nwChange, snap2.review.parts.reduce((a, x) => a + x.change, 0)), snap2.review && JSON.stringify(snap2.review.parts));
const a529 = snap2.review && snap2.review.adherence.find(a => a.id === 'edu-kid1');
check('review: 529 deposits found and marked done', a529 && a529.actual === 1920 && a529.status === 'done', JSON.stringify(a529));
check('review: unverifiable actions say so', snap2.review && snap2.review.adherence.some(a => a.status === 'unverified'));
check('review: self-reported amount counts and is marked', snap2.review && snap2.review.adherence.some(a => a.id === 'car' && a.reported && a.actual === 2400), JSON.stringify((snap2.review.adherence.find(a => a.id === 'car') || {})));
check('review shows on page 1', /Since the last statement/.test(html2) && /Activity vs. plan/.test(html2));

// ── The core never depends on the statement: wiki and goals work with no statement data at all ──
{
  const emptyPfs = fs.mkdtempSync(path.join(os.tmpdir(), 'pfs-none-'));
  const emptyWiki = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-none-'));
  const env0 = { ...process.env, PFS_DATA_DIR: emptyPfs, WIKI_DIR: emptyWiki };
  let ok = true, out = '';
  try {
    out = execFileSync('node', [path.join(ROOT, 'scripts', 'wiki.js'), 'goals'], { env: env0, encoding: 'utf8' });
    out += execFileSync('node', ['-e', "const i=require('./scripts/wiki-queries').getWikiIndex();if(i.totalPages!==0||!i.home)process.exit(1)"], { cwd: ROOT, env: env0, encoding: 'utf8' });
  } catch (e) { ok = false; out = e.message; }
  check('core works without a statement (wiki goals + index)', ok && /No statement snapshot/.test(out), out.trim().slice(0, 200));
  fs.rmSync(emptyPfs, { recursive: true, force: true }); fs.rmSync(emptyWiki, { recursive: true, force: true });
}

if (samplePath) {
  fs.mkdirSync(path.dirname(samplePath), { recursive: true });
  fs.copyFileSync(path.join(dir, asOf, 'statement.pdf'), samplePath);
}
const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${!c.ok && c.detail ? ` (${c.detail})` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed${samplePath ? `; sample written to ${path.relative(ROOT, samplePath)}` : ''}${keep ? `; output kept in ${dir}` : ''}`);
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
