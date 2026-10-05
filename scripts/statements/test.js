#!/usr/bin/env node
/**
 * Statement of activity checks against the demo household (made-up data). Runs offline.
 * Builds a demo database with history, issues September, then checks the numbers, freezing,
 * corrections carried into October, a custom quarter, and that nothing is ever cut off.
 *
 *   npm run test:statements            (add --keep to keep the output folder, --pdf to also render PDFs)
 */
process.env.TZ = process.env.TZ || 'America/Los_Angeles';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const keep = process.argv.includes('--keep'), pdf = process.argv.includes('--pdf');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statements-demo-'));
const dbPath = path.join(dir, 'demo.db'), out = path.join(dir, 'out'), budgets = path.join(dir, 'budgets.json');
fs.writeFileSync(budgets, JSON.stringify({ Groceries: 1100, Restaurants: 400, Shopping: 500 }));
execFileSync('node', [path.join(ROOT, 'scripts', 'pfs', 'demo', 'make-demo-db.js'), dbPath, '--as-of', '2026-10-05', '--history'], { env: process.env });

const build = (extra, db = dbPath) => spawnSync('node', [path.join(__dirname, 'build.js'), '--db', db, '--out', out, '--budgets', budgets,
  '--profile', path.join(dir, 'none.json'), ...(pdf ? [] : ['--no-pdf']), ...extra], { env: process.env, encoding: 'utf8' });
const snapAt = p => JSON.parse(fs.readFileSync(path.join(out, p, 'snapshot.json'), 'utf8'));
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });
const near = (a, b) => Math.abs(a - b) < 0.005;

// 1. Issue September
let r = build(['--month', '2026-09', '--kind', 'issued', '--issued-at', '2026-10-05T16:00:00Z']);
check('September issues', r.status === 0, r.stderr);
const sep = snapAt('issued/2026-09/rev-1');
const line = id => (sep.bridge.lines.find(l => l.id === id) || {}).amount || 0;
check('bridge opens and closes on the demo balances', near(sep.bridge.open, 689851.97) && near(sep.bridge.close, 702900), `${sep.bridge.open} → ${sep.bridge.close}`);
check('bridge closes with nothing unexplained', !sep.bridge.lines.some(l => l.id === 'other'));
check('money in and out', near(sep.cashFlow.in, 11174) && near(sep.cashFlow.out, 6875.23), `${sep.cashFlow.in} / ${sep.cashFlow.out}`);
check('mortgage principal from the loan balance', near(line('principal'), 913.39), line('principal'));
check('401(k) contributions counted as saved from pay', near(line('payContrib'), 1893), line('payContrib'));
check('home estimate on its own line', near(line('home'), 2000) && sep.bridge.lines.find(l => l.id === 'home').estimate);
check('every check in the snapshot passed', sep.checks.passed, sep.checks.fails.join('; '));
check('category totals sum to money out', near(sep.categories.reduce((a, c) => a + c.amount, 0), sep.cashFlow.out));
check('account changes sum to the net worth change', near(sep.accounts.reduce((a, x) => a + (x.change || 0), 0), sep.bridge.change));
check('running balances land on the synced closing balances', sep.detail.every(d => d.difference === 0 && near(d.computedClose, d.closing)), sep.detail.map(d => d.difference).join(','));
check('typical month from the prior 5 months', sep.typical && sep.typical.periods === 5, sep.typical && sep.typical.periods);
check('over-budget restaurants called out', sep.callouts.some(c => /Restaurants .* over the \$400 budget/.test(c.text)));
check('card paid in full', sep.cards.length === 1 && sep.cards[0].status === 'paid in full', sep.cards.map(c => c.status));
check('recurring bills found, shopping not among them', sep.recurring.items.some(i => /MORTGAGE/.test(i.name)) && !sep.recurring.items.some(i => /ONLINE STORE/.test(i.name)));
check('at most five callouts', sep.callouts.length <= 5);
check('all institutions covered', sep.coverage.institutions.every(i => i.covered));
const html = fs.readFileSync(path.join(out, 'issued/2026-09/rev-1/statement.html'), 'utf8');
check('no ISO dates shown to readers', !/>[^<]*\b\d{4}-\d{2}-\d{2}\b[^<]*</.test(html));
check('no internal paths in the output', !/foliome\.db|config\/|data\/statements/i.test(html));
check('posted transactions only', /Posted transactions only/.test(html));

// 2. Frozen: a rebuild is revision 2, revision 1 untouched and read-only
const rev1 = fs.readFileSync(path.join(out, 'issued/2026-09/rev-1/snapshot.json'));
r = build(['--month', '2026-09', '--kind', 'issued', '--issued-at', '2026-10-06T16:00:00Z']);
check('a rebuild writes revision 2', r.status === 0 && fs.existsSync(path.join(out, 'issued/2026-09/rev-2/snapshot.json')), r.stderr);
check('revision 1 is byte-identical', Buffer.compare(rev1, fs.readFileSync(path.join(out, 'issued/2026-09/rev-1/snapshot.json'))) === 0);
check('issued files are read-only', (fs.statSync(path.join(out, 'issued/2026-09/rev-1/snapshot.json')).mode & 0o222) === 0);

// 3. Corrections carry forward: reclassify a September bill and post a late September charge, then issue October
const db = new Database(dbPath);
db.prepare("UPDATE transactions SET user_category = 'Childcare' WHERE description = 'CITY UTILITIES' AND date LIKE '2026-09-%'").run();
db.prepare("INSERT INTO transactions (institution, account_id, date, description, amount, category) VALUES ('demobank','demobank-credit-6001','2026-09-30','LATE POSTING CAFE',-18.5,'Restaurants')").run();
db.close();
r = build(['--month', '2026-10', '--kind', 'issued', '--issued-at', '2026-11-05T16:00:00Z']);
check('October issues', r.status === 0, r.stderr);
const oct = r.status === 0 ? snapAt('issued/2026-10/rev-1') : null;
check('October lists the reclassified September bill', oct && oct.corrections && oct.corrections.reclassified.some(x => /CITY UTILITIES/.test(x.description) && x.from === 'Utilities' && x.to === 'Childcare'));
check('October lists the late September posting', oct && oct.corrections && oct.corrections.late.some(x => /LATE POSTING CAFE/.test(x.description)));
check('September as issued is unchanged', Buffer.compare(rev1, fs.readFileSync(path.join(out, 'issued/2026-09/rev-1/snapshot.json'))) === 0);

// 4. Custom periods and the issued-month rule
r = build(['--from', '2026-07-01', '--to', '2026-09-30', '--kind', 'custom', '--issued-at', '2026-10-05T16:00:00Z']);
const q3 = r.status === 0 ? snapAt('custom/2026-07-01_2026-09-30/rev-1') : null;
check('a custom quarter builds and passes its checks', q3 && q3.checks.passed, r.stderr);
check('a custom period is labelled as a range', q3 && /Jul 1 – Sep 30, 2026/.test(q3.period.label), q3 && q3.period.label);
r = build(['--from', '2026-07-01', '--to', '2026-09-30', '--kind', 'issued']);
check('issued statements must be calendar months', r.status !== 0);

// 5. Never cut off: an inflated month (3x the transactions, 2 more accounts) still renders whole
const big = path.join(dir, 'big.db');
fs.copyFileSync(dbPath, big);
const bdb = new Database(big);
const sepRows = bdb.prepare("SELECT * FROM transactions WHERE date LIKE '2026-09-%' AND category != 'Transfer'").all();
const ins = bdb.prepare('INSERT INTO transactions (institution, account_id, date, description, amount, category) VALUES (?,?,?,?,?,?)');
for (const k of [1, 2]) for (const t of sepRows) ins.run(t.institution, t.account_id, t.date, `${t.description} ${k}`, t.amount, t.category);
const insB = bdb.prepare('INSERT INTO balances (institution, account_id, account_name, account_type, balance, synced_at) VALUES (?,?,?,?,?,?)');
for (const [id, nm] of [['demobank-checking-1003', 'Second Checking (...1003)'], ['demobank-credit-6002', 'Second Card (...6002)']])
  for (const d of ['2026-08-31', '2026-09-30']) insB.run('demobank', id, nm, id.includes('credit') ? 'credit' : 'checking', id.includes('credit') ? -100 : 500, new Date(`${d}T23:59:00`).toISOString());
bdb.close();
r = build(['--month', '2026-09', '--kind', 'preview', '--issued-at', '2026-10-05T16:00:00Z'], big);
check('an inflated month builds', r.status === 0, r.stderr);
const bigHtml = r.status === 0 ? fs.readFileSync(path.join(out, 'preview/2026-09/statement.html'), 'utf8') : '';
const css = (bigHtml.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
check('pages have no fixed height and never clip', !/section\s*{[^}]*\bheight\s*:/.test(css) && !/overflow\s*:\s*hidden[^}]*}\s*$/.test(css.split('.br-bar')[0]) && !/\.tile\s*{[^}]*\bheight\s*:/.test(css));
check('the inflated month shows every transaction', (bigHtml.match(/<tr class="(nc)?"><td>/g) || []).length >= sepRows.length * 3);
if (pdf) {
  const pages = f => +((execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/) || [])[1] || 0);
  check('the inflated month runs onto more pages', pages(path.join(out, 'preview/2026-09/statement.pdf')) > pages(path.join(out, 'issued/2026-09/rev-1/statement.pdf')));
}

const failed = checks.filter(c => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${!c.ok && c.detail ? ` (${String(c.detail).trim().slice(0, 300)})` : ''}`);
console.log(`\n${checks.length - failed.length}/${checks.length} passed${keep ? `; output kept in ${dir}` : ''}`);
if (!keep) fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
