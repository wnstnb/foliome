/**
 * Statement of activity: every number, computed from foliome.db.
 *
 * computeStatement(db, opts) → snapshot (plain JSON). No model, no network, no clock except opts.issuedAt.
 * The bridge closes by construction (its "other" line is the residual); the checks in checks() are the
 * consistency tests a statement must pass before it's issued.
 *
 * Boundaries are local midnights: a period from..to covers [from 00:00, to+1 00:00) in the machine's time zone.
 */

const DAY = 864e5;
const CARRY_DAYS = 62; // a balance older than this at a boundary is "not available"
const LOAN_TYPES = new Set(['mortgage', 'auto_loan', 'student_loan', 'personal_loan', 'heloc', 'loan']);
const GROUP_OF = t => t === 'checking' || t === 'savings' || t === 'cash' ? 'cash'
  : t === 'credit' ? 'credit'
  : t === 'real_estate' ? 'home'
  : LOAN_TYPES.has(t) ? 'loans'
  : 'investments';
const GROUP_ORDER = ['cash', 'credit', 'investments', 'home', 'loans'];
const NOT_SPENDING = new Set(['Transfer', 'Income']);

const r2 = x => Math.round(x * 100) / 100 + 0; // + 0 turns -0 into 0
const sum = xs => r2(xs.reduce((a, b) => a + b, 0));
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const localMidnight = d => new Date(`${d}T00:00:00`).toISOString();
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const isMonth = (from, to) => from.endsWith('-01') && addDays(to, 1).endsWith('-01') && from.slice(0, 7) === to.slice(0, 7);
const monthStart = (ym, back) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - back, 1)); return d.toISOString().slice(0, 10); };
const monthEnd = from => addDays(monthStart(from.slice(0, 7), -1), -1);
const recurKey = d => String(d || '').toUpperCase().replace(/[0-9#*.,:;\/\\_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const hasColumn = (db, table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
const hasTable = (db, table) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);

function accountsOf(db) {
  const rows = db.prepare(`SELECT b.account_id, b.institution, b.account_type, b.account_name FROM balances b
    INNER JOIN (SELECT account_id, MAX(synced_at) ms FROM balances GROUP BY account_id) m ON b.account_id = m.account_id AND b.synced_at = m.ms`).all();
  return rows.map(r => ({ id: r.account_id, institution: r.institution, type: r.account_type, name: r.account_name || null, group: GROUP_OF(r.account_type) }));
}

function balanceAt(db, accountId, iso) {
  const row = db.prepare('SELECT balance, synced_at FROM balances WHERE account_id = ? AND synced_at <= ? ORDER BY synced_at DESC LIMIT 1').get(accountId, iso);
  if (!row) return null;
  const ageDays = (Date.parse(iso) - Date.parse(row.synced_at)) / DAY;
  return { balance: r2(row.balance), syncedAt: row.synced_at, ageDays, stale: ageDays > CARRY_DAYS };
}

function firstBalanceAfter(db, accountId, fromIso, toIso) {
  return db.prepare('SELECT balance, synced_at FROM balances WHERE account_id = ? AND synced_at > ? AND synced_at <= ? ORDER BY synced_at ASC LIMIT 1').get(accountId, fromIso, toIso);
}

function txnsBetween(db, from, to) {
  const key = hasColumn(db, 'transactions', 'dedup_key') ? 'dedup_key' : "CAST(id AS TEXT)";
  return db.prepare(`SELECT id, ${key} AS key, account_id, date, description, amount, COALESCE(user_category, category, 'Uncategorized') AS category,
      CASE WHEN user_category IS NOT NULL THEN 'user' ELSE 'auto' END AS categorySource
    FROM transactions WHERE date >= ? AND date <= ? AND COALESCE(status, 'posted') = 'posted' ORDER BY date, id`).all(from, to)
    .map(t => ({ ...t, amount: r2(t.amount) }));
}

function invTxnsBetween(db, from, to) {
  if (!hasTable(db, 'investment_transactions')) return [];
  return db.prepare(`SELECT account_id, date, description, amount, COALESCE(user_category, type) AS kind FROM investment_transactions
    WHERE date >= ? AND date <= ? ORDER BY date`).all(from, to).map(t => ({ ...t, amount: r2(t.amount) }));
}

// Spending by category, money in and out, over any window
function flows(txns) {
  const inc = sum(txns.filter(t => t.category === 'Income').map(t => t.amount));
  const spend = txns.filter(t => !NOT_SPENDING.has(t.category));
  const out = r2(-sum(spend.map(t => t.amount)));
  const byCat = {};
  for (const t of spend) byCat[t.category] = r2((byCat[t.category] || 0) - t.amount);
  return { in: inc, out, left: r2(inc - out), byCat };
}

// Same-length windows before the period, newest first, that the transaction history fully covers
function priorWindows(db, from, to) {
  const first = db.prepare("SELECT MIN(date) d FROM transactions").get().d;
  if (!first) return [];
  const out = [];
  if (isMonth(from, to)) {
    for (let k = 1; k <= 12; k++) {
      const f = monthStart(from.slice(0, 7), k), t = monthEnd(f);
      if (f < first && daysBetween(first, f) < -3) break; // history must start by the 3rd of that month
      out.push({ from: f, to: t, label: f.slice(0, 7) });
    }
  } else {
    const len = daysBetween(from, to) + 1, n = Math.min(12, Math.floor(365 / len));
    for (let k = 1; k <= n; k++) {
      const t = addDays(from, -1 - (k - 1) * len), f = addDays(t, -(len - 1));
      if (f < first) break;
      out.push({ from: f, to: t, label: `${f}..${t}` });
    }
  }
  return out;
}

function typicalOf(db, from, to) {
  const wins = priorWindows(db, from, to);
  if (!wins.length) return null;
  const per = wins.map(w => ({ ...w, ...flows(txnsBetween(db, w.from, w.to)) }));
  const cats = [...new Set(per.flatMap(p => Object.keys(p.byCat)))];
  return {
    periods: per.length, from: per.at(-1).from, to: per[0].to,
    in: r2(median(per.map(p => p.in))), out: r2(median(per.map(p => p.out))), left: r2(median(per.map(p => p.left))),
    byCat: Object.fromEntries(cats.map(c => [c, r2(median(per.map(p => p.byCat[c] || 0)))])),
  };
}

function budgetsFor(budgets, from, to) {
  if (!budgets || !isMonth(from, to)) return {};
  const out = {};
  for (const [cat, v] of Object.entries(budgets)) {
    if (v && typeof v === 'object' && v.scope) continue; // scoped budgets (e.g. all cards) aren't category budgets
    const limit = typeof v === 'number' ? v : v && typeof v.limit === 'number' ? v.limit : null;
    if (limit != null) out[cat] = limit;
  }
  return out;
}

function recurring(db, from, to, txns) {
  if (!isMonth(from, to)) return { items: [], new: [], changed: [], stopped: [] };
  const prior = [1, 2, 3].map(k => { const f = monthStart(from.slice(0, 7), k); return txnsBetween(db, f, monthEnd(f)); });
  const outflow = t => t.amount < 0 && t.category !== 'Transfer';
  const keysIn = list => { const m = new Map(); for (const t of list.filter(outflow)) { const k = recurKey(t.description); if (!m.has(k)) m.set(k, []); m.get(k).push(t); } return m; };
  const now = keysIn(txns), before = prior.map(keysIn);
  const allKeys = new Set([...now.keys(), ...before.flatMap(m => [...m.keys()])]);
  const items = [], changed = [], stopped = [], fresh = [];
  for (const k of allKeys) {
    const seen = before.filter(m => m.has(k)).length;
    const cur = now.get(k);
    // Recurring = shows up most months at a steady amount (spending at the same store isn't a bill)
    const priorAmts = before.filter(m => m.has(k)).map(m => -sum(m.get(k).map(t => t.amount)));
    const counts = before.filter(m => m.has(k)).map(m => m.get(k).length);
    const steady = priorAmts.length >= 2 && Math.max(...counts) <= 2 && (Math.max(...priorAmts) - Math.min(...priorAmts)) <= 0.15 * median(priorAmts);
    if (seen >= 2 && cur && steady) {
      const amt = r2(-sum(cur.map(t => t.amount)));
      const prev = r2(median(before.filter(m => m.has(k)).map(m => -sum(m.get(k).map(t => t.amount)))));
      const it = { name: cur[0].description, day: +cur[0].date.slice(8), amount: amt, typical: prev, category: cur[0].category };
      items.push(it);
      if (Math.abs(amt - prev) > 1 && Math.abs(amt - prev) / prev > 0.05) changed.push(it);
    } else if (seen === 3 && !cur && steady) {
      const last = before[0].get(k);
      stopped.push({ name: last[0].description, amount: r2(-sum(last.map(t => t.amount))), lastDate: last.at(-1).date });
    } else if (seen === 0 && cur && cur[0].category === 'Subscription') {
      fresh.push({ name: cur[0].description, day: +cur[0].date.slice(8), amount: r2(-sum(cur.map(t => t.amount))) });
    }
  }
  items.sort((a, b) => a.day - b.day);
  return { items, new: fresh, changed, stopped };
}

function cardsOf(db, accts, txns, from, to) {
  const hasStmt = hasTable(db, 'statement_balances');
  return accts.filter(a => a.group === 'credit').map(a => {
    const t = txns.filter(x => x.account_id === a.id);
    const charges = r2(-sum(t.filter(x => x.amount < 0 && x.category !== 'Transfer').map(x => x.amount)));
    const credits = sum(t.filter(x => x.amount > 0 && x.category !== 'Transfer').map(x => x.amount));
    const payments = sum(t.filter(x => x.amount > 0 && x.category === 'Transfer').map(x => x.amount));
    const interest = r2(-sum(t.filter(x => x.amount < 0 && /interest/i.test(x.description)).map(x => x.amount)));
    const openOwed = a.opening == null ? null : r2(-a.opening), closeOwed = a.closing == null ? null : r2(-a.closing);
    // Paid in full is judged against the statement that came due in this period: one that closed 15–45 days
    // before the period ended. Without that statement, the payment is shown but not judged.
    let due = null, dueSource = null;
    if (hasStmt) {
      const st = db.prepare('SELECT closing_balance, period_end FROM statement_balances WHERE account_id = ? AND period_end >= ? AND period_end <= ? ORDER BY period_end DESC LIMIT 1')
        .get(a.id, addDays(from, -45), addDays(to, -15));
      if (st) { due = r2(Math.abs(st.closing_balance)); dueSource = `statement closing ${st.period_end}`; }
    }
    const status = due == null ? 'no statement' : due <= 0.005 ? 'nothing due' : payments >= due - 0.01 ? 'paid in full' : payments > 0 ? 'paid in part' : 'not paid';
    return { id: a.id, name: a.label, openOwed, charges, credits, payments, interest, closeOwed, due, dueSource, status };
  });
}

// Account names from banks can carry full account numbers: show last-4 only, everywhere.
function label(a) {
  const last4 = (a.id.match(/(\d{4})[A-Za-z]?$/) || [])[1];
  let base = a.name ? a.name.replace(/\s*\(?(\.\.\.|…)\d{4}\)?\s*$/, '') : `${titleCase(a.institution)} ${a.type}`;
  base = base.replace(/[#*x.]*\d{5,}/gi, '').replace(/\s{2,}/g, ' ').trim();
  base = base.replace(/\b([A-Z]{3,})\b/g, w => w.charAt(0) + w.slice(1).toLowerCase());
  return last4 && !base.includes(last4) ? `${base} …${last4}` : base;
}
const titleCase = slug => String(slug || '').split(/[-_ ]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * Pair up transfers so money moving between the household's own accounts nets out:
 *  - cash/card ↔ cash/card: equal and opposite amounts within 5 days (card payments, savings transfers)
 *  - cash → investment: a transfer out matched to an inflow of the same amount in an investment account's
 *    activity within 7 days (brokers often label these as journals, not contributions)
 * Whatever is left went to, or came from, accounts Foliome doesn't see.
 */
function matchTransfers(txns, inv, accts, edge = []) {
  const groupOf = id => (accts.find(a => a.id === id) || {}).group;
  const isCash = t => ['cash', 'credit'].includes(groupOf(t.account_id));
  const near = (a, b, days) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY;
  const tr = txns.filter(t => t.category === 'Transfer' && isCash(t)).map(t => ({ ...t, used: false }));
  const invUsed = new Set();
  const toInvestments = {}, fromInvestments = {}, unmatched = [];
  for (const t of tr.filter(x => x.amount < 0)) {
    const mate = tr.find(u => !u.used && u.amount > 0 && u.account_id !== t.account_id && Math.abs(u.amount + t.amount) < 0.005 && near(u.date, t.date, 5));
    if (mate) { mate.used = t.used = true; continue; }
    const i = inv.findIndex((x, k) => !invUsed.has(k) && x.amount > 0 && Math.abs(x.amount + t.amount) < 0.005 && near(x.date, t.date, 7) && groupOf(x.account_id) === 'investments');
    if (i >= 0) { invUsed.add(i); t.used = true; const a = inv[i].account_id; toInvestments[a] = r2((toInvestments[a] || 0) - t.amount); continue; }
  }
  for (const t of tr.filter(x => x.amount > 0 && !x.used)) {
    const i = inv.findIndex((x, k) => !invUsed.has(k) && x.amount < 0 && Math.abs(x.amount + t.amount) < 0.005 && near(x.date, t.date, 7) && groupOf(x.account_id) === 'investments');
    if (i >= 0) { invUsed.add(i); t.used = true; const a = inv[i].account_id; fromInvestments[a] = r2((fromInvestments[a] || 0) + t.amount); }
  }
  // The other side landed just outside the period: money in transit at a boundary, i.e. timing
  const transit = [];
  for (const t of tr.filter(x => !x.used)) {
    const mate = edge.find(u => u.category === 'Transfer' && isCash(u) && u.account_id !== t.account_id && Math.abs(u.amount + t.amount) < 0.005 && near(u.date, t.date, 5));
    (mate ? transit : unmatched).push({ date: t.date, description: t.description, amount: t.amount, account_id: t.account_id });
  }
  return { toInvestments, fromInvestments, unmatched, transit, unmatchedNet: sum(unmatched.map(u => u.amount)) };
}

/**
 * opts: { from, to, issuedAt (ISO), kind: 'issued'|'custom'|'preview', budgets, unseenSpendingNote, previous (snapshot|null), revision }
 */
function computeStatement(db, opts) {
  const { from, to } = opts;
  const openAt = localMidnight(from), closeAt = localMidnight(addDays(to, 1));
  const issuedAt = opts.issuedAt || new Date().toISOString();

  // Accounts and boundary balances
  const accts = accountsOf(db).map(a => {
    const o = balanceAt(db, a.id, openAt), c = balanceAt(db, a.id, closeAt);
    const acct = { ...a, label: label(a), opening: null, closing: null, openedInPeriod: null, closingAsOf: c ? c.syncedAt : null, notes: [] };
    if (c && !c.stale) acct.closing = c.balance;
    if (o && !o.stale) acct.opening = o.balance;
    else if (!o) {
      const f = firstBalanceAfter(db, a.id, openAt, closeAt);
      if (f) { acct.opening = 0; acct.openedInPeriod = f.synced_at.slice(0, 10); acct.notes.push(`opened ${f.synced_at.slice(0, 10)}`); }
    }
    if (o && o.stale) acct.notes.push(`no balance within ${CARRY_DAYS} days of the start`);
    if (c && c.stale) acct.notes.push(`no balance within ${CARRY_DAYS} days of the end`);
    if (!c && !o) return null; // no history at all inside or before the period
    return acct;
  }).filter(Boolean);
  for (const a of accts) a.change = a.opening != null && a.closing != null ? r2(a.closing - a.opening) : null;
  const inNW = accts.filter(a => a.change != null);
  const missing = accts.filter(a => a.change == null);

  // Transactions
  const txns = txnsBetween(db, from, to);
  const f = flows(txns);
  const inv = invTxnsBetween(db, from, to);

  // Investments: contributions, dividends, market change per account
  const edge = [...txnsBetween(db, addDays(from, -6), addDays(from, -1)), ...txnsBetween(db, addDays(to, 1), addDays(to, 6))];
  const moves = matchTransfers(txns, inv, accts, edge);
  const investing = inNW.filter(a => a.group === 'investments').map(a => {
    const mine = inv.filter(t => t.account_id === a.id);
    const fromPay = a.type === 'retirement';
    const recorded = sum(mine.filter(t => /contribution/i.test(t.kind)).map(t => Math.abs(t.amount)));
    const moved = moves.toInvestments[a.id] || 0, withdrawn = moves.fromInvestments[a.id] || 0;
    const contributions = r2(Math.max(recorded, moved)); // a broker may record the same deposit the cash side shows
    const dividends = sum(mine.filter(t => /dividend|interest/i.test(t.kind)).map(t => Math.abs(t.amount)));
    return { id: a.id, label: a.label, type: a.type, opening: a.opening, closing: a.closing, contributions, fromPay: fromPay && recorded > 0, payContributions: fromPay ? recorded : 0,
      movedIn: moved, withdrawn, dividends, market: r2(a.change - contributions + withdrawn) };
  });

  // The bridge
  const NWopen = sum(inNW.map(a => a.opening)), NWclose = sum(inNW.map(a => a.closing));
  const principal = sum(inNW.filter(a => a.group === 'loans').map(a => a.change));
  const payContrib = sum(investing.map(i => i.payContributions));
  // Money moved into investments from cash is already out of cash (a transfer, not spending) and into the account:
  // it nets to zero in net worth, so it isn't a bridge line. Pay contributions never touched cash, so they are.
  const movedOut = moves.unmatchedNet;
  const market = sum(investing.map(i => i.market));
  const home = sum(inNW.filter(a => a.group === 'home').map(a => a.change));
  const explained = r2(NWopen + f.in - f.out + principal + payContrib + market + home + movedOut);
  const other = r2(NWclose - explained);
  const bridge = {
    open: NWopen, close: NWclose, change: r2(NWclose - NWopen),
    lines: [
      { id: 'in', label: 'Money in', amount: f.in },
      { id: 'out', label: 'Money out', amount: -f.out },
      ...(principal ? [{ id: 'principal', label: 'Loan principal paid', note: 'part of the loan payments above that paid down debt', amount: principal }] : []),
      ...(payContrib ? [{ id: 'payContrib', label: 'Saved from paychecks', note: 'retirement contributions taken before payday', amount: payContrib }] : []),
      ...(investing.length ? [{ id: 'market', label: 'Market change', amount: market }] : []),
      ...(Math.abs(movedOut) >= 0.005 ? [{ id: 'untracked', label: movedOut < 0 ? 'Paid to accounts Foliome doesn\'t see' : 'Received from accounts Foliome doesn\'t see', note: 'transfers with no matching account here', amount: movedOut }] : []),
      ...(home ? [{ id: 'home', label: 'Home estimate', note: 'an estimate, not something you did', amount: home, estimate: true }] : []),
      ...(Math.abs(other) >= 0.005 ? [{ id: 'other', label: 'Timing and stale balances', note: 'transfers in transit at the start or end, balances not updated at month end', amount: other }] : []),
    ],
  };

  // Running balances for cash and cards (bank-statement style detail)
  const detail = inNW.concat(missing).filter(a => a.group === 'cash' || a.group === 'credit').map(a => {
    const rows = txns.filter(t => t.account_id === a.id);
    let bal = a.opening;
    const lines = rows.map(t => { if (bal != null) bal = r2(bal + t.amount); return { date: t.date, description: t.description, category: t.category, amount: t.amount, balance: bal, counted: !NOT_SPENDING.has(t.category) || t.category === 'Income' }; });
    const computedClose = bal;
    const diff = a.closing != null && computedClose != null ? r2(a.closing - computedClose) : null;
    return { id: a.id, label: a.label, group: a.group, opening: a.opening, closing: a.closing, computedClose, difference: diff && Math.abs(diff) >= 0.005 ? diff : 0, lines };
  });
  const quiet = inNW.filter(a => a.group === 'investments' || a.group === 'loans' || a.group === 'home').map(a => {
    const i = investing.find(x => x.id === a.id);
    const parts = [];
    if (i) { if (i.contributions) parts.push(`contributions ${i.contributions}`); parts.push(`market ${i.market}`); if (i.dividends) parts.push(`dividends ${i.dividends}`); }
    if (a.group === 'loans') parts.push(`principal paid ${a.change}`);
    if (a.group === 'home') parts.push(`estimate changed ${a.change}`);
    return { id: a.id, label: a.label, group: a.group, opening: a.opening, closing: a.closing, contributions: i ? i.contributions : 0, market: i ? i.market : null, dividends: i ? i.dividends : 0, principal: a.group === 'loans' ? a.change : null, home: a.group === 'home' ? a.change : null };
  });

  // Comparisons
  const typical = typicalOf(db, from, to);
  const budgets = budgetsFor(opts.budgets, from, to);
  const cats = Object.keys({ ...f.byCat, ...budgets }).map(c => ({
    category: c, amount: f.byCat[c] || 0, typical: typical ? typical.byCat[c] ?? 0 : null, budget: budgets[c] ?? null,
    ofBudget: budgets[c] ? (f.byCat[c] || 0) / budgets[c] : null,
  })).filter(c => c.amount || c.budget).sort((a, b) => b.amount - a.amount);
  const rec = recurring(db, from, to, txns);
  const cards = cardsOf(db, accts, txns, from, to);
  const largest = txns.filter(t => !(t.category === 'Transfer' && (/autopay|payment,? thank you|^payment/i.test(t.description))))
    .filter(t => !(t.category === 'Transfer' && t.amount > 0)) // show a transfer once, from the side money left
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 5)
    .map(t => ({ date: t.date, description: t.description, category: t.category, amount: t.amount, account: label(accts.find(a => a.id === t.account_id) || { id: t.account_id, institution: '', type: '' }) }));

  // Savings and debt lines (no projections; that's the PFS)
  const isRetire = a => a.type === 'retirement' || /ira|roth|401|403|457/i.test(a.id + ' ' + (a.name || ''));
  const grp = (lab, pred) => { const xs = inNW.filter(pred); return xs.length ? { label: lab, closing: sum(xs.map(a => a.closing)), change: sum(xs.map(a => a.change)) } : null; };
  const goals = [
    grp('Cash reserves', a => a.group === 'cash'),
    grp('Retirement accounts', a => a.group === 'investments' && isRetire(a)),
    grp('Education savings', a => a.type === 'education'),
    grp('Taxable investing', a => a.group === 'investments' && !isRetire(a) && a.type !== 'education'),
    grp('Debt left on loans', a => a.group === 'loans'),
  ].filter(Boolean);

  // Coverage: who synced, what's categorized, what we can't see
  const insts = [...new Set(accts.map(a => a.institution))];
  const coverage = {
    institutions: insts.map(inst => {
      const xs = accts.filter(a => a.institution === inst);
      const last = xs.map(a => a.closingAsOf).filter(Boolean).sort().at(-1) || null;
      const covered = last != null && Date.parse(last) >= Date.parse(closeAt) - 2 * DAY;
      const estimate = xs.every(a => a.group === 'home');
      return { institution: inst, lastUpdated: last, covered: covered || (estimate && last != null), estimate };
    }),
    uncategorized: txns.filter(t => t.category === 'Uncategorized').length,
    transactions: txns.length,
    homeEstimate: accts.some(a => a.group === 'home'),
    unseenSpending: opts.unseenSpendingNote || null,
    missingBalances: missing.map(a => ({ id: a.id, label: a.label, notes: a.notes })),
  };

  // Corrections since the last issued statement
  const corrections = correctionsSince(db, opts.previous);

  // Callouts: at most five, in priority order
  const callouts = [];
  const staleInst = coverage.institutions.filter(i => !i.covered && !i.estimate);
  if (staleInst.length) callouts.push({ kind: 'warn', text: `${listOf(staleInst.map(i => `${titleCase(i.institution)} (last updated ${i.lastUpdated ? i.lastUpdated.slice(0, 10) : 'never'})`))}: newer activity may not be synced yet.` });
  if (Math.abs(other) > 1) callouts.push({ kind: 'warn', text: `${fmtMoney(Math.abs(other))} of the net worth change is timing: transfers in transit at the start or end, or a balance not updated at month end.` });
  if (coverage.uncategorized) callouts.push({ kind: 'warn', text: `${coverage.uncategorized} transaction${coverage.uncategorized > 1 ? 's' : ''} still uncategorized.` });
  for (const c of cats.filter(c => c.budget && c.amount > c.budget)) callouts.push({ kind: 'warn', text: `${c.category} ${fmtMoney(c.amount)}, ${fmtMoney(c.amount - c.budget)} over the ${fmtMoney(c.budget)} budget.` });
  if (typical && typical.out) {
    const d = r2(f.out - typical.out), pctd = Math.abs(d) / typical.out;
    if (pctd >= 0.03) callouts.push({ kind: d < 0 ? 'ok' : 'warn', text: `Spent ${fmtMoney(Math.abs(d))} ${d < 0 ? 'less' : 'more'} than a typical ${isMonth(from, to) ? 'month' : 'period'} (${fmtMoney(f.out)} vs ${fmtMoney(typical.out)}).` });
  }
  for (const t of txns.filter(t => t.category === 'Transfer' && t.amount <= -1000 && !/autopay|payment/i.test(t.description))) callouts.push({ kind: 'ok', text: `Moved ${fmtMoney(-t.amount)}: ${t.description} on ${t.date}.` });
  for (const n of rec.new) callouts.push({ kind: 'note', text: `New recurring charge: ${n.name}, ${fmtMoney(n.amount)}.` });
  for (const c of rec.changed) callouts.push({ kind: 'note', text: `${c.name} changed: ${fmtMoney(c.amount)} vs ${fmtMoney(c.typical)} usually.` });
  for (const c of cards.filter(c => c.status === 'paid in part' || c.status === 'not paid')) callouts.push({ kind: 'warn', text: `${c.name}: ${c.status} (${fmtMoney(c.payments)} of ${fmtMoney(c.due)} due).` });
  for (const c of cards.filter(c => c.status === 'paid in full')) callouts.push({ kind: 'ok', text: `${c.name} paid in full: ${fmtMoney(c.payments)}.` });
  if (!rec.new.length && !rec.changed.length && !rec.stopped.length && rec.items.length) callouts.push({ kind: 'note', text: 'No new, changed or stopped recurring charges.' });

  const snapshot = {
    schema: 1,
    kind: opts.kind || 'custom',
    period: { from, to, label: periodLabel(from, to), isMonth: isMonth(from, to), openAt, closeAt },
    issuedAt, revision: opts.revision || 1,
    bridge, cashFlow: { in: f.in, out: f.out, left: f.left, payContrib }, typical,
    categories: cats, recurring: rec, cards, largest,
    accounts: GROUP_ORDER.flatMap(g => accts.filter(a => a.group === g)).map(a => ({ id: a.id, label: a.label, group: a.group, type: a.type, institution: a.institution, opening: a.opening, closing: a.closing, change: a.change, closingAsOf: a.closingAsOf, notes: a.notes })),
    investing: { accounts: investing, contributions: sum(investing.map(i => i.contributions)), payContrib, dividends: sum(investing.map(i => i.dividends)), market, openingInvested: sum(investing.map(i => i.opening)) },
    untracked: moves.unmatched, transit: moves.transit,
    goals, coverage, corrections, callouts: callouts.slice(0, 5), calloutsAll: callouts,
    detail, quiet,
    transactions: txns.map(t => ({ key: t.key, account_id: t.account_id, date: t.date, description: t.description, amount: t.amount, category: t.category })),
  };
  snapshot.checks = checks(snapshot);
  return snapshot;
}

function correctionsSince(db, prev) {
  if (!prev) return null;
  const { from, to } = prev.period;
  const now = txnsBetween(db, from, to);
  const byKey = new Map(now.map(t => [t.key, t]));
  const prevByKey = new Map((prev.transactions || []).map(t => [t.key, t]));
  const reclassified = [], late = [], removed = [];
  for (const [k, p] of prevByKey) {
    const n = byKey.get(k);
    if (!n) removed.push(p);
    else if (n.category !== p.category) reclassified.push({ date: n.date, description: n.description, amount: n.amount, from: p.category, to: n.category });
  }
  for (const [k, n] of byKey) if (!prevByKey.has(k)) late.push({ date: n.date, description: n.description, amount: n.amount, category: n.category });
  const balances = [];
  for (const a of prev.accounts || []) {
    if (a.closing == null) continue;
    const b = balanceAt(db, a.id, prev.period.closeAt);
    if (b && !b.stale && Math.abs(b.balance - a.closing) >= 0.005) balances.push({ id: a.id, label: a.label, was: a.closing, now: b.balance });
  }
  const before = Object.fromEntries((prev.categories || []).map(c => [c.category, c.amount]));
  const after = flows(now).byCat;
  const effect = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .map(c => ({ category: c, was: before[c] || 0, now: after[c] || 0 })).filter(e => Math.abs(e.now - e.was) >= 0.005)
    .map(e => ({ ...e, change: r2(e.now - e.was) }));
  const empty = !reclassified.length && !late.length && !removed.length && !balances.length;
  return empty ? null : { period: prev.period, reclassified, late, removed, balances, effect };
}

function checks(s) {
  const fails = [];
  const near = (a, b) => Math.abs(a - b) < 0.005;
  const bridgeSum = r2(s.bridge.open + sum(s.bridge.lines.map(l => l.amount)));
  if (!near(bridgeSum, s.bridge.close)) fails.push(`bridge reaches ${bridgeSum}, not the closing net worth ${s.bridge.close}`);
  const catSum = sum(s.categories.map(c => c.amount));
  if (!near(catSum, s.cashFlow.out)) fails.push(`category totals ${catSum} don't sum to money out ${s.cashFlow.out}`);
  const chg = sum(s.accounts.filter(a => a.change != null).map(a => a.change));
  if (!near(chg, s.bridge.change)) fails.push(`account changes ${chg} don't sum to the net worth change ${s.bridge.change}`);
  for (const d of s.detail) if (d.closing != null && d.computedClose != null && !near(d.computedClose + d.difference, d.closing))
    fails.push(`${d.label}: running balance ${d.computedClose} + difference ${d.difference} doesn't land on ${d.closing}`);
  if (s.kind === 'issued' && s.coverage.missingBalances.length)
    fails.push(`no balance near a boundary for ${s.coverage.missingBalances.map(m => m.label).join(', ')}`);
  return { passed: !fails.length, fails };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function periodLabel(from, to) {
  if (isMonth(from, to)) return `${MONTH[+from.slice(5, 7) - 1]} ${from.slice(0, 4)}`;
  const d = x => `${MON[+x.slice(5, 7) - 1]} ${+x.slice(8)}`;
  return from.slice(0, 4) === to.slice(0, 4) ? `${d(from)} – ${d(to)}, ${to.slice(0, 4)}` : `${d(from)}, ${from.slice(0, 4)} – ${d(to)}, ${to.slice(0, 4)}`;
}
const listOf = xs => xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
function fmtMoney(x) { return `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: Math.abs(x) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`; }

module.exports = { computeStatement, periodLabel, isMonth, addDays, monthStart, monthEnd, localMidnight };
