/**
 * HTML for a statement of activity. Print-first (US Letter), same bento look as the PFS.
 * Summary pages never use fixed heights: a page that runs long continues on the next one,
 * so nothing is ever cut off. Transaction detail flows across as many pages as it needs.
 */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = d => `${MON[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}`;
const longDate = d => `${shortDate(d)}, ${d.slice(0, 4)}`;
// Readers never see ISO dates: rewrite YYYY-MM-DD in visible text to "Sep 29"
const readerDates = html => html.replace(/>([^<]+)</g, (m, t) => `>${t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, d => shortDate(d))}<`);

const money = (x, { sign = false, cents = true } = {}) => {
  if (x == null) return '—';
  const v = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}$${v}`;
};
const whole = (x, o = {}) => money(Math.round(x ?? 0), { ...o, cents: false });
const BADGE = { ok: '✓', warn: '!', note: 'i' };
const badge = k => `<span class="bdg bdg-${k}">${BADGE[k]}</span>`;
const titleCase = slug => String(slug || '').split(/[-_ ]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
const GROUP_LABEL = { cash: 'Cash', credit: 'Credit cards', investments: 'Investments', home: 'Home', loans: 'Loans' };

function render(s) {
  const p = s.period, b = s.bridge, cf = s.cashFlow, t = s.typical;
  const unit = p.isMonth ? 'month' : 'period';
  const head = (title, n) => `<div class="p-head"><h1>${esc(title)} <span class="per">${esc(p.label)}</span></h1><span class="muted">${longDate(p.from)} – ${longDate(p.to)} · ${s.kind === 'issued' ? `issued ${longDate(s.issuedAt.slice(0, 10))}` : s.kind === 'preview' ? 'preview, not issued' : `generated ${longDate(s.issuedAt.slice(0, 10))}`}${s.revision > 1 ? ` · revision ${s.revision}` : ''}</span></div>`;
  const foot = n => `<div class="p-foot"><span>Statement of activity from synced data. ${s.kind === 'issued' ? 'Frozen on issue: corrections show up in the next statement.' : 'Not an issued statement.'}</span><span>${n}</span></div>`;

  // ── Page 1: the period at a glance ──
  const maxAbs = Math.max(...b.lines.map(l => Math.abs(l.amount)), 1);
  const bridgeRows = [
    `<div class="br-base"><span>Net worth, ${shortDate(p.from)}</span><span class="num">${money(b.open)}</span></div>`,
    ...b.lines.map(l => {
      const w = (Math.abs(l.amount) / maxAbs * 100).toFixed(1);
      const cls = l.estimate ? 'est' : l.id === 'other' ? 'oth' : l.amount < 0 ? 'neg' : 'pos';
      return `<div class="br-row"><span>${esc(l.label)}${l.note ? ` <span class="muted">· ${esc(l.note)}</span>` : ''}</span><span class="br-bar"><span class="${cls}" style="width:${w}%"></span></span><span class="num">${money(l.amount, { sign: true })}</span></div>`;
    }),
    `<div class="br-base"><span>Net worth, ${shortDate(p.to)}</span><span class="num">${money(b.close)}</span></div>`,
  ].join('');
  const homeLine = b.lines.find(l => l.id === 'home');
  const kpi = (q, v, sub) => `<div class="tile kpi"><span class="q">${q}</span><div><b>${v}</b><span class="muted">${sub}</span></div></div>`;
  const cov = s.coverage;
  const stale = cov.institutions.filter(i => !i.covered && !i.estimate);
  const strip = [
    stale.length ? `${badge('warn')}${stale.map(i => `${esc(titleCase(i.institution))} last updated ${i.lastUpdated ? shortDate(i.lastUpdated.slice(0, 10)) : 'never'}`).join('; ')}`
      : `${badge('ok')}All ${cov.institutions.filter(i => !i.estimate).length} institutions synced through ${shortDate(p.to)}`,
    cov.uncategorized ? `${badge('warn')}${cov.uncategorized} of ${cov.transactions} uncategorized` : `${badge('ok')}${cov.transactions} of ${cov.transactions} transactions categorized`,
    ...(cov.homeEstimate ? [`${badge('note')}Home value is an estimate`] : []),
    cov.unseenSpending ? `${badge('note')}${esc(cov.unseenSpending)}` : `${badge('ok')}Posted transactions only`,
    ...(cov.missingBalances.length ? [`${badge('warn')}No balance for ${cov.missingBalances.map(m => esc(m.label)).join(', ')}`] : []),
  ].map(x => `<span>${x}</span>`).join('');

  const page1 = `<section class="first">${head('Statement of Activity')}
  <div class="bento">
    <div class="tile hero"><span class="q">Net worth, ${shortDate(p.to)}</span><div><b>${whole(b.close)}</b><span class="delta">${b.change >= 0 ? '▲' : '▼'} ${whole(b.change, { sign: true })} this ${unit}</span></div>
      <span class="q">${homeLine ? `${whole(b.change - homeLine.amount, { sign: true })} without the home estimate.` : '&nbsp;'}</span></div>
    ${kpi('Money in', whole(cf.in), 'income, all accounts')}
    ${kpi('Money out', whole(cf.out), 'spending, mortgage included')}
    ${kpi('Left over', whole(cf.left), t ? `typical ${unit}: ${whole(t.left)}` : 'no typical yet')}
    ${kpi('Saved from pay', whole(cf.payContrib), cf.payContrib ? 'retirement, before payday' : 'none recorded')}
  </div>
  <div class="tile"><div class="tile-h"><b>How net worth changed</b><span class="muted">ties to the dollar</span></div><div class="bridge">${bridgeRows}</div>
    <div class="legend-row"><span><span class="sw pos"></span>Added</span><span><span class="sw neg"></span>Taken away</span>${homeLine ? '<span><span class="sw est"></span>Estimate</span>' : ''}<span>Bars to scale against the largest line.</span></div></div>
  <div class="tile"><div class="tile-h"><b>Worth knowing</b><span class="muted key">${badge('ok')} good ${badge('warn')} look ${badge('note')} note</span></div>
    ${s.callouts.length ? s.callouts.map(c => `<div class="co">${badge(c.kind)}<span>${esc(c.text)}</span></div>`).join('') : '<div class="co muted">Nothing unusual this period.</div>'}</div>
  <div class="tile strip"><b>What this covers</b>${strip}</div>
  ${foot('Page 1')}</section>`;

  // ── Page 2: where it went ──
  const corr = s.corrections;
  const corrTile = corr ? `<div class="tile"><div class="tile-h"><b>Changed since last statement</b><span class="muted">${esc(corr.period.label)}</span></div>
    <table><tbody>
    ${corr.reclassified.map(r => `<tr><td>${r.date}</td><td>${esc(r.description)}</td><td>${esc(r.from)} → ${esc(r.to)}</td><td class="num">${money(r.amount)}</td></tr>`).join('')}
    ${corr.late.map(r => `<tr><td>${r.date}</td><td>${esc(r.description)}</td><td>posted after issue · ${esc(r.category)}</td><td class="num">${money(r.amount)}</td></tr>`).join('')}
    ${corr.removed.map(r => `<tr><td>${r.date}</td><td>${esc(r.description)}</td><td>no longer at the bank</td><td class="num">${money(r.amount)}</td></tr>`).join('')}
    ${corr.balances.map(r => `<tr><td></td><td>${esc(r.label)}</td><td>closing balance corrected</td><td class="num">${money(r.was)} → ${money(r.now)}</td></tr>`).join('')}
    </tbody></table>
    ${corr.effect.length ? `<p class="muted small">Effect on ${esc(corr.period.label)}'s totals: ${corr.effect.map(e => `${esc(e.category)} ${money(e.change, { sign: true })}`).join(' · ')}. That statement stays as issued.</p>` : ''}</div>` : '';
  const hasBudget = s.categories.some(c => c.budget);
  const catRows = s.categories.map(c => {
    const pct = c.ofBudget != null ? Math.round(c.ofBudget * 100) : null;
    const over = pct != null && pct > 100;
    return `<tr><td>${esc(c.category)}</td><td class="num">${whole(c.amount)}</td><td class="num muted">${c.typical != null ? whole(c.typical) : '—'}</td>${hasBudget ? `<td class="num muted">${c.budget ? whole(c.budget) : '—'}</td>
      <td>${pct != null ? `<span class="ob"><span class="ob-bar"><span class="${over ? 'neg' : 'pos'}" style="width:${Math.min(pct, 100)}%"></span></span><span class="num">${pct}%</span>${over ? badge('warn') : ''}</span>` : '<span class="muted">no budget set</span>'}</td>` : ''}</tr>`;
  }).join('');
  const notCounted = s.transactions.filter(x => x.category === 'Transfer' && x.amount < 0);
  const recur = s.recurring;
  const short = x => { const t = String(x).replace(/\s+/g, ' ').trim(); return t.length > 44 ? `${t.slice(0, 42).trim()}…` : t; };
  const more = (n, what) => n > 0 ? `<div class="li muted"><span>and ${n} more ${what}</span><span></span></div>` : '';
  const RCAP = 12, NCAP = 3;
  const recurTile = `<div class="tile long"><div class="tile-h"><b>Recurring</b><span class="muted">${recur.changed.length || recur.new.length || recur.stopped.length ? `${recur.new.length} new · ${recur.changed.length} changed · ${recur.stopped.length} stopped` : 'no changes'}</span></div>
    ${recur.items.length ? recur.items.slice(0, RCAP).map(r => `<div class="li"><span>${esc(short(r.name))} <span class="muted">· ${ordinal(r.day)}</span>${recur.changed.includes(r) ? ` ${badge('note')}` : ''}</span><span class="num">${whole(r.amount)}</span></div>`).join('') + more(recur.items.length - RCAP, 'recurring') : '<div class="li muted">Not enough history yet.</div>'}
    ${recur.new.slice(0, NCAP).map(r => `<div class="li"><span>${badge('note')} New: ${esc(short(r.name))}</span><span class="num">${whole(r.amount)}</span></div>`).join('')}${more(recur.new.length - NCAP, 'new')}
    ${recur.stopped.slice(0, NCAP).map(r => `<div class="li"><span>${badge('note')} Stopped: ${esc(short(r.name))} <span class="muted">· last ${r.lastDate}</span></span><span class="num">${whole(r.amount)}</span></div>`).join('')}${more(recur.stopped.length - NCAP, 'stopped')}</div>`;
  const largestTile = `<div class="tile"><div class="tile-h"><b>Largest this ${unit}</b></div>${s.largest.map(x => `<div class="li3"><span class="muted">${x.date}</span><span>${esc(short(x.description))}</span><span class="num">${x.category === 'Transfer' ? `${whole(-x.amount)} moved` : money(x.amount, { sign: true })}</span></div>`).join('')}</div>`;
  const cardsTile = s.cards.length ? `<div class="tile"><div class="tile-h"><b>Credit cards</b></div><div class="cards-grid">${s.cards.map(c => `<div>
      <div class="card-name">${esc(c.name)} <span class="muted">· ${c.status === 'no statement' ? 'statement balance not synced' : esc(c.status)}</span> ${badge(c.status === 'paid in full' || c.status === 'nothing due' ? 'ok' : c.status === 'no statement' ? 'note' : 'warn')}</div>
      <div class="li"><span>Owed, ${shortDate(p.from)}</span><span class="num">${money(c.openOwed)}</span></div>
      <div class="li"><span>New charges</span><span class="num">${money(c.charges, { sign: true })}</span></div>
      ${c.credits ? `<div class="li"><span>Refunds and credits</span><span class="num">${money(-c.credits)}</span></div>` : ''}
      <div class="li"><span>Payments</span><span class="num">${money(-c.payments)}</span></div>
      <div class="li bold"><span>Owed, ${shortDate(p.to)}</span><span class="num">${money(c.closeOwed)}</span></div>
      <div class="li muted"><span>Interest charged</span><span class="num">${money(c.interest)}</span></div></div>`).join('')}</div>
    <p class="muted small">Charges count as spending when made; the payment isn't counted again.</p></div>` : '';
  const page2 = `<section>${head('Where It Went')}${corrTile}
  <div class="tile"><div class="tile-h"><b>Where the money went</b><span class="muted">${t ? `typical = median of the prior ${t.periods} ${unit}${t.periods > 1 ? 's' : ''}` : 'no typical yet'}</span></div>
    <table class="cat"><thead><tr><th>Category</th><th class="num">${esc(p.isMonth ? MON[+p.from.slice(5, 7) - 1] : 'This period')}</th><th class="num">Typical</th>${hasBudget ? '<th class="num">Budget</th><th>Of budget</th>' : ''}</tr></thead>
    <tbody>${catRows}<tr class="total"><td>Total spending</td><td class="num">${whole(cf.out)}</td><td class="num">${t ? whole(t.out) : '—'}</td>${hasBudget ? '<td></td><td></td>' : ''}</tr></tbody></table>
    <p class="muted small">Not counted as spending: card payments and money moved between your own accounts${notCounted.length ? ` (${whole(-notCounted.reduce((a, x) => a + x.amount, 0))} this ${unit})` : ''}.${hasBudget ? ' Budgets show only where you set one.' : ''}</p></div>
  <div class="two">${recurTile}${largestTile}</div>
  ${cardsTile}
  ${foot('Page 2')}</section>`;

  // ── Page 3: accounts and investing ──
  const acctRows = ['cash', 'credit', 'investments', 'home', 'loans'].map(g => {
    const xs = s.accounts.filter(a => a.group === g);
    if (!xs.length) return '';
    return `<tr class="group"><td colspan="4">${GROUP_LABEL[g]}</td></tr>` + xs.map(a => `<tr><td>${esc(a.label)}${a.notes.length ? ` <span class="muted">· ${esc(a.notes.join('; '))}</span>` : ''}${a.closingAsOf && Date.parse(a.closingAsOf) < Date.parse(p.closeAt) - 2 * 864e5 && g !== 'home' ? ` <span class="muted">· last updated ${a.closingAsOf.slice(0, 10)}</span>` : ''}</td>
      <td class="num">${a.opening == null ? 'not available' : money(a.opening)}</td><td class="num">${a.closing == null ? 'not available' : money(a.closing)}</td><td class="num">${a.change == null ? '—' : money(a.change, { sign: true })}</td></tr>`).join('');
  }).join('');
  const inv = s.investing;
  const page3 = `<section>${head('Accounts and Investing')}
  <div class="tile"><div class="tile-h"><b>Accounts</b><span class="muted">opening and closing balance</span></div>
    <table class="acc"><thead><tr><th>Account</th><th class="num">${shortDate(p.from)}</th><th class="num">${shortDate(p.to)}</th><th class="num">Change</th></tr></thead>
    <tbody>${acctRows}<tr class="total"><td>Net worth</td><td class="num">${money(b.open)}</td><td class="num">${money(b.close)}</td><td class="num">${money(b.change, { sign: true })}</td></tr></tbody></table></div>
  <div class="two">
    <div class="tile"><div class="tile-h"><b>Investing</b></div>
      <div class="li"><span>Contributions <span class="muted">· ${inv.payContrib ? `${whole(inv.payContrib)} from pay` : 'none from pay'}</span></span><span class="num">${whole(inv.contributions)}</span></div>
      <div class="li"><span>Market change <span class="muted">· ${inv.openingInvested ? `${(inv.market / inv.openingInvested * 100).toFixed(2)}% on ${whole(inv.openingInvested)} at the start` : ''}</span></span><span class="num">${whole(inv.market, { sign: true })}</span></div>
      <div class="li"><span>Dividends and interest <span class="muted">· left in the accounts</span></span><span class="num">${whole(inv.dividends)}</span></div></div>
    <div class="tile"><div class="tile-h"><b>Savings and debt</b><span class="muted">projections are in the quarterly PFS</span></div>
      ${s.goals.map(g => { const debt = g.closing < 0; return `<div class="li"><span>${esc(g.label)} <span class="muted">· ${debt ? `${money(-g.change, { sign: true })} owed` : money(g.change, { sign: true })} this ${unit}</span></span><span class="num">${whole(Math.abs(g.closing))}</span></div>`; }).join('')}</div>
  </div>
  ${foot('Page 3 · transaction detail follows')}</section>`;

  // ── Transaction detail ──
  const detail = s.detail.map(d => {
    const credit = d.group === 'credit';
    const rows = d.lines.map(l => `<tr class="${l.counted ? '' : 'nc'}"><td>${l.date}</td><td>${esc(l.description)}</td><td>${esc(l.category)}${l.counted ? '' : ' · not counted'}</td>
      <td class="num">${credit ? money(-l.amount) : money(l.amount, { sign: true })}</td><td class="num">${l.balance == null ? '' : money(credit ? -l.balance : l.balance)}</td></tr>`).join('');
    const tIn = d.lines.filter(l => l.amount > 0).reduce((a, l) => a + l.amount, 0), tOut = -d.lines.filter(l => l.amount < 0).reduce((a, l) => a + l.amount, 0);
    return `<div class="acct"><div class="acct-h"><b>${esc(d.label)}</b><span class="muted">${credit ? `charges ${money(tOut)} · payments and credits ${money(tIn)}` : `in ${money(tIn)} · out ${money(tOut)}`} · ${d.lines.length} transactions</span></div>
      <table class="det"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="num">${credit ? 'Charge' : 'Amount'}</th><th class="num">${credit ? 'Owed' : 'Balance'}</th></tr></thead><tbody>
      <tr class="muted"><td>${shortDate(p.from)}</td><td>Opening ${credit ? 'balance owed' : 'balance'}</td><td></td><td></td><td class="num">${d.opening == null ? 'not available' : money(credit ? -d.opening : d.opening)}</td></tr>
      ${rows}
      ${d.difference ? `<tr class="muted"><td></td><td>Difference vs synced balance (timing, or activity not synced yet)</td><td></td><td class="num">${money(credit ? -d.difference : d.difference, { sign: true })}</td><td></td></tr>` : ''}
      <tr class="total"><td>${shortDate(p.to)}</td><td>Closing ${credit ? 'balance owed' : 'balance'}</td><td></td><td></td><td class="num">${d.closing == null ? 'not available' : money(credit ? -d.closing : d.closing)}</td></tr>
      </tbody></table></div>`;
  }).join('');
  const quiet = s.quiet.length ? `<div class="acct"><div class="acct-h"><b>Investments, loans and home</b><span class="muted">accounts with little or no activity</span></div><table class="det"><tbody>
    ${s.quiet.map(q => {
      const bits = [];
      if (q.contributions) bits.push(`contributions ${money(q.contributions)}`);
      if (q.market != null) bits.push(`market ${money(q.market, { sign: true })}`);
      if (q.dividends) bits.push(`dividends ${money(q.dividends)}`);
      if (q.principal != null) bits.push(`principal paid ${money(q.principal)}`);
      if (q.home != null) bits.push(`estimate ${money(q.home, { sign: true })}`);
      return `<tr><td>${esc(q.label)}</td><td class="muted">${bits.join(' · ')}</td><td class="num">${money(q.opening)} → ${money(q.closing)}</td></tr>`;
    }).join('')}</tbody></table></div>` : '';
  const page4 = `<section class="detail">${head('Transaction Detail')}
  <p class="muted lead">Every posted transaction, by account, the way a bank or card statement lists them. Running balances start from each account's ${shortDate(p.from)} balance and end on the closing balance on page 3. Card payments and transfers between your own accounts are listed but not counted as spending.</p>
  ${detail}${quiet}</section>`;

  return readerDates(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Statement of Activity · ${esc(p.label)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600;700&display=swap">
<style>
  @page { size: Letter; margin: 0.45in 0.55in; }
  :root { --display:'Space Grotesk', 'Helvetica Neue', Arial, sans-serif; --ink:#1d2433; --muted:#5f6b7a; --line:#e4e7ec; --hair:#f0f2f5; --navy:#1f4e79; --ok:#1f7a4d; --warn:#b5651d; }
  * { box-sizing: border-box; }
  body { font: 9.5pt/1.4 Inter, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; background: #fff; }
  section { break-before: page; display: flex; flex-direction: column; gap: 8px; }
  section.first { break-before: auto; }
  .p-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 2px; }
  .p-head h1 { font-family: var(--display); font-size: 15pt; margin: 0; white-space: nowrap; } .p-head h1 .per { font-weight: 500; color: var(--muted); margin-left: 6px; }
  .p-head .muted { font-size: 8pt; text-align: right; }
  .p-foot { display: flex; justify-content: space-between; gap: 12px; font-size: 8pt; color: var(--muted); border-top: 1px solid var(--line); padding-top: 5px; margin-top: 4px; }
  .muted { color: var(--muted); } .small { font-size: 8.5pt; margin: 4px 0 0; } .bold { font-weight: 700; } .lead { margin: 0 0 4px; max-width: 70ch; }
  .num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .bento { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .tile { border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; min-width: 0; break-inside: avoid; background: #fff; }
  .tile .q { font-size: 8.5pt; color: var(--muted); display: block; }
  .tile.kpi { display: flex; flex-direction: column; justify-content: space-between; gap: 4px; }
  .tile.kpi b { font-family: var(--display); font-size: 16pt; font-weight: 700; display: block; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .tile.kpi .muted { font-size: 8pt; display: block; }
  .tile.hero { grid-column: 1 / 3; grid-row: 1 / 3; background: #101828; border-color: #101828; color: #fff; display: flex; flex-direction: column; justify-content: space-between; gap: 8px; padding: 12px 16px; }
  .tile.hero .q { color: #98a2b3; } .tile.hero b { font-family: var(--display); font-size: 32pt; font-weight: 700; line-height: 1; letter-spacing: -.02em; display: block; font-variant-numeric: tabular-nums; }
  .tile.hero .delta { color: #6ee7b7; font-size: 9.5pt; display: block; margin-top: 5px; }
  .tile-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-bottom: 4px; } .tile-h b { font-family: var(--display); font-size: 10.5pt; } .tile-h .muted { font-size: 8pt; }
  .tile-h .key { display: inline-flex; gap: 6px; align-items: center; }
  .bridge { display: flex; flex-direction: column; }
  .br-base { display: flex; justify-content: space-between; font-weight: 700; padding: 4px 0; border-top: 1px solid var(--line); }
  .br-row { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) 84px; gap: 10px; align-items: center; padding: 3px 0; border-top: 1px solid var(--hair); }
  .br-bar, .ob-bar { display: block; height: 7px; background: #eef1f5; border-radius: 4px; overflow: hidden; }
  .br-bar > span, .ob-bar > span { display: block; height: 100%; border-radius: 4px; }
  .pos { background: var(--navy); } .neg { background: var(--warn); } .oth { background: #98a2b3; }
  .est { background: repeating-linear-gradient(45deg, #98a2b3 0 3px, #d0d5dd 3px 6px); }
  .legend-row { display: flex; gap: 14px; flex-wrap: wrap; font-size: 8pt; color: var(--muted); margin-top: 4px; align-items: center; }
  .sw { display: inline-block; width: 14px; height: 7px; border-radius: 2px; vertical-align: middle; margin-right: 5px; }
  .co { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; border-top: 1px solid var(--hair); }
  .strip { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; padding: 7px 12px; }
  .strip b { font-family: var(--display); font-size: 9.5pt; } .strip > span { display: inline-flex; gap: 6px; align-items: center; }
  .bdg { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; font-size: 8px; font-weight: 800; line-height: 1; flex: none; border: 1px solid; }
  .bdg-ok { background: #e7f4ec; border-color: #1f7a4d55; color: var(--ok); }
  .bdg-warn { background: #fbefe3; border-color: #b5651d55; color: var(--warn); }
  .bdg-note { background: #eef1f5; border-color: #98a2b355; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; }
  th { text-align: left; font-size: 8pt; font-weight: 600; color: var(--muted); border-bottom: 1px solid var(--line); padding: 3px 6px; }
  td { padding: 3px 6px; border-bottom: 1px solid var(--hair); vertical-align: top; }
  tr.group td { font-size: 8pt; font-weight: 700; color: var(--muted); border-top: 1px solid var(--line); padding-top: 6px; }
  tr.total td { font-weight: 700; border-top: 1px solid var(--line); border-bottom: none; }
  .ob { display: flex; align-items: center; gap: 6px; } .ob .ob-bar { flex: 1; min-width: 60px; } .ob .num { width: 34px; }
  .two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-items: start; }
  .tile.long { break-inside: auto; }
  .li { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; border-top: 1px solid var(--hair); }
  .li3 { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 8px; padding: 3px 0; border-top: 1px solid var(--hair); }
  .cards-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; }
  .card-name { font-weight: 600; padding-bottom: 3px; display: flex; gap: 6px; align-items: center; }
  .acct { margin-top: 10px; } .acct-h { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; border-bottom: 2px solid var(--ink); padding-bottom: 3px; }
  .acct-h b { font-family: var(--display); font-size: 11pt; }
  table.det thead { display: table-header-group; } table.det tr { break-inside: avoid; }
  table.det td:first-child { white-space: nowrap; width: 52px; color: var(--muted); }
  tr.nc td { color: #98a2b3; }

  @media screen { body { background: #f7f8fa; } section { max-width: 8.5in; margin: 0 auto; padding: 0.45in 0.55in; background: #fff; } section + section { margin-top: 12px; } }
  /* ── Phone: the same statement, read as a page (screen only; print keeps the letter layout) ── */
  @media screen and (max-width: 640px) {
    body { font-size: 14px; background: #f7f8fa; }
    section { padding: 16px; max-width: none; gap: 10px; }
    section + section { margin-top: 10px; }
    .p-head { flex-direction: column; align-items: flex-start; gap: 2px; }
    .p-head h1 { white-space: normal; font-size: 20px; } .p-head h1 .per { display: block; margin: 2px 0 0; font-size: 15px; }
    .p-head .muted { text-align: left; font-size: 12px; }
    .p-foot { flex-direction: column; font-size: 11px; }
    .bento { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .tile.hero { grid-column: 1 / 3; grid-row: auto; } .tile.hero b { font-size: 36px; }
    .tile.kpi b { font-size: 20px; } .tile .q, .tile.kpi .muted, .tile-h .muted { font-size: 12px; }
    .tile-h { flex-wrap: wrap; } .tile-h b { font-size: 15px; }
    .br-row { grid-template-columns: minmax(0, 1fr) 96px; row-gap: 4px; } .br-row > span:first-child { grid-column: 1 / 3; }
    .br-row .muted { display: block; font-size: 12px; }
    .two, .cards-grid { grid-template-columns: minmax(0, 1fr); }
    .strip { flex-direction: column; align-items: flex-start; }
    table { font-size: 13px; } thead, table.det thead { display: none; } tr { display: grid; padding: 7px 0; border-bottom: 1px solid var(--hair); } td { border: none; padding: 0; }
    table.cat tr { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "c a" "m m" "b b"; row-gap: 3px; }
    table.cat td:nth-child(1) { grid-area: c; } table.cat td:nth-child(2) { grid-area: a; font-weight: 600; }
    table.cat td:nth-child(3) { grid-area: m; text-align: left; font-size: 12px; } table.cat td:nth-child(3)::before { content: 'typical '; }
    table.cat td:nth-child(4) { display: none; } table.cat td:nth-child(5) { grid-area: b; } table.cat td:nth-child(5):has(> .muted) { display: none; }
    table.cat tr.total td:nth-child(3)::before { content: 'typical '; }
    table.acc tr { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "n n" "o d"; row-gap: 2px; }
    table.acc tr.group { display: block; } table.acc td:nth-child(1) { grid-area: n; }
    table.acc td:nth-child(2) { display: none; } table.acc td:nth-child(3) { grid-area: o; text-align: left; font-weight: 600; } table.acc td:nth-child(4) { grid-area: d; }
    table.det tr { grid-template-columns: 48px minmax(0, 1fr) auto; grid-template-areas: "d x a" "d c b"; column-gap: 8px; row-gap: 1px; }
    table.det td:nth-child(1) { grid-area: d; width: auto; } table.det td:nth-child(2) { grid-area: x; } table.det td:nth-child(3) { grid-area: c; font-size: 12px; color: var(--muted); }
    table.det td:nth-child(4) { grid-area: a; font-weight: 600; } table.det td:nth-child(5) { grid-area: b; font-size: 12px; color: var(--muted); }
    table.det tr.total, table.det tr.muted { grid-template-areas: "d x b" "d c a"; }
    .acct-h { flex-direction: column; align-items: flex-start; } .acct-h b { font-size: 16px; }
    .li, .li3 { font-size: 13px; } .co { font-size: 14px; }
  }
</style></head><body>${page1}${page2}${page3}${page4}</body></html>`);
}

function ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

module.exports = { render };
