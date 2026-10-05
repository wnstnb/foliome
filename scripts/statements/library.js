/**
 * The statements library behind the dashboard's Statements tab: lists what has been produced
 * (periodic statements and personal financial statements) and serves the frozen files through
 * short-lived signed links, so a Telegram Mini App can show and download them without the
 * session header a plain link can't carry.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const STATEMENTS = path.join(ROOT, 'data', 'statements');
const PFS = path.join(ROOT, 'data', 'pfs');
const SECRET = crypto.randomBytes(32); // per server process: a restart invalidates outstanding links
const LINK_TTL_MS = 5 * 60 * 1000;

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const dirs = p => { try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };
const revs = p => dirs(p).filter(d => /^rev-\d+$/.test(d)).map(d => +d.slice(4)).sort((a, b) => a - b);

function periodicList(kind) {
  const base = path.join(STATEMENTS, kind);
  return dirs(base).map(period => {
    const r = revs(path.join(base, period));
    if (!r.length) return null;
    const rev = r.at(-1), id = `statements/${kind}/${period}/rev-${rev}`;
    const s = readJson(path.join(ROOT, 'data', id, 'snapshot.json'));
    if (!s) return null;
    return {
      id, type: 'periodic', kind, period, rev, revisions: r.map(n => ({ rev: n, id: `statements/${kind}/${period}/rev-${n}` })),
      label: s.period.label, from: s.period.from, to: s.period.to, issuedAt: s.issuedAt,
      netWorth: s.bridge.close, netWorthChange: s.bridge.change, left: s.cashFlow.left, typicalLeft: s.typical ? s.typical.left : null,
      flags: (s.calloutsAll || s.callouts || []).filter(c => c.kind === 'warn').length,
      hasPdf: fs.existsSync(path.join(ROOT, 'data', id, 'statement.pdf')),
    };
  }).filter(Boolean).sort((a, b) => b.to.localeCompare(a.to));
}

function pfsEntry(rel, date, rev, revisions) {
  const s = readJson(path.join(ROOT, 'data', rel, 'snapshot.json'));
  if (!s) return null;
  const goals = s.goals || [];
  return {
    id: rel, type: 'financial', date, rev, revisions, label: s.scenario ? s.scenario.label : `Financial statement · ${date}`,
    scenario: s.scenario ? s.scenario.name : null, asOf: s.asOf || date, generatedAt: s.generatedAt || null,
    netWorth: s.explicit ? s.explicit.netWorth : null, surplus: s.extended ? s.extended.surplus : null,
    goalsOnPace: goals.filter(g => g.today && g.today.ok).length, goals: goals.length,
    topDecision: (s.decisions || [])[0] ? String((s.decisions || [])[0].text || (s.decisions || [])[0]).slice(0, 160) : null,
    hasPdf: fs.existsSync(path.join(ROOT, 'data', rel, 'statement.pdf')),
  };
}

function financialList() {
  const out = [], scenarios = [];
  for (const date of dirs(PFS).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse()) {
    const older = revs(path.join(PFS, date, 'revisions'));
    const revisions = [...older.map(n => ({ rev: n, id: `pfs/${date}/revisions/rev-${n}` })), { rev: older.length + 1, id: `pfs/${date}` }];
    const e = pfsEntry(`pfs/${date}`, date, older.length + 1, revisions);
    if (e) out.push(e);
    for (const sc of dirs(path.join(PFS, date, 'scenarios'))) { const x = pfsEntry(`pfs/${date}/scenarios/${sc}`, date, 1, []); if (x) scenarios.push(x); }
  }
  return { statements: out, scenarios };
}

// What the user has scheduled (config/schedules.json via /foliome-loop); null means on request only
function schedules() {
  const cfg = readJson(path.join(ROOT, 'config', 'schedules.json'));
  const list = Array.isArray(cfg) ? cfg : (cfg && cfg.schedules) || [];
  const find = cmd => list.find(x => x && x.enabled && x.command === cmd && typeof x.cron === 'string');
  const parse = e => {
    if (!e) return null;
    const [, , dom, mon] = e.cron.trim().split(/\s+/);
    const day = /^\d+$/.test(dom) ? +dom : null;
    const months = mon === '*' ? null : mon.split(',').filter(m => /^\d+$/.test(m)).map(Number);
    return day ? { day, months } : null;
  };
  return { periodic: parse(find('/statement')), financial: parse(find('/financial-statement')) };
}

function listStatements() {
  const issued = periodicList('issued'), custom = periodicList('custom');
  const fin = financialList();
  return {
    periodic: { issued, custom },
    financial: fin,
    schedule: schedules(),
    // Built only from issued statements, so it always agrees with the documents
    across: issued.slice().reverse().map(x => ({ period: x.period, label: x.label, netWorth: x.netWorth, left: x.left })),
  };
}

// Only these shapes can ever be signed or served
const ALLOWED = [
  /^statements\/(issued|custom)\/\d{4}-\d{2}(-\d{2}_\d{4}-\d{2}-\d{2})?\/rev-\d+$/,
  /^statements\/(issued|custom)\/\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\/rev-\d+$/,
  /^pfs\/\d{4}-\d{2}-\d{2}(\/revisions\/rev-\d+|\/scenarios\/[a-z0-9-]+)?$/,
];
const FILES = { html: 'statement.html', pdf: 'statement.pdf' };

function signLink(id, file) {
  if (!ALLOWED.some(re => re.test(id)) || !FILES[file]) return null;
  const abs = path.join(ROOT, 'data', id, FILES[file]);
  if (!abs.startsWith(path.join(ROOT, 'data') + path.sep) || !fs.existsSync(abs)) return null;
  const payload = Buffer.from(JSON.stringify({ id, file, exp: Date.now() + LINK_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, name: downloadName(id), expiresInSeconds: LINK_TTL_MS / 1000 };
}

function resolveLink(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig) return null;
  const want = crypto.createHmac('sha256', SECRET).update(payload).digest();
  let got; try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  let p; try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || Date.now() > p.exp || !ALLOWED.some(re => re.test(p.id)) || !FILES[p.file]) return null;
  const abs = path.join(ROOT, 'data', p.id, FILES[p.file]);
  if (!abs.startsWith(path.join(ROOT, 'data') + path.sep) || !fs.existsSync(abs)) return null;
  return { abs, file: p.file, name: downloadName(p.id) };
}

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function downloadName(id) {
  let m;
  if ((m = id.match(/^statements\/\w+\/(\d{4})-(\d{2})\/rev-(\d+)$/))) return `Foliome statement ${MONTH[+m[2] - 1]} ${m[1]}${+m[3] > 1 ? ` rev ${m[3]}` : ''}.pdf`;
  if ((m = id.match(/^statements\/\w+\/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\/rev-(\d+)$/))) return `Foliome statement ${m[1]} to ${m[2]}.pdf`;
  if ((m = id.match(/^pfs\/(\d{4}-\d{2}-\d{2})(?:\/scenarios\/([a-z0-9-]+))?/))) return `Foliome financial statement ${m[1]}${m[2] ? ` ${m[2]}` : ''}.pdf`;
  return 'Foliome statement.pdf';
}

// The statement page itself is self-contained; it only needs its fonts. Framed by the dashboard only.
const STATEMENT_CSP = [
  "default-src 'none'", "style-src 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com",
  "img-src data:", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'",
].join('; ');

module.exports = { listStatements, signLink, resolveLink, STATEMENT_CSP };
