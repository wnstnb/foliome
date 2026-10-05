#!/usr/bin/env node
/**
 * Build a statement of activity for any period.
 *
 *   node scripts/statements/build.js                         # last calendar month, kind=custom
 *   node scripts/statements/build.js --month 2026-09 --kind issued
 *   node scripts/statements/build.js --from 2026-07-01 --to 2026-09-30
 *   node scripts/statements/build.js --month 2026-09 --kind preview --out /tmp/x
 *
 * Options: --db <path>  --out <root (default data/statements)>  --budgets <json>  --profile <pfs profile json>
 *          --issued-at <ISO>  --no-pdf
 *
 * Kinds:
 *   issued  frozen; written once to <out>/issued/<period>/rev-<n>/. A rebuild of an issued period is revision n+1.
 *           Carries corrections forward from the previous issued month.
 *   custom  any period, on demand; same layout under <out>/custom/<period>/rev-<n>/.
 *   preview not issued; overwrites <out>/preview/<period>/. For checking before issuing.
 *
 * Exits non-zero and writes nothing if a check fails. Prints a JSON summary on success.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { computeStatement, monthStart, monthEnd } = require('./compute');
const { render } = require('./render');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const flag = k => args.includes(k);

const kind = opt('--kind', 'custom');
if (!['issued', 'custom', 'preview'].includes(kind)) die(`unknown --kind ${kind}`);
let from = opt('--from'), to = opt('--to');
const month = opt('--month');
if (month) { from = `${month}-01`; to = monthEnd(from); }
if (!from || !to) { const today = new Date().toISOString().slice(0, 7); from = monthStart(today, 1); to = monthEnd(from); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) die(`bad period ${from}..${to}`);
if (kind === 'issued' && !(from.endsWith('-01') && to === monthEnd(from))) die('issued statements are calendar months; use --kind custom for other periods');

const dbPath = opt('--db', path.join(ROOT, 'data', 'foliome.db'));
const outRoot = opt('--out', path.join(ROOT, 'data', 'statements'));
const readJson = p => { try { return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch { return null; } };
const budgets = readJson(opt('--budgets', path.join(ROOT, 'config', 'budgets.json')));
const profile = readJson(opt('--profile', path.join(ROOT, 'config', 'pfs-profile.json')));
const unseen = profile && ((profile.offSyncAccounts || []).some(o => o.class === 'cash') || ((profile.spending || {}).phased || {}).offSideAllowance > 0)
  ? "Spending on accounts Foliome can't see isn't included" : null;

const periodKey = from.endsWith('-01') && to === monthEnd(from) ? from.slice(0, 7) : `${from}_${to}`;
const kindDir = path.join(outRoot, kind, periodKey);
const revisions = d => fs.existsSync(d) ? fs.readdirSync(d).filter(x => /^rev-\d+$/.test(x)).map(x => +x.slice(4)).sort((a, b) => a - b) : [];
const latestSnapshot = (k, key) => { const d = path.join(outRoot, k, key), r = revisions(d).at(-1); return r ? readJson(path.join(d, `rev-${r}`, 'snapshot.json')) : null; };

// Corrections carry forward from the previous issued month
let previous = null;
if (kind !== 'custom' && from.endsWith('-01')) previous = latestSnapshot('issued', monthStart(from.slice(0, 7), 1).slice(0, 7));

const revision = kind === 'preview' ? 1 : (revisions(kindDir).at(-1) || 0) + 1;
const db = new Database(dbPath, { readonly: true });
const snap = computeStatement(db, { from, to, kind, issuedAt: opt('--issued-at') || new Date().toISOString(), budgets, unseenSpendingNote: unseen, previous, revision });
db.close();

if (!snap.checks.passed) die(`checks failed, nothing written:\n  - ${snap.checks.fails.join('\n  - ')}`, 2);

const outDir = kind === 'preview' ? kindDir : path.join(kindDir, `rev-${revision}`);
if (kind !== 'preview' && fs.existsSync(outDir)) die(`${outDir} already exists; issued statements are never overwritten`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snap, null, 2));
fs.writeFileSync(path.join(outDir, 'statement.html'), render(snap));

let pdf = null;
if (!flag('--no-pdf')) {
  const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => fs.existsSync(p));
  if (chrome) {
    pdf = path.join(outDir, 'statement.pdf');
    execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--virtual-time-budget=5000', `--print-to-pdf=${pdf}`, `file://${path.join(outDir, 'statement.html')}`], { stdio: 'ignore' });
  } else console.error('Chrome not found; skipped PDF.');
}
if (kind !== 'preview') for (const f of fs.readdirSync(outDir)) fs.chmodSync(path.join(outDir, f), 0o444); // frozen on disk too

console.log(JSON.stringify({
  outDir, pdf, kind, period: snap.period.label, revision,
  netWorth: { open: snap.bridge.open, close: snap.bridge.close, change: snap.bridge.change },
  in: snap.cashFlow.in, out: snap.cashFlow.out, left: snap.cashFlow.left,
  notExplained: (snap.bridge.lines.find(l => l.id === 'other') || {}).amount || 0,
  callouts: snap.callouts.map(c => c.text), corrections: !!snap.corrections,
}, null, 2));

function die(msg, code = 1) { console.error(`statements: ${msg}`); process.exit(code); }
