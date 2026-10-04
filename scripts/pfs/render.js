/**
 * HTML renderer for the Personal Financial Statement. Print-first (US Letter),
 * answer-first. Synced facts, stated facts, and estimates are styled differently
 * so a reader can always tell which kind of number they're looking at.
 */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CLASS_LABEL = {
  cash: 'Cash', investments: 'Taxable investments', retirement: 'Retirement accounts',
  education: 'Education savings', home: 'Home', business: 'Business accounts',
  cards: 'Credit cards', mortgage: 'Mortgage', other: 'Other',
};
const TAX_LABEL = { taxable: 'Taxable', deferred: 'Tax-deferred', exempt: 'Tax-free', education: '529 (tax-free for school)', business: 'Business', property: '—', liability: '—' };


function chart({ w = 680, h = 280, x0, values, band, band2, lines = [], markers = [], yMaxCap, title }) {
  const pad = { l: 58, r: 14, t: 18, b: 30 };
  const n = values.length;
  const all = [...values, ...(band ? band.hi : []), ...lines.flatMap(l => l.values)].filter(v => isFinite(v));
  let yMax = Math.max(...all) * 1.05; if (yMaxCap) yMax = Math.min(yMax, yMaxCap);
  const X = i => pad.l + (i / (n - 1)) * (w - pad.l - pad.r);
  const Y = v => pad.t + (1 - Math.min(v, yMax) / yMax) * (h - pad.t - pad.b);
  const path = vals => vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(Math.max(0, v)).toFixed(1)}`).join('');
  const step = yMax > 4e6 ? 2e6 : yMax > 2e6 ? 1e6 : yMax > 8e5 ? 2e5 : yMax > 2e5 ? 1e5 : 5e4;
  let grid = '';
  for (let v = 0; v <= yMax; v += step) grid += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#e5e7eb"/><text x="${pad.l - 6}" y="${Y(v) + 3}" font-size="9" text-anchor="end" fill="#6b7280">${v >= 1e6 ? '$' + (v / 1e6).toFixed(v % 1e6 ? 1 : 0) + 'M' : '$' + Math.round(v / 1000) + 'K'}</text>`;
  let xt = '';
  for (let i = 0; i < n; i++) { const age = x0 + i; if (age % 5 === 0) xt += `<text x="${X(i)}" y="${h - pad.b + 13}" font-size="9" text-anchor="middle" fill="#6b7280">${age}</text>`; }
  const bandOf = bd => `${path(bd.hi)}${bd.lo.map((v, i) => i).reverse().map(i => `L${X(i).toFixed(1)},${Y(Math.max(0, bd.lo[i])).toFixed(1)}`).join('')}Z`;
  const bandPath = band ? `${path(band.hi)}${band.lo.map((v, i) => i).reverse().map(i => `L${X(i).toFixed(1)},${Y(Math.max(0, band.lo[i])).toFixed(1)}`).join('')}Z` : '';
  const mk = markers.map(m => `<line x1="${X(m.i)}" x2="${X(m.i)}" y1="${pad.t}" y2="${h - pad.b}" stroke="#1d2433" stroke-dasharray="3,3"/><text x="${X(m.i) + 4}" y="${pad.t + 10}" font-size="9" fill="#1d2433">${esc(m.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Helvetica, Arial, sans-serif">
    ${title ? `<text x="${pad.l}" y="11" font-size="10" font-weight="600" fill="#1d2433">${esc(title)}</text>` : ''}
    ${grid}${xt}<text x="${w - pad.r}" y="${h - 2}" font-size="9" text-anchor="end" fill="#6b7280">age</text>
    ${band2 ? `<path d="${bandOf(band2)}" fill="#c08a1e" fill-opacity="0.12"/>` : ''}
    ${band ? `<path d="${bandPath}" fill="#1f4e79" fill-opacity="0.13"/>` : ''}
    ${lines.map(l => `<path d="${path(l.values)}" fill="none" stroke="${l.color}" stroke-width="1.4" ${l.dash ? `stroke-dasharray="${l.dash}"` : ''}/>`).join('')}
    <path d="${path(values)}" fill="none" stroke="#1f4e79" stroke-width="2.2"/>
    ${mk}</svg>`;
}


// ── Page-1 visuals ──────────────────────────────────────────────────────────
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const longDate = d => { const [y, m, dd] = String(d).split('-'); return dd ? `${MON[+m - 1]} ${+dd}, ${y}` : m ? `${MON[+m - 1]} ${y}` : String(d); };
const shortDate = d => { const [, m, dd] = String(d).split('-'); return dd ? `${MON[+m - 1]} ${+dd}` : String(d); };
// Readers never see ISO dates: rewrite YYYY-MM-DD in visible text (not attributes) to "Oct 3, 2026"
const readerDates = html => html.replace(/>([^<]+)</g, (m, t) => `>${t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => longDate(d))}<`);
const AMBER = '#b5651d', GREEN = '#1f7a4d', NAVY = '#1f4e79', INK = '#1d2433';
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300']; // categorical order (validated: dataviz palette check)
// Status badges: icon shape carries the meaning (reads in black and white); one shared key per page
const BADGE = { ok: ['✓', 'On track'], behind: ['!', 'Behind plan'], self: ['✎', 'Self-reported: not in a linked account, so you tell us the amount'] };
const badge = k => `<span class="bdg bdg-${k}" title="${BADGE[k][1]}">${BADGE[k][0]}</span>`;
// pageKey: items are ['ok'|'behind'|'self'] badges, or { sw: css, text } swatches, or { html } as-is
const pageKey = items => `<div class="page-key">${items.map(i => typeof i === 'string' ? `<span>${badge(i)}${BADGE[i][1]}</span>` : i.html ? `<span>${i.html}</span>` : `<span><span class="sw" style="${i.sw}"></span>${i.text}</span>`).join('')}</div>`;
const CHART_KEY = [{ html: '<span class="lg-dash"></span>Plan, typical' }, { html: '<span class="lg-band"></span>1-in-10 to 9-in-10 markets' }, { html: '<span class="lg-dot"></span>Actual' }];
const noChartLegend = svg => svg.replace(/\s*<div class="chart-legend">[\s\S]*<\/div>\s*$/, '');
function progressBar(g, { height = 10, hatch = true } = {}) {
  const pctv = Math.max(0, Math.min(1, g.today.pct || 0));
  const col = g.today.ok ? GREEN : AMBER;
  return `<div class="pb" style="height:${height}px"><div class="pb-fill" style="width:${(pctv * 100).toFixed(1)}%;background:${col}"></div>${hatch && pctv < 1 ? `<div class="pb-gap" style="left:${(pctv * 100).toFixed(1)}%"></div>` : ''}${g.tick ? `<div class="pb-tick" style="left:${(g.tick * 100).toFixed(1)}%"></div>` : ''}</div>`;
}
function zoomChart(t, fmtK) {
  if (!t || !t.plan) return '';
  const W = 340, H = 200, L = 46, R = 10, T = 14, B = 28;
  const yrs = d => (new Date(d) - new Date(t.baselineDate)) / (365.25 * 86400000);
  const now = yrs(t.actual[t.actual.length - 1].date);
  const span = Math.max(2, Math.ceil(now + 1));
  const med = x => { const i = Math.min(Math.floor(x), t.plan.p50.length - 2), f = x - i; return t.plan.p50[i] * Math.pow(t.plan.p50[i + 1] / t.plan.p50[i], f); };
  const r10 = t.plan.p10[1] / t.plan.p50[1], r90 = t.plan.p90[1] / t.plan.p50[1];
  const band = (x, r) => med(x) * Math.pow(r, Math.sqrt(x));
  const vals = [...t.actual.map(a => a.value), band(span, r90), band(span, r10)];
  let lo = Math.min(...vals) * 0.95, hi = Math.max(...vals) * 1.02;
  const step = Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))) * ((hi - lo) / 4 / Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))) > 5 ? 10 : (hi - lo) / 4 / Math.pow(10, Math.floor(Math.log10((hi - lo) / 4))) > 2 ? 5 : 2);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const X = x => L + x / span * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const xs = Array.from({ length: span * 8 + 1 }, (_, i) => i / 8);
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(med(x)).toFixed(1)}`).join('');
  const bandD = 'M' + [...xs.map(x => `${X(x).toFixed(1)},${Y(band(x, r90)).toFixed(1)}`), ...xs.slice().reverse().map(x => `${X(x).toFixed(1)},${Y(band(x, r10)).toFixed(1)}`)].join(' L') + ' Z';
  let grid = '';
  for (let v = lo; v <= hi + 1; v += step) grid += `<line x1="${L}" x2="${W - R}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#e7eaf0"/><text x="${L - 6}" y="${(Y(v) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#5f6b7a">${fmtK(v)}</text>`;
  const mon = d => new Date(d).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }).replace(' ', " '");
  let xt = '';
  for (let k = 0; k <= span; k++) { const x = k; const d = new Date(new Date(t.baselineDate).getTime() + x * 365.25 * 86400000); xt += `<text x="${X(x).toFixed(1)}" y="${H - 10}" font-size="9" text-anchor="${k === 0 ? 'start' : k === span ? 'end' : 'middle'}" fill="#5f6b7a">${mon(d)}</text>`; }
  const pts = t.actual.map(a => [X(yrs(a.date)), Y(a.value)]);
  const last = t.actual[t.actual.length - 1], planNow = med(now), diff = last.value - planNow;
  const actualPath = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const lx = pts[pts.length - 1][0], ly = pts[pts.length - 1][1];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Helvetica, Arial, sans-serif">${grid}${xt}
    <path d="${bandD}" fill="${NAVY}" fill-opacity="0.10"/>
    <path d="${line}" fill="none" stroke="${NAVY}" stroke-width="2" stroke-dasharray="5,4"/>
    <line x1="${lx.toFixed(1)}" x2="${lx.toFixed(1)}" y1="${T}" y2="${H - B}" stroke="#1d2433" stroke-dasharray="2,3"/>
    ${pts.length > 1 ? `<path d="${actualPath}" fill="none" stroke="${INK}" stroke-width="2"/>` : ''}
    ${pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === pts.length - 1 ? 5 : 4}" fill="${INK}" stroke="#fff" stroke-width="2"/>`).join('')}
    <text x="${(lx + 8).toFixed(1)}" y="${(diff >= 0 ? ly - 34 : ly + 24).toFixed(1)}" font-size="11" font-weight="700" fill="${INK}" stroke="#fff" stroke-width="3" paint-order="stroke">Today ${fmtK(last.value)}${t.actual.length > 1 ? ` · ${fmtK(Math.abs(diff))} ${diff >= 0 ? 'ahead of' : 'behind'} plan` : ''}</text>
    <text x="${(W - R - 2).toFixed(1)}" y="${(Y(med(span)) - 6).toFixed(1)}" font-size="10" fill="${NAVY}" text-anchor="end">Plan</text></svg>
    <div class="chart-legend"><span><span class="lg-dash"></span>Plan, typical</span><span><span class="lg-band"></span>1-in-10 to 9-in-10 markets</span><span><span class="lg-dot"></span>Actual</span></div>`;
}
function spendingDonut(m, plan, fmt, fmtK) {
  if (!m || !m.groups) return '';
  const groups = m.groups.slice().sort((a, b) => b.total - a.total);
  const main = groups.slice(0, 4), rest = groups.slice(4);
  const shades = CAT;
  const short = n => n.split(/ and |,/)[0].replace(/^Subscriptions$/, 'Bills');
  const slices = [...main.map((g, i) => ({ name: short(g.label), v: g.total, c: shades[i] })),
    ...(rest.length ? [{ name: 'Other', v: rest.reduce((a, g) => a + g.total, 0), c: shades[4] }] : []),
    ...(m.net > 0 ? [{ name: 'Left over', v: m.net, c: CAT[5], bold: true }] : [])];
  const tot = slices.reduce((a, x) => a + x.v, 0);
  const w = 340, h = 200, cx = 78, cy = 100, R = 58, r = 35;
  let a = -Math.PI / 2, paths = '';
  for (const sl of slices) {
    const da = 2 * Math.PI * sl.v / tot, a2 = a + da, lg = da > Math.PI ? 1 : 0;
    const p = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`;
    paths += `<path d="M${p(R, a)} A${R},${R} 0 ${lg} 1 ${p(R, a2)} L${p(r, a2)} A${r},${r} 0 ${lg} 0 ${p(r, a)} Z" fill="${sl.c}" stroke="#fff" stroke-width="2"/>`;
    a = a2;
  }
  const leg = slices.map((sl, i) => { const y = 52 + i * 17; return `<rect x="160" y="${y - 9}" width="9" height="9" rx="2" fill="${sl.c}"/><text x="175" y="${y}" font-size="10.5" fill="#1d2433"${sl.bold ? ' font-weight="700"' : ''}>${esc(sl.name)}</text><text x="332" y="${y}" font-size="10.5" text-anchor="end" fill="#1d2433"${sl.bold ? ' font-weight="700"' : ''}>${fmt(sl.v)}</text>`; }).join('');
  const need = plan ? plan.newMonthly : 0;
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Helvetica, Arial, sans-serif">
    <text x="8" y="12" font-size="10" font-weight="700" fill="#1d2433">Where the money goes</text>
    <text x="8" y="24" font-size="9" fill="#5f6b7a">per month, ${esc(m.label || '')}</text>
    ${paths}<text x="${cx}" y="${cy - 1}" font-size="11" font-weight="700" fill="#1d2433" text-anchor="middle">${fmtK(m.totalIn)}</text><text x="${cx}" y="${cy + 10}" font-size="8" fill="#5f6b7a" text-anchor="middle">in / mo</text>
    ${leg}
    ${m.net > 0 ? `<text x="160" y="${52 + slices.length * 17 + 14}" font-size="10" fill="${INK}" font-weight="700">${need <= m.net ? '✓' : '!'} Plan needs ${fmt(need)} of the</text><text x="160" y="${52 + slices.length * 17 + 27}" font-size="10" fill="${INK}" font-weight="700">${fmt(m.net)} left over each month.</text>` : ''}</svg>`;
}


// ── Page-1 card library: defaults are the "greatest hits"; profile.page1Cards can pin/swap ──
const CARD_DEFAULT = ['netWorth', 'income', 'spend', 'netCash'];
function cardLibrary(s, { fmt, fmtK }) {
  const e = s.explicit, m = s.period || s.monthly, pl = s.plan, R = s.review, x = s.extended;
  const per = m && m.short ? `${m.short} avg` : 'per month';
  const sign = v => (v >= 0 ? '+' : '−') + fmtK(Math.abs(v));
  const lib = {
    netWorth: () => ({ q: 'Net worth', v: fmtK(e.netWorth), sub: R ? `${sign(R.nwChange)} since ${R.from}` : `${fmtK(e.netWorthAfterTax)} after tax and selling costs` }),
    income: () => m && ({ q: 'Total income', v: fmt(m.totalIn), sub: `${per}, after tax` }),
    spend: () => m && ({ q: 'Total spend', v: fmt(m.totalOut), sub: `${per}${s.period && s.monthly && s.period.months !== s.monthly.months ? ` · ${s.monthly.months}-mo ${fmt(s.monthly.totalOut)}` : ''}, mortgage incl.` }),
    netCash: () => m && ({ q: 'Net cash', v: fmt(m.net), sub: `in minus out, ${per}` }),
    freeAfterGoals: () => m && pl && (() => { const f = m.net - pl.newMonthly; return { q: 'Free after goals', v: f >= 0 ? fmt(f) : `${fmt(-f)} short`, sub: `${fmt(m.net)} net cash − ${fmt(pl.newMonthly)} to goals`, }; })(),
    runway: () => ({ q: 'If income stopped', v: `${s.liquidity.runwayMonths.toFixed(0)} months`, sub: 'of spending covered by cash' }),
    surplus: () => ({ q: 'Essentials covered for life', v: x.surplus >= 0 ? `${fmtK(x.surplus)} spare` : 'Not yet', sub: 'lifetime surplus (see The full picture)' }),
    portfolioGrowth: () => R && (() => { const inv = (R.parts.find(p => /Investments/.test(p.label)) || {}).change || 0; const c = R.contributions || 0; return { q: 'Portfolio growth', v: sign(inv - c), sub: `markets only, since ${R.from}; ${sign(c)} contributions`}; })(),
    savingsRate: () => s.tax && pl && (() => { const contrib = (s.projection ? s.projection.contributions : 0) / 12; const r = (contrib + pl.newMonthly) / (s.tax.takeHome / 12 + contrib); return { q: 'Savings rate', v: `${Math.round(r * 100)}%`, sub: 'of pay to retirement and goals, with the plan' }; })(),
    goalsOnTrack: () => (s.goals || []).length && ({ q: 'Goals on track today', v: `${s.goals.filter(g => g.today.ok).length} of ${s.goals.length}`, sub: 'before the plan\'s actions' }),
    debtFree: () => (() => { const d = (s.goals || []).find(g => g.type === 'debt'); return d && { q: 'Mortgage-free', v: d.caption.replace(/^Paid off at ([\d.]+).*$/, 'age $1'), sub: 'at today\'s payment' }; })(),
  };
  const want = (s.profile.page1Cards && s.profile.page1Cards.length ? s.profile.page1Cards : CARD_DEFAULT);
  const extra = ['surplus', 'runway', 'freeAfterGoals', 'goalsOnTrack'];
  const out = [];
  for (const k of [...want, ...extra]) { if (out.length >= Math.max(4, want.length)) break; const c = lib[k] && lib[k](); if (c && !out.some(o => o.k === k)) out.push({ k, ...c }); }
  return out;
}

function render(s, { previous, base, goalRows, fmt, fmtK, pct, whatIfs, nameOf }) {
  const OWNER_LABEL = new Proxy({}, { get: (_, k) => nameOf(k) });
  const e = s.explicit, x = s.extended, p = s.profile;
  const hcTotal = x.humanCapital.reduce((a, h) => a + h.pv, 0);
  const lifestyle = x.implicitLiabs.find(i => i.id === 'lifestyle');
  const essentialsCovered = x.surplus > 0;
  const stoppers = whatIfs.filter(w => w.r.surplus < 0);

  const provenance = l => l.synced
    ? `<span class="src synced" title="${esc(l.source)}">synced ${esc(shortDate(l.asOf))}</span>`
    : `<span class="src stated" title="${esc(l.source)}">stated ${esc(shortDate(l.asOf))}</span>`;

  const classRows = (lines, sign) => {
    const groups = {};
    for (const l of lines) (groups[l.cls] ||= []).push(l);
    return Object.entries(groups).sort((a, b) => sign * (b[1].reduce((s, l) => s + l.balance, 0) - a[1].reduce((s, l) => s + l.balance, 0))).map(([cls, ls]) => `
      <tr class="group"><td colspan="4">${CLASS_LABEL[cls] || cls}</td><td class="num">${fmt(Math.abs(ls.reduce((s, l) => s + l.balance, 0)))}</td></tr>
      ${ls.sort((a, b) => sign * (b.balance - a.balance)).map(l => `
      <tr><td class="indent">${esc(l.label)}${l.last4 ? ` <span class="muted">…${esc(l.last4)}</span>` : ''}</td>
          <td>${OWNER_LABEL[l.owner] || esc(l.owner)}</td><td>${TAX_LABEL[l.taxType] || esc(l.taxType)}</td>
          <td>${provenance(l)}</td><td class="num">${fmt(Math.abs(l.balance))}</td></tr>`).join('')}`).join('');
  };

  const changed = previous
    ? (() => {
        const d = e.netWorth - previous.explicit.netWorth;
        const ds = x.surplus - previous.extended.surplus;
        return `<p>Since the last statement (${esc(longDate(previous.asOf))}): net worth ${d >= 0 ? 'up' : 'down'} <b>${fmtK(Math.abs(d))}</b>, surplus ${ds >= 0 ? 'up' : 'down'} <b>${fmtK(Math.abs(ds))}</b>.</p>`;
      })()
    : `<p class="muted">This is the first statement, so it is the baseline. Later reviews will show what changed and why: money saved, market moves, or changed assumptions.</p>`;

  return readerDates(`<!doctype html><html><head><meta charset="utf-8"><title>Personal Financial Statement · ${esc(longDate(s.asOf))}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;600;700&display=swap">
<style>
  @page { size: Letter; margin: 0.5in 0.6in; }
  :root { --display:'Space Grotesk', 'Helvetica Neue', Arial, sans-serif; --ink:#1d2433; --muted:#6b7280; --line:#e5e7eb; --accent:#1f4e79; --good:#1f7a4d; --bad:#a63d2f; --est:#7c5c12; --estbg:#fbf6e9; }
  * { box-sizing: border-box; }
  body { font: 10.5pt/1.45 Inter, "Helvetica Neue", Helvetica, Arial, sans-serif; color: var(--ink); margin: 0; background: #fff; }
  h1 { font-family: var(--display); font-size: 20pt; margin: 0 0 2px; color: var(--ink); }
  h2 { font-family: var(--display); font-size: 14pt; font-weight: 700; color: var(--ink); padding-bottom: 6px; border-bottom: 1px solid #e4e7ec; margin: 0 0 10px; }
  h2 small { font-weight: normal; color: var(--muted); font-size: 9pt; }
  h3 { font-family: var(--display); font-size: 11pt; margin: 14px 0 6px; }
  section { page-break-before: always; }
  section.first { page-break-before: auto; }
  .sub { color: var(--muted); margin-bottom: 14px; }
  .cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 10px 0 10px; }
  .card { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; }
  .card .q { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .card .a { font-size: 17pt; font-weight: 600; margin: 2px 0; }
  .card .why { font-size: 9pt; color: var(--muted); }
  .good { color: var(--good); } .bad { color: var(--bad); }
  table { width: 100%; border-collapse: collapse; margin: 4px 0 8px; font-size: 9pt; }
  th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); border-bottom: 1px solid var(--ink); padding: 4px 6px; }
  td { padding: 2px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr.group td { font-weight: 600; background: #f6f7f9; }
  tr.total td { font-weight: 700; border-top: 2px solid var(--ink); border-bottom: none; }
  tr.est td { background: var(--estbg); }
  td.indent { padding-left: 16px; }
  .muted { color: var(--muted); }
  .src { font-size: 8.5pt; padding: 1px 5px; border-radius: 3px; white-space: nowrap; }
  .src.synced { background: #e8f1fb; color: #1f4e79; }
  .src.stated { background: #f1ecf9; color: #5b3e8a; }
  .src.est { background: var(--estbg); color: var(--est); border: 1px solid #ecdcb0; }
  .legend { font-size: 8.5pt; color: var(--muted); margin: 0 0 10px; }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .callout { background: #f4f6f9; border-radius: 10px; padding: 8px 12px; margin: 10px 0; font-size: 9.5pt; }
  .warn { border-left-color: var(--bad); background: #fbf1ef; }
  ol.decisions { font-size: 9.5pt; padding-left: 18px; } ol.decisions li { margin-bottom: 5px; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar > div { height: 100%; background: var(--good); }
  section.compact table { font-size: 8.5pt; } section.compact td { padding: 1px 6px; } section.compact p, section.compact li, section.compact .callout { font-size: 9pt; } section.compact h3 { margin: 8px 0 4px; }
  .part { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 700; margin-bottom: 2px; }
  .part span { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--muted); margin-left: 6px; }
  .strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0 6px; }
  .strip > div { border-top: 2px solid var(--ink); padding: 6px 2px 0; display: flex; flex-direction: column; gap: 2px; }
  .strip .q, .goal .q { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: block; }
  .strip b { font-size: 14pt; }
  .strip .muted { font-size: 8.5pt; }
  table.glance td { padding: 4px 6px; }
  .goal { border: 1px solid #e4e7ec; border-radius: 12px; padding: 7px 11px; margin: 0 0 7px; page-break-inside: avoid; }
  .goal-h { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5pt; }
  .tier { font-size: 8.5pt; text-transform: uppercase; letter-spacing: .05em; padding: 2px 6px; border-radius: 3px; background: #eef2f7; color: var(--accent); }
  .tier.important { background: #fbf6e9; color: var(--est); }
  .goal-what { font-size: 8.5pt; color: var(--muted); margin: 1px 0 4px; }
  .goal-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 10px; font-size: 8.5pt; line-height: 1.35; }
  .goal-grid .bar { margin-top: 4px; }
  .goal-conf { font-size: 8.5pt; color: var(--muted); margin-top: 4px; border-top: 1px dashed var(--line); padding-top: 3px; }
  .goal-conf .q { display: inline; }
  .callout.scenario { border-left-color: var(--est); background: var(--estbg); }
  .goal-grid .span2 { grid-column: span 2; }
  .pbar { position: relative; height: 12px; border-radius: 6px; background: var(--line); overflow: hidden; margin: 3px 0 4px; }
  .pbar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--good); }
  .pbar .fill.short { background: var(--bad); }
  .pbar .gap { position: absolute; top: 0; bottom: 0; right: 0; background: repeating-linear-gradient(45deg, transparent 0 4px, rgba(31,122,77,.35) 4px 7px); }
  .pbar-legend { display: flex; flex-direction: column; gap: 1px; font-size: 8.5pt; }
  .pb { position: relative; border-radius: 6px; background: #dde1e8; overflow: hidden; }
  .pb-fill { position: absolute; left: 0; top: 0; bottom: 0; }
  .pb-gap { display: none; }
  .pb-tick { position: absolute; top: 0; bottom: 0; width: 2px; background: #1d2433; }
  .glance-row { display: grid; grid-template-columns: 165px minmax(0, 1fr) 62px; gap: 12px; padding: 3px 4px; border-bottom: 1px solid #eef0f4; align-items: center; }
  .glance-row .cap { font-size: 8.5pt; color: var(--muted); }
  .viz { display: flex; gap: 10px; align-items: flex-start; }
  .viz > div { padding: 3px 0 0; min-width: 0; }
  .viz > div { flex: 1 1 0; }
  .gcard { border: 1px solid #e4e7ec; border-radius: 12px; padding: 8px 12px; margin: 0 0 7px; page-break-inside: avoid; display: flex; flex-direction: column; gap: 4px; }
  .gcard-h { display: flex; justify-content: space-between; align-items: baseline; }
  .gcard-h b { font-size: 11pt; }
  .gcard-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; font-size: 9pt; }
  .gcard-facts span { color: var(--muted); }
  .legend-row { display: flex; gap: 14px; font-size: 8.5pt; color: var(--muted); align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
  .sw { display: inline-block; width: 18px; height: 8px; border-radius: 4px; vertical-align: middle; margin-right: 5px; }
  .chart-legend { display: flex; gap: 14px; font-size: 8.5pt; color: var(--muted); padding: 2px 6px 4px; flex-wrap: wrap; }
  .lg-dash { display: inline-block; width: 18px; border-top: 2px dashed #1f4e79; vertical-align: middle; margin-right: 5px; }
  .lg-band { display: inline-block; width: 14px; height: 8px; background: rgba(31,78,121,.12); vertical-align: middle; margin-right: 5px; }
  .lg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #1d2433; vertical-align: middle; margin-right: 5px; }
  .st { font-weight: 700; } .st.ok { color: #1f7a4d; } .st.behind { color: #b5651d; }
  /* ── Bento page 1 ── */
  .p1-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; gap: 12px; }
  .p1-head h1 { font-size: 15pt; margin: 0; white-space: nowrap; } .p1-head .muted { font-size: 8.5pt; text-align: right; }
  .bento { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .tile { border: 1px solid #e4e7ec; border-radius: 12px; padding: 9px 12px; min-width: 0; page-break-inside: avoid; }
  .tile .q { font-size: 8.5pt; color: var(--muted); display: block; }
  .tile.kpi { display: flex; flex-direction: column; justify-content: space-between; gap: 4px; }
  .tile.kpi b { font-family: var(--display); font-size: 16pt; font-weight: 700; display: block; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .tile.kpi b small { font-size: 9pt; } .tile.kpi div > span { font-size: 8.5pt; display: block; line-height: 1.3; }
  .tile.accent { background: #eef4ff; border-color: #d6e4ff; color: #1f4e79; } .tile.accent .q { color: #1f4e79; }
  .tile.hero { grid-column: 1 / 3; grid-row: 1 / 3; background: #101828; border-color: #101828; color: #fff; display: flex; flex-direction: column; justify-content: space-between; gap: 8px; padding: 12px 16px; }
  .tile.hero .q { color: #98a2b3; } .tile.hero b { font-family: var(--display); font-size: 34pt; font-weight: 700; line-height: 1; letter-spacing: -.02em; display: block; }
  .tile.hero .delta { color: #6ee7b7; font-size: 9.5pt; display: block; margin-top: 5px; }
  .tile.wide { grid-column: span 2; padding: 8px 8px 4px; }
  .tile.wide .chart-legend { flex-wrap: nowrap; gap: 9px; white-space: nowrap; padding: 0 4px 2px; } .tile.full { grid-column: 1 / 5; }
  .tile-h { display: flex; justify-content: space-between; align-items: baseline; padding: 0 4px 2px; } .tile-h b { font-family: var(--display); font-size: 10.5pt; } .tile-h .muted { font-size: 8.5pt; }
  .tile.full .tile-h { padding: 0 0 2px; }
  .goal-grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 22px; }
  .g2 { padding: 5px 0; border-top: 1px solid #f0f2f5; display: flex; flex-direction: column; gap: 3px; }
  .g2-h { display: flex; justify-content: space-between; gap: 8px; font-size: 9.5pt; } .g2-h .muted { font-size: 8.5pt; } .g2-h .num { font-family: var(--display); }
  .g2-f { display: flex; justify-content: space-between; gap: 8px; font-size: 8.5pt; color: var(--muted); line-height: 1.3; } .g2-f .st { white-space: nowrap; }
  .tile.dark { background: #101828; border-color: #101828; color: #fff; display: flex; gap: 12px; align-items: flex-start; padding: 10px 14px; }
  .tile.dark .pill { font-family: var(--display); font-size: 8.5pt; font-weight: 700; color: #101828; background: #fff; border-radius: 99px; padding: 2px 9px; white-space: nowrap; }
  .tile.dark .q { color: #98a2b3; } .tile.dark ol.decisions { margin: 0; padding-left: 16px; } .tile.dark ol.decisions li { margin-bottom: 3px; }
  .tile.dark ol.decisions:has(li:only-child) { list-style: none; padding-left: 0; }
  .page-key { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: center; font-size: 8.5pt; color: var(--muted); margin: -4px 0 10px; }
  .page-key > span { display: inline-flex; align-items: center; gap: 5px; }
  .page-key .sw { width: 14px; height: 8px; margin: 0; } .page-key .lg-dash, .page-key .lg-band, .page-key .lg-dot { margin-right: 0; }
  .lg-solid { display: inline-block; width: 18px; border-top: 2.5px solid #1f4e79; vertical-align: middle; }
  .bdg { display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 15px; border-radius: 50%; font-size: 9px; font-weight: 800; line-height: 1; flex: none; border: 1px solid; }
  .bdg-ok { color: #1f7a4d; background: #e7f4ec; border-color: #1f7a4d55; } .bdg-behind { color: #b5651d; background: #fbefe3; border-color: #b5651d55; } .bdg-self { color: #3b5b8a; background: #eaf0f8; border-color: #3b5b8a55; }
  .foot { font-size: 8.5pt; color: var(--muted); margin-top: 18px; }
</style></head><body>

<section class="first">
  <div class="p1-head"><h1>Personal Financial Statement${s.scenario ? ` <small style="font-size:12pt;color:var(--est)">scenario</small>` : ''}</h1>
  <span class="muted">${esc(p.household.name)} · ${esc(longDate(s.asOf))} · today's dollars${previous || s.scenario ? '' : ' · first statement (baseline)'}</span></div>
  ${pageKey([...(s.retirementTrack ? CHART_KEY : []), 'ok', 'behind'])}
  ${s.scenario ? (() => { const B = base; const rs = x => x && x.projection ? Math.round(x.projection.scenarios[x.profile.retirement.base].success * 100) + '%' : '—';
    const row = (lab, a, b) => `<tr><td>${lab}</td><td class="num"><b>${a}</b></td><td class="num muted">${b}</td></tr>`;
    return `<div class="callout scenario"><b>Scenario: ${esc(s.scenario.label)}</b>${s.scenario.description ? ` · ${esc(s.scenario.description)}` : ''}. Everything else matches the base statement.
    ${B ? `<table style="margin-top:6px"><tr><th></th><th class="num">This scenario</th><th class="num">Base</th></tr>
      ${row('Lifetime surplus', fmtK(s.extended.surplus), fmtK(B.extended.surplus))}
      ${row(`Retirement lasts to ${s.profile.retirement.planningHorizonAge}`, rs(s), rs(B))}
      ${row('Safe spend in retirement', s.projection ? fmt(s.projection.safeSpendYear / 12) + '/mo' : '—', B.projection ? fmt(B.projection.safeSpendYear / 12) + '/mo' : '—')}
      ${row('New money needed each month', s.plan ? fmt(s.plan.newMonthly) : '—', B.plan ? fmt(B.plan.newMonthly) : '—')}
      ${row('Left over after the plan', s.plan && s.plan.leftAfter != null ? fmt(s.plan.leftAfter) : '—', B.plan && B.plan.leftAfter != null ? fmt(B.plan.leftAfter) : '—')}
    </table>` : '<br><span class="muted">Run the base statement first to see the comparison.</span>'}</div>`; })() : ''}
  ${(() => {
    const cards = cardLibrary(s, { fmt, fmtK }), nw = cards.find(c => c.k === 'netWorth'), small = cards.filter(c => c.k !== 'netWorth').slice(0, 3);
    const R = s.review, n = R ? 1 : 2;
    const tile = c => `<div class="tile kpi"><span class="q">${esc(c.q)}</span><div><b>${esc(c.v)}</b><span class="muted">${esc(c.sub)}</span></div></div>`;
    return `<div class="bento">
    <div class="tile hero"><span class="q">Net worth</span>
      <div><b>${esc(nw ? nw.v : fmtK(s.explicit.netWorth))}</b><span class="delta">${R ? `${R.nwChange >= 0 ? '▲' : '▼'} ${fmtK(Math.abs(R.nwChange))} since ${esc(longDate(R.from))}` : esc(nw ? nw.sub : '')}</span></div>
      <span class="q">${R ? `On plan pace for ${R.adherence.filter(a => a.status === 'done').length} of ${R.adherence.filter(a => a.status !== 'unverified').length} actions we can check (see Since the last statement).` : 'First statement: this is the baseline later reviews compare against.'}</span></div>
    ${small.map(tile).join('')}
    ${s.plan ? `<div class="tile kpi accent"><span class="q">New money for goals</span><div><b>${fmt(s.plan.newMonthly)}<small>/mo</small></b><span>${s.plan.leftAfter != null ? `about ${fmt(s.plan.leftAfter)}/mo left after the plan` : ''}</span></div></div>` : ''}
    ${s.retirementTrack ? `<div class="tile wide"><div class="tile-h"><b>Retirement savings vs. plan</b><span class="muted">today's dollars</span></div>${noChartLegend(zoomChart(s.retirementTrack, fmtK))}</div>` : ''}
    ${(s.period || s.monthly) ? `<div class="tile wide"><div class="tile-h"><b>Where the money goes</b><span class="muted">${esc((s.period || s.monthly).short || '')}, per month</span></div>${spendingDonut(s.period || s.monthly, s.plan, fmt, fmtK).replace(/<text x="8" y="12"[^]*?<\/text>\s*<text x="8" y="24"[^]*?<\/text>/, '')}</div>` : ''}
    <div class="tile full"><div class="tile-h"><b>Goals</b><span class="muted">bar = progress to plan · amount = monthly to stay on it</span></div>
      <div class="goal-grid2">${(s.goals || []).map(g => `<div class="g2">
        <div class="g2-h"><span><b>${esc(g.label)}</b> <span class="muted">${esc(g.when)}</span></span><b class="num">${g.action.monthly ? fmt(g.action.monthly) : '—'}</b></div>
        ${progressBar(g, { height: 6 })}
        <div class="g2-f"><span>${esc(g.caption || g.today.text)}</span>${badge(g.today.ok ? 'ok' : 'behind')}</div></div>`).join('')}</div></div>
    <div class="tile full dark"><span class="pill">Top decision${n > 1 && s.decisions.length > 1 ? 's' : ''}</span>
      <div><ol class="decisions">${s.decisions.slice(0, n).map(d => `<li>${esc(d)}</li>`).join('')}</ol>${s.decisions.length > n ? `<span class="q">${s.decisions.length - n} more under All decisions</span>` : ''}</div></div>
  </div>`; })()}
  ${s.missing.length ? `<div class="callout warn"><b>Incomplete:</b> ${s.missing.map(esc).join('; ')}.</div>` : ''}
</section>

  ${s.review ? (() => { const R = s.review; const sign = v => (v >= 0 ? '+' : '−') + fmtK(Math.abs(v)).replace('−', '');
    return `<section><h2>Since the last statement <small>(${esc(longDate(R.from))}, ${R.months} months ago)</small></h2>
    ${pageKey(['ok', 'behind', 'self', ...(R.goalMoves.length ? [{ sw: 'background:#cdb08f', text: 'last quarter' }, { sw: `background:${AMBER}`, text: 'gained this quarter' }] : [])])}
    <div class="two"><div><table>
      <tr><th>Net worth change</th><th class="num">${sign(R.nwChange)}</th></tr>
      ${R.parts.map(x => `<tr><td class="indent">${esc(x.label)}</td><td class="num">${sign(x.change)}</td></tr>`).join('')}
      <tr><td>Lifetime surplus</td><td class="num">${sign(R.surplusChange)}</td></tr>
    </table></div><div><table>
      <tr><th>Activity vs. plan</th><th class="num">Plan pace</th><th class="num">Actual</th><th></th></tr>
      ${R.adherence.length ? R.adherence.map(a => `<tr><td>${esc(a.goal)}</td><td class="num">${fmt(a.expected)}</td><td class="num${a.actual == null ? ' muted' : ''}">${a.actual == null ? 'to report' : fmt(a.actual)}</td><td style="text-align:center;white-space:nowrap">${badge(a.status === 'done' ? 'ok' : a.status === 'unverified' ? 'self' : 'behind')}${a.reported ? ' ' + badge('self') : ''}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">No new contributions were planned last time.</td></tr>'}
    </table></div></div>
    <p class="muted">The plan plays out over years; this compares the quarter's activity with the pace the plan needs. "Actual" counts deposits into the goal's own account, or payments matching the goal's description pattern. Actions that happen outside linked accounts (extra retirement saving through payroll, an account not linked yet) are self-reported: tell us the amount, or link the account so the next review picks it up automatically.</p>
    ${R.goalMoves.length ? `<h3>Goals then and now</h3>
    <div style="display:flex;flex-direction:column;gap:6px">${R.goalMoves.map(g => { const b = Math.max(0, Math.min(1, g.before)), n = Math.max(0, Math.min(1, g.now));
      return `<div style="display:grid;grid-template-columns:170px minmax(0,1fr) 90px 18px;gap:12px;align-items:center"><span>${esc(g.label)}</span>
        <div class="pb" style="height:9px"><div class="pb-fill" style="width:${(Math.min(b, n) * 100).toFixed(1)}%;background:#cdb08f"></div>${n > b ? `<div class="pb-fill" style="left:${(b * 100).toFixed(1)}%;width:${((n - b) * 100).toFixed(1)}%;background:${AMBER}"></div>` : ''}</div>
        <span class="num" style="text-align:right">${Math.round(b * 100)}% → ${Math.round(n * 100)}%</span>${g.ok != null ? badge(g.ok ? 'ok' : 'behind') : '<span></span>'}</div>`; }).join('')}</div>` : ''}
    </section>`; })() : ''}

<section>
  <h2>What we own and what we owe <small>(explicit balance sheet)</small></h2>
  ${pageKey([{ html: '<span class="src synced">synced</span> pulled from the account by Foliome' }, { html: '<span class="src stated">stated</span> told to us, not synced' }, { html: 'Accounts with less than $1 are left out.' }])}
  <table>
    <tr><th>What we own</th><th>Owner</th><th>Tax treatment</th><th>Source</th><th class="num">Value</th></tr>
    ${classRows(e.lines.filter(l => l.balance > 0), 1)}
    <tr class="total"><td colspan="4">Total we own</td><td class="num">${fmt(e.explicitAssets)}</td></tr>
  </table>
  <table>
    <tr><th>What we owe</th><th>Owner</th><th></th><th>Source</th><th class="num">Balance</th></tr>
    ${classRows(e.lines.filter(l => l.balance < 0), -1)}
    <tr class="total"><td colspan="4">Total we owe</td><td class="num">${fmt(e.explicitLiabs)}</td></tr>
  </table>
  <table>
    <tr class="total"><td>Net worth</td><td class="num">${fmt(e.netWorth)}</td></tr>
    <tr class="est"><td class="indent">less estimated tax when 401(k)/IRA money is withdrawn (${pct(p.conventions.deferredAccountTaxRate)}) <span class="src est">estimate</span></td><td class="num">−${fmt(e.deferredTax)}</td></tr>
    <tr class="est"><td class="indent">less cost to sell the house (${pct(p.conventions.homeSellingCost)}) <span class="src est">estimate</span></td><td class="num">−${fmt(e.homeSelling)}</td></tr>
    <tr class="total"><td>Net worth, after those costs</td><td class="num">${fmt(e.netWorthAfterTax)}</td></tr>
  </table>
</section>

${s.monthly ? (() => { const P = s.period || s.monthly, B = s.monthly, same = P === B || P.months === B.months;
  const bLine = c => { const l = B.groups.flatMap(g => g.lines).find(x => x.cat === c); return l ? fmt(l.amount) : '—'; };
  const bGroup = n => { const g = B.groups.find(x => x.label === n); return g ? fmt(g.total) : '—'; };
  return `<section class="compact">
  <h2>Each month: cash in and cash out <small>(actual, ${esc(P.label)}, per month)</small></h2>
  <p>Cash out is real money leaving the accounts Foliome syncs. Payments that build equity, like mortgage principal, still count, because the cash leaves the account. Cash in is the whole household. It's actual where Foliome can see it, and estimated from pay, deductions and taxes where it can't (see Taxes and take-home).${same ? '' : ` The plan uses a longer ${B.months}-month average (${esc(B.label)}) so twice-a-year bills like property tax are spread out; it's shown alongside.`}</p>
  <div class="two">
  <table>
    <tr><th>Cash in</th><th class="num">Per month</th></tr>
    ${Object.entries(P.inflows).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)} <span class="src synced">synced</span></td><td class="num">${fmt(v)}</td></tr>`).join('')}
    ${Object.entries(P.estimatedInflows || {}).map(([k, v]) => `<tr class="est"><td>${esc(k.replace(' (estimate)', ''))} <span class="src est">estimate</span></td><td class="num">${fmt(v)}</td></tr>`).join('')}
    <tr class="total"><td>Total in</td><td class="num">${fmt(P.totalIn)}</td></tr>
    ${Object.entries(P.memo || {}).map(([k, v]) => `<tr><td class="muted">Memo: ${esc(k)} (a transfer, not income; already inside take-home pay)</td><td class="num muted">${fmt(v)}</td></tr>`).join('')}
  </table>
  <table>
    <tr><th>Summary</th><th class="num">Per month</th>${same ? '' : `<th class="num">${B.months}-mo avg</th>`}</tr>
    <tr><td>Cash in</td><td class="num">${fmt(P.totalIn)}</td>${same ? '' : `<td class="num muted">${fmt(B.totalIn)}</td>`}</tr>
    <tr><td>Cash out (synced accounts)</td><td class="num">−${fmt(P.totalOut)}</td>${same ? '' : `<td class="num muted">−${fmt(B.totalOut)}</td>`}</tr>
    <tr class="total"><td>Left over: spent or saved where Foliome can't see</td><td class="num">${fmt(P.net)}</td>${same ? '' : `<td class="num muted">${fmt(B.net)}</td>`}</tr>
    <tr><td class="muted" colspan="${same ? 2 : 3}">Housing alone is ${Math.round(P.groups.find(g => g.label === 'Housing')?.total / P.totalIn * 100 || 0)}% of household cash in.</td></tr>
  </table>
  </div>
  <table>
    <tr><th>Cash out</th><th>Note</th><th class="num">Per month</th><th class="num">${same ? 'Per year' : `${B.months}-mo avg`}</th></tr>
    ${P.groups.map(g => `<tr class="group"><td>${esc(g.label)}</td><td></td><td class="num">${fmt(g.total)}</td><td class="num muted">${same ? fmt(g.total * 12) : bGroup(g.label)}</td></tr>
      ${g.lines.sort((a, b) => b.amount - a.amount).map(l => `<tr><td class="indent">${esc(l.cat)}</td><td class="muted">${esc(l.note || '')}</td><td class="num">${fmt(l.amount)}</td><td class="num muted">${same ? fmt(l.amount * 12) : bLine(l.cat)}</td></tr>`).join('')}`).join('')}
    <tr class="total"><td colspan="2">Total cash out</td><td class="num">${fmt(P.totalOut)}</td><td class="num muted">${same ? fmt(P.totalOut * 12) : fmt(B.totalOut)}</td></tr>
  </table>
  <div class="callout">${esc(P.invisible)}${P.oneOff.length ? ` ${P.oneOff.length} one-offs (${fmt(P.oneOff.reduce((a, o) => a + o.amount, 0))}, such as tax refunds) are left out of the averages.` : ''}</div>
</section>`; })() : ''}

<section>
  <h2>Where the money comes from and goes <small>(annual, the whole household, today's dollars)</small></h2>
  <table>
    <tr><th>Coming in</th><th>Source</th><th class="num">Per year</th></tr>
    ${p.humanCapital.earners.flatMap(er => er.streams.map(st => `<tr><td>${esc(OWNER_LABEL[er.member])}: ${esc(st.label)}</td><td><span class="src stated">${esc(st.source)}</span></td><td class="num">${fmt(st.annual)}</td></tr>`)).join('')}
    <tr class="total"><td colspan="2">Gross pay and match</td><td class="num">${fmt(p.humanCapital.earners.flatMap(er => er.streams).reduce((a, st) => a + st.annual, 0))}</td></tr>
  </table>
  <table>
    <tr><th>Going out</th><th>Source</th><th class="num">Per year</th></tr>
    <tr><td>Everyday spending we can see (excl. mortgage and childcare)</td><td><span class="src synced">synced</span> last ${s.monthly ? s.monthly.months : ''} months, annualized</td><td class="num">${fmt(s.spendModel.coreVisible)}</td></tr>
    ${s.spendModel.offSide ? `<tr class="est"><td>${esc(s.spendModel.offSideLabel || 'Spending outside synced accounts')}</td><td><span class="src est">placeholder</span> ${esc(s.spendModel.offSideSource || '')}</td><td class="num">${fmt(s.spendModel.offSide)}</td></tr>` : ''}
    <tr><td>Mortgage payment (full, until payoff)</td><td><span class="src synced">synced</span></td><td class="num">${fmt(s.spendModel.mortgage)}</td></tr>
    <tr><td>Childcare (until about ${(() => { const d = new Date(`${s.asOf}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + Math.round(s.spendModel.childcareYears * 12)); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; })()})</td><td><span class="src synced">synced</span></td><td class="num">${fmt(s.spendModel.childcare)}</td></tr>
    <tr class="est"><td>Retirement contributions from pay</td><td><span class="src est">estimate</span> ${esc(p.spending.contributionsSource)}</td><td class="num">${fmt(p.spending.contributionsFromPay)}</td></tr>
  </table>
  <table>
    <tr><th>Does it tie out?</th><th class="num">Per year</th></tr>
    <tr class="est"><td>Take-home after tax (${pct(s.tax ? s.tax.effectiveRate : p.humanCapital.effectiveTaxRate)} of gross) and pre-tax deductions <span class="src est">estimate</span></td><td class="num">${fmt(s.cashFlow.takeHome)}</td></tr>
    <tr><td class="indent">less everything above (cash out we can see${s.spendModel.offSide ? ' + the placeholder for unsynced spending' : ''})</td><td class="num">−${fmt(s.spendModel.coreVisible + s.spendModel.offSide + s.spendModel.mortgage + s.spendModel.childcare)}</td></tr>
    <tr class="total"><td class="${s.cashFlow.unaccounted > 10000 ? 'bad' : ''}">Not accounted for: either saved where Foliome can't see it, or spent</td><td class="num ${s.cashFlow.unaccounted > 10000 ? 'bad' : ''}">${fmt(s.cashFlow.unaccounted)}</td></tr>
  </table>
  ${s.tax ? `</section><section><h2>Taxes and take-home <small>(how gross pay becomes cash)</small></h2><h3>Taxes and paycheck deductions <small class="muted">estimated with ${esc(p.tax.year)} tax tables, ${p.tax.filing === 'MFJ' ? 'married filing jointly' : 'single filer'}${p.tax.state ? `, ${esc(p.tax.state.name.replace(/\(flat (\d+)% estimate\)/, 'at a flat $1% estimate'))}` : ''}${+String(s.asOf).slice(0, 4) > +p.tax.year ? ` (latest tables available; this statement is ${String(s.asOf).slice(0, 4)})` : ''}</small></h3>
  <table>
    <tr><th></th>${s.tax.rows.map(r => `<th class="num">${esc(nameOf(r.member))}</th>`).join('')}<th class="num">Household</th></tr>
    <tr><td>Gross pay</td>${s.tax.rows.map(r => `<td class="num">${fmt(r.gross)}</td>`).join('')}<td class="num">${fmt(s.tax.gross)}</td></tr>
    ${[...new Set(s.tax.rows.flatMap(r => r.preTax.map(d => d.label)))].map(lab => `<tr class="${s.tax.rows.some(r => r.preTax.some(d => d.label === lab && d.estimate)) ? 'est' : ''}"><td class="indent">less ${esc(lab)}${s.tax.rows.some(r => r.preTax.some(d => d.label === lab && d.estimate)) ? ' <span class="src est">assumed</span>' : ''}</td>${s.tax.rows.map(r => { const d = r.preTax.find(x => x.label === lab); return `<td class="num">${d ? '−' + fmt(d.annual) : ''}</td>`; }).join('')}<td class="num">−${fmt(s.tax.rows.reduce((a, r) => a + (r.preTax.find(x => x.label === lab) || { annual: 0 }).annual, 0))}</td></tr>`).join('')}
    ${[['Federal income tax', 'federal'], ['State income tax', 'state'], ['Social Security', 'socialSecurity'], ['Medicare', r => r.medicare + r.addlMedicare], ['State disability (SDI)', 'sdi']].map(([lab, k]) => `<tr><td class="indent">less ${lab}</td>${s.tax.rows.map(r => `<td class="num">−${fmt(typeof k === 'function' ? k(r) : r[k])}</td>`).join('')}<td class="num">−${fmt(s.tax.rows.reduce((a, r) => a + (typeof k === 'function' ? k(r) : r[k]), 0))}</td></tr>`).join('')}
    <tr class="total"><td>Take-home</td>${s.tax.rows.map(r => `<td class="num">${fmt(r.takeHome)}</td>`).join('')}<td class="num">${fmt(s.tax.takeHome)}</td></tr>
    <tr><td class="muted">Per month</td>${s.tax.rows.map(r => `<td class="num muted">${fmt(r.takeHome / 12)}</td>`).join('')}<td class="num muted">${fmt(s.tax.takeHome / 12)}</td></tr>
  </table>
  ${(s.calibration || []).map(c => `<p class="muted">Check against real paychecks: the model estimates ${esc(nameOf(c.member))}'s base-pay take-home at ${fmt(c.estimated)}/yr. Actual deposits are ${fmt(c.observed)}/yr (${esc(c.source)}), so the estimate is ${Math.abs(c.gap / c.observed * 100).toFixed(1)}% ${c.gap < 0 ? 'lower, on the conservative side' : 'higher'}.</p>`).join('')}` : ''}
  <div class="callout">Spending is modelled in phases, not as one flat number. Everyday spending (${fmt(s.spendModel.core)}/yr including the placeholder) continues for life. The mortgage stops at payoff and childcare stops when the kids are older. See the retirement page for each phase.</div>
  <h3>Liquidity</h3>
  <table>
    <tr><th>Need</th><th class="num">Amount</th><th>Covered by</th></tr>
    <tr><td>Emergency reserve</td><td class="num">${fmt(s.liquidity.emergencyFund)}</td><td>${esc((e.lines.find(l => l.id === p.protection.emergencyFund.account) || {}).label || 'Emergency fund')}: ${esc(p.protection.emergencyFund.status)}</td></tr>
    <tr><td>${s.monthly ? 'Monthly cash out (actual, see "Each month")' : 'Monthly spending (lifestyle + childcare)'}</td><td class="num">${fmt(s.liquidity.monthlyEssential)}</td><td>Pay. Cash on hand covers ${s.liquidity.runwayMonths.toFixed(0)} months.</td></tr>
    <tr><td>Card balances due this cycle</td><td class="num">${fmt(-e.lines.filter(l => l.cls === 'cards').reduce((a, l) => a + l.balance, 0))}</td><td>Paid from cash on hand</td></tr>
    ${(p.knownObligations || []).filter(o => o.due >= s.asOf).map(o => `<tr><td>${esc(o.label)}, due ${esc(longDate(o.due))}</td><td class="num">${fmt(o.amount)}</td><td class="muted">${esc(o.source)}</td></tr>`).join('')}
    <tr><td>Illiquid: home equity</td><td class="num">${fmt(e.lines.filter(l => l.cls === 'home' || l.cls === 'mortgage').reduce((a, l) => a + l.balance, 0))}</td><td>Not available without selling or borrowing</td></tr>
  </table>
</section>

${(s.goals || []).length ? `<section>
  <h2>The Goals: Today vs. Plan</h2>
  ${pageKey(['ok', 'behind', { sw: 'background:#dde1e8', text: 'still to go' }, { html: 'Full bar = 100% of the plan' }])}
  ${s.goals.map(g => `<div class="gcard">
    <div class="gcard-h"><span style="display:inline-flex;gap:7px;align-items:center">${badge(g.today.ok ? 'ok' : 'behind')}<b>${esc(g.label)}</b></span><span class="tier ${esc(g.tier)}">${esc(g.tier)} · ${esc(g.when)}</span></div>
    <div class="muted" style="font-size:9pt">${esc(g.what)}</div>
    ${progressBar(g, { height: 11 })}
    <div class="gcard-facts">${(g.facts || []).map(([k, v]) => `<div><span>${esc(k)}:</span> ${esc(v)}</div>`).join('')}</div>
    <div class="goal-conf"><span class="q">How sure:</span> ${esc(g.confidence)}</div>
  </div>`).join('')}
</section>` : ''}

${s.plan ? `<section>
  <h2>What we need to do each month <small>(the action plan)</small></h2>
  <p>For each goal, this is the monthly amount that keeps it on track, in today's dollars. Raise each amount with inflation every year, and check it at each quarterly review.</p>
  <table>
    <tr><th>Goal</th><th>Status</th><th class="num">Per month</th><th class="num">Per year</th><th>What to do</th></tr>
    ${s.plan.items.map(i => `<tr${i.inCashOut ? ' class="muted"' : ''}><td><b>${esc(i.goal)}</b><br><span class="muted">${esc(i.basis)}</span></td>
      <td class="${/short|below|not opened/.test(i.status) ? 'bad' : 'good'}">${esc(i.status)}</td>
      <td class="num">${i.monthly ? fmt(i.monthly) : '—'}</td><td class="num">${i.monthly ? fmt(i.monthly * 12) : '—'}</td>
      <td>${esc(i.how)}${i.inCashOut ? ' <span class="muted">(already counted in cash out)</span>' : ''}</td></tr>`).join('')}
    <tr class="total"><td colspan="2">New money needed each month for goals</td><td class="num">${fmt(s.plan.newMonthly)}</td><td class="num">${fmt(s.plan.newMonthly * 12)}</td><td></td></tr>
  </table>
  ${s.plan.leftBefore != null ? `<h3>Can the monthly cash flow carry it?</h3>
  <table>
    <tr><th></th><th class="num">Per month</th></tr>
    <tr><td>Household cash in (actual + estimated)</td><td class="num">${fmt(s.monthly.totalIn)}</td></tr>
    <tr><td>Cash out today (synced accounts, mortgage included)</td><td class="num">−${fmt(s.monthly.totalOut)}</td></tr>
    <tr><td>Retirement contributions <span class="muted">(already taken from pay, before cash in)</span></td><td class="num muted">—</td></tr>
    <tr><td>New goal contributions (above)</td><td class="num">−${fmt(s.plan.newMonthly)}</td></tr>
    <tr class="total"><td class="${s.plan.leftAfter >= 0 ? 'good' : 'bad'}">Left after goals: everyday spending we can't see, plus extra saving</td><td class="num ${s.plan.leftAfter >= 0 ? 'good' : 'bad'}">${fmt(s.plan.leftAfter)}</td></tr>
  </table>
  <div class="callout">${s.plan.leftAfter >= 0 ? `The goals fit. After funding them, about <b>${fmt(s.plan.leftAfter)}/mo</b> remains, mostly on the side Foliome can't see. Whatever part of it isn't spent is extra saving: it goes to taxable investing, paying the mortgage down faster, or retiring earlier.` : `The goals don't fit yet. Cash flow is short by about ${fmt(-s.plan.leftAfter)}/mo, so spending, the goals, or their timing need to change.`}</div>` : ''}
</section>` : ''}

${s.statusQuo ? (() => { const Q = s.statusQuo;
  const maxNeed = Math.max(...Q.edu.map(e => e.need));
  const bars = Q.edu.map((e, k) => { const x = 40 + k * 300, bw = 70, H = 150, sc = v => H * v / maxNeed;
    const bar = (dx, v, color, lab) => `<rect x="${x + dx}" y="${20 + H - sc(v)}" width="${bw}" height="${sc(v)}" fill="${color}"/><text x="${x + dx + bw / 2}" y="${20 + H - sc(v) - 5}" font-size="15" text-anchor="middle">${lab}</text>`;
    return `${bar(0, e.need, '#cbd5e1', fmtK(e.need))}${bar(bw + 8, e.todayAtStart, '#a63d2f', fmtK(e.todayAtStart))}${bar(2 * (bw + 8), e.need, '#1f7a4d', fmtK(e.need))}
      <text x="${x + 1.5 * bw + 8}" y="${20 + H + 20}" font-size="15" text-anchor="middle" font-weight="600">${esc(e.label.replace('College, ', ''))}</text>`; }).join('');
  return `<section class="compact">
  <h2>Today's path vs. the plan <small>(same markets; only our actions differ)</small></h2>
  ${pageKey([{ sw: 'background:#94a3b8', text: 'needed' }, { sw: 'background:#a63d2f', text: 'change nothing' }, { sw: 'background:#1f7a4d', text: 'with the plan' }, { html: "College bars in today's dollars" }])}
  <p><b>Today's path</b> means nothing changes: same paychecks, same retirement contributions, same spending, no new 529 money, no will. <b>The plan</b> is today's path plus the actions on the previous page. Both use the same market assumptions.</p>
  <table>
    <tr><th>Outcome</th><th>If we change nothing</th><th>If we follow the plan</th><th>What the plan changes</th></tr>
    ${Q.edu.map(e => `<tr><td><b>${esc(e.label)}</b><br><span class="muted">needed at 18: ${fmt(e.need)}</span></td><td class="bad">${fmt(e.todayAtStart)} saved (${Math.round(e.todayPct * 100)}%). Short ${fmt(e.shortfall)}.</td><td class="good">Fully funded</td><td>${fmt(e.planMonthly)}/mo from now</td></tr>`).join('')}
    <tr><td><b>Retirement at ${p.retirement.base}</b></td><td>Typical ${fmtK(Q.retire.p50)}, lasts to 95 in ${Math.round(Q.retire.success * 100)}%</td><td>Same</td><td>Nothing. Today's contributions are already enough.</td></tr>
    <tr><td><b>Safe spend in retirement</b></td><td>${fmt(Q.retire.safe / 12)}/mo</td><td>Same</td><td>—</td></tr>
    <tr><td><b>Money left each month</b><br><span class="muted">(after cash out; spent or saved where we can't see)</span></td><td>${fmt(Q.leftoverToday)}/mo</td><td>${fmt(Q.leftoverPlan)}/mo</td><td>${fmt(Q.planMonthly)}/mo goes to the 529s</td></tr>
    <tr><td><b>If something happens to us</b></td><td class="bad">${esc(Q.estate.today)}. A court decides guardianship.</td><td class="good">${esc(Q.estate.plan)}</td><td>One-time legal cost, no monthly cost</td></tr>
  </table>
  <div class="two">
    <div><h3>College at 18: needed vs. saved</h3>
      <svg viewBox="0 0 600 205" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Inter, Helvetica, Arial, sans-serif">${bars}</svg>
</div>
    <div><h3>The cost of waiting</h3>
      <table><tr><th>Start the 529 contributions…</th>${Q.edu.map(e => `<th class="num">${esc(e.label.replace('College, ', ''))}</th>`).join('')}</tr>
        <tr><td>now</td>${Q.edu.map(e => `<td class="num">${fmt(e.planMonthly)}/mo</td>`).join('')}</tr>
        ${[0, 1, 2].map(k => `<tr><td>in ${Q.edu[0].delays[k].years} yr${Q.edu[0].delays[k].years > 1 ? 's' : ''}</td>${Q.edu.map(e => `<td class="num">${fmt(e.delays[k].monthly)}/mo</td>`).join('')}</tr>`).join('')}
      </table>
      <p class="muted">The total shortfall if nothing changes is <b>${fmt(Q.totalShortfall)}</b> in today's dollars. That's what the kids would borrow, or what we'd pay out of pocket in those years.</p></div>
  </div>
  ${(() => { const gs = s.goals || []; const ok = gs.filter(g => g.today.ok).map(g => g.short || g.label); const short = gs.filter(g => !g.today.ok).map(g => g.short || g.label);
    const estate = /not started/i.test(JSON.stringify(p.protection.estateDocs || {}));
    const list = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
    return `<div class="callout">The bottom line: ${ok.length ? `today's habits already carry ${list(ok)}. ` : ''}${short.length || estate ? `What doesn't happen on its own: ${list([...short, ...(estate ? ['the estate paperwork'] : [])])}. ` : ''}The plan costs ${fmt(s.plan ? s.plan.newMonthly : Q.planMonthly)}/mo out of the ~${fmt(Q.leftoverToday)}/mo left over today.</div>`; })()}
</section>`; })() : ''}

${s.decisions.length > 2 ? `<section><h2>All decisions for this review</h2>
  <p class="muted">Most important first. Page 1 shows the top ${s.review ? 'one' : 'two'}.</p>
  <ol class="decisions">${s.decisions.map(d => `<li>${esc(d)}</li>`).join('')}</ol></section>` : ''}

${s.projection ? (() => { const P = s.projection, b = P.scenarios[P.retireAge], ry = P.retireYear;
  const alt = Object.entries(P.scenarios).filter(([a]) => +a !== P.retireAge);
  const colors = ['#a63d2f', '#1f7a4d'];
  return `<section>
  <h2>Retirement: how the plan grows <small>(retirement accounts only, today's dollars)</small></h2>
  ${pageKey([{ html: `<span class="lg-solid"></span>Retire at ${P.retireAge}, typical` }, { sw: 'background:rgba(31,78,121,.15)', text: '1-in-10 to 9-in-10 markets' },
    ...alt.map(([a], k) => ({ html: `<span class="lg-dash" style="border-color:${colors[k % 2]}"></span>Retire at ${a}` })),
    ...(P.crossCheck ? [{ html: `<span class="lg-dash" style="border-color:#c08a1e;border-top-style:dotted"></span>${esc(P.crossCheck.label)}, typical (gold shading: its 1-in-10 to 9-in-10; lasts to 95 in ${Math.round(P.crossCheck.success * 1000) / 10}%)` }] : []),
    { html: 'Capped near the top; good-market paths go higher' }])}
  <p>If we keep contributing as planned, this is how the retirement accounts grow until ${P.retireAge} and then pay for retirement to ${P.startAge + P.years}. The dark line is the typical outcome. The shaded band runs from a bad market (1 in 10) to a good one (9 in 10).</p>
  ${chart({ x0: P.startAge, values: b.p50, band: { lo: b.p10, hi: b.p90 }, yMaxCap: b.p50.reduce((m, v) => Math.max(m, v), 0) * 1.6,
     band2: P.crossCheck ? { lo: P.crossCheck.p10.map(v => isFinite(v) ? v : 0), hi: P.crossCheck.p90.map(v => isFinite(v) ? v : 0) } : null,
     lines: [...alt.map(([a, r], k) => ({ values: r.p50, color: colors[k % 2], dash: '5,4' })), ...(P.crossCheck ? [{ values: P.crossCheck.p50.map(v => isFinite(v) ? v : 0), color: '#c08a1e', dash: '2,3' }] : [])],
     markers: [{ i: ry, label: `retire ${P.retireAge}` }] })}

  <div class="cards">
    <div class="card"><div class="q">At ${P.retireAge}, typical</div><div class="a">${fmtK(b.p50[ry])}</div><div class="why">Bad market ${fmtK(b.p10[ry])} · good market ${fmtK(b.p90[ry])}. Today: ${fmtK(b.p50[0])}, plus ${fmtK(P.contributions)}/yr until then.</div></div>
    <div class="card"><div class="q">Safe to spend in retirement</div><div class="a">${fmt(P.safeSpendYear / 12)}/mo</div><div class="why">After tax, in today's dollars, and lasts to ${P.startAge + P.years} in ${Math.round(P.target * 100)}% of markets. The plan needs ${fmt(P.retirementSpend.core / 12)}/mo, plus health insurance until Medicare.</div></div>
    <div class="card"><div class="q">Does the money last to ${P.startAge + P.years}?</div><div class="a ${b.success >= P.target ? 'good' : 'bad'}">${Math.round(b.success * 100)}% of markets</div><div class="why">${Math.round(P.conservativeSuccess * 100)}% if returns run 2 pts/yr lower than assumed (a conservative setting).</div></div>
    <div class="card"><div class="q">Retire earlier or later</div><div class="a">${Object.entries(P.scenarios).map(([a, r]) => `${a}: ${Math.round(r.success * 100)}%`).join(' · ')}</div><div class="why">Chance the money lasts, by retirement age. Typical balance at retirement: ${Object.entries(P.scenarios).map(([a, r]) => `${a} → ${fmtK(r.p50[a - P.startAge])}`).join(', ')}.</div></div>
  </div>
</section>
<section>
  <h2>Spending over our lifetime, and the other pieces <small>(modelled separately)</small></h2>
  <table>
    <tr><th>Phase</th><th>What's in it</th><th class="num">Per year</th><th class="num">Per month</th></tr>
    ${P.phases.map(x => `<tr><td>${esc(x.label)}</td><td class="muted">${esc(x.detail)}</td><td class="num">${fmt(x.spend)}</td><td class="num">${fmt(x.spend / 12)}</td></tr>`).join('')}
  </table>
  <p class="muted">Mortgage at ~${pct(P.mortgage.rate)} (implied by the payment and payoff date), paid off in ${P.mortgage.payoffYears} years. In retirement, withdrawals are increased by ${pct(P.tax)} to cover tax on money drawn from tax-deferred accounts.</p>
  <div class="two">
    <div>${chart({ w: 330, h: 170, x0: P.startAge, values: P.education, title: 'College savings' })}<p class="legend">Grows on the action-plan contributions, then pays 4 years per child.</p></div>
    <div>${chart({ w: 330, h: 170, x0: P.startAge, values: P.homeEquity, title: 'Home equity' })}<p class="legend">Climbs as the mortgage is paid down; flat after payoff. Not counted as spending money.</p></div>
  </div>
  <div class="two">
    <div>${chart({ w: 330, h: 170, x0: P.startAge, values: P.cash, title: 'Cash and emergency fund' })}<p class="legend">Held, not invested. ~0.5% real.</p></div>
    <div><h3>What this does and doesn't count</h3><ul style="font-size:9pt;margin:0;padding-left:16px">
      <li>Counts: retirement accounts today, plus the contributions already coming out of pay.</li>
      <li>Not counted: any extra saving from the money left after goals (action plan)${(p.humanCapital.pension && p.humanCapital.pension.label) ? `, ${esc(p.humanCapital.pension.label)}` : ', any pension'}, or Social Security. All of these would push the lines up.</li>
      <li>Returns per account: ${P.accounts.map(a => `${esc((e.lines.find(l => l.id === a.id) || {}).label || a.id)}${(e.lines.find(l => l.id === a.id) || {}).last4 ? ' …' + esc(e.lines.find(l => l.id === a.id).last4) : ''} ${pct(a.mu)}`).join(', ')}, treated as typical compound growth. ${P.years}-year simulation, 3,000 paths, with all accounts hit by the same market each year.</li>
      ${P.crossCheck ? `<li>${esc(P.crossCheck.label)}: ${esc(P.crossCheck.note)}</li>` : ''}
      <li>Two outlooks: this page's plan uses <b>forward assumptions</b> (typical real returns of ${[...new Set(P.accounts.map(a => pct(a.mu)))].join(' to ')}), which give ${Math.round(b.success * 100)}% at ${P.retireAge}.${P.crossCheck ? ` <b>History, trimmed</b> replays past markets with returns cut ${''}2 pts/yr and gives ${Math.round(P.crossCheck.success * 1000) / 10}%. The difference is mostly the return level. Smooth simulated markets also slightly understate runs of bad years.` : ''}</li>
      <li>Social Security, uncertain and so left out on purpose, would add income from 62–70.</li>
    </ul></div>
  </div>
</section>`; })() : ''}

<section>
  <h2>What each goal costs today, and which money is for what <small>(goals-based subportfolios)</small></h2>
  <p>Each goal is valued in today's dollars and discounted at a rate that matches how certain it needs to be. The more essential the goal, the lower the rate, and the more it costs today.</p>
  <table>
    <tr><th>#</th><th>Goal</th><th>Tier</th><th class="num">Rate</th><th class="num">Cost today</th><th>Set aside</th></tr>
    ${goalRows.map((g, i) => `<tr class="est"><td>${i + 1}</td><td>${esc(g.label)}</td><td>${g.goal ? esc(g.goal.tier) : 'essential'}</td><td class="num">${pct(g.rate)}</td><td class="num">${fmt(g.pv)}</td>
      <td>${g.goal ? `<div class="bar"><div style="width:${Math.round(g.fundedPct * 100)}%"></div></div><span class="muted">${fmt(g.dedicated)} in a 529 (${Math.round(g.fundedPct * 100)}%)</span>` : '<span class="muted">Paid from earnings, then savings</span>'}</td></tr>`).join('')}
  </table>
  <h3>Which money is for what</h3>
  <table>
    <tr><th>Bucket</th><th>Purpose</th><th>What sits there now</th><th class="num">Amount</th></tr>
    <tr><td><b>Safety</b></td><td>About 5 years of essential spending, near-zero risk. Bad markets don't touch it.</td><td>Cash, joint savings, the house (mortgaged)</td><td class="num">${fmt(e.cash)}</td></tr>
    <tr><td><b>Market</b></td><td>Long-term lifestyle and retirement. Diversified stocks and bonds.</td><td>401(k), IRAs, deferred comp, 529</td><td class="num">${fmt(e.investable)}</td></tr>
    <tr><td><b>Aspirational</b></td><td>Concentrated bets and ventures. Fine to lose.</td><td>${esc(p.careerScenarios.sideIncomeLabel || 'Side ventures')} (counted at $0), concentrated positions</td><td class="num">—</td></tr>
  </table>
  <p class="muted">Method: goals-based subportfolios (Brunel) and safety / market / aspirational risk buckets (Chhabra). Bucket sizing isn't set yet.</p>
</section>

<section>
  <h2>The full picture <small>(family extended balance sheet)</small></h2>
  ${pageKey([{ sw: 'background:var(--estbg);border:1px solid #ecdcb0', text: 'estimate' }, { html: 'Each row is a present value: future money, discounted to today at the rate shown' }])}
  <div class="two">
    <table>
      <tr><th>Assets</th><th class="num">Value</th></tr>
      <tr class="group"><td>Explicit</td><td class="num">${fmt(e.explicitAssets)}</td></tr>
      <tr><td class="indent">Accounts and home (see What we own and what we owe)</td><td class="num">${fmt(e.explicitAssets)}</td></tr>
      <tr class="group"><td>Implicit: future earnings to ${p.retirement.base}</td><td class="num">${fmt(hcTotal)}</td></tr>
      ${x.humanCapital.map(h => `<tr class="est"><td class="indent">${esc(OWNER_LABEL[h.member])}: ${esc(h.label)} <span class="muted">(${h.years} yrs @ ${pct(h.rate)})</span></td><td class="num">${fmt(h.pv)}</td></tr>`).join('')}
      ${Object.keys(p.humanCapital.pension || {}).map(m => `<tr class="est"><td class="indent">${esc(nameOf(m))}'s pension <span class="src est">not valued yet</span></td><td class="num">—</td></tr>`).join('')}
      <tr class="est"><td class="indent">Social Security <span class="src est">not valued yet</span></td><td class="num">—</td></tr>
      <tr class="total"><td>Total assets</td><td class="num">${fmt(x.assets)}</td></tr>
    </table>
    <table>
      <tr><th>Liabilities and surplus</th><th class="num">Value</th></tr>
      <tr class="group"><td>Explicit</td><td class="num">${fmt(e.explicitLiabs + e.deferredTax + e.homeSelling)}</td></tr>
      <tr><td class="indent">Mortgage and cards</td><td class="num">${fmt(e.explicitLiabs)}</td></tr>
      <tr class="est"><td class="indent">Tax owed on tax-deferred accounts</td><td class="num">${fmt(e.deferredTax)}</td></tr>
      <tr class="est"><td class="indent">Cost to sell the house</td><td class="num">${fmt(e.homeSelling)}</td></tr>
      <tr class="group"><td>Implicit: what we've committed to spend</td><td class="num">${fmt(x.implicitLiabs.reduce((a, i) => a + i.pv, 0))}</td></tr>
      ${x.implicitLiabs.map(i => `<tr class="est"><td class="indent">${esc(i.label)} <span class="muted">@ ${pct(i.rate)}</span></td><td class="num">${fmt(i.pv)}</td></tr>`).join('')}
      <tr class="total"><td>Total liabilities</td><td class="num">${fmt(x.liabs)}</td></tr>
      <tr class="total"><td class="${x.surplus >= 0 ? 'good' : 'bad'}">Surplus (discretionary wealth)</td><td class="num ${x.surplus >= 0 ? 'good' : 'bad'}">${fmt(x.surplus)}</td></tr>
    </table>
  </div>
  <div class="callout">How to read this: the surplus is what's left after every essential is paid for. It's the money we can put toward the kids, giving, or retiring early. Pensions and Social Security aren't counted yet, so the surplus is on the conservative side.</div>
</section>

<section>
  <h2>What if… <small>(stress tests)</small></h2>
  <p>Each line re-runs the full picture with one thing changed. A positive surplus means essentials are still covered.</p>
  <table>
    <tr><th>Scenario</th><th class="num">Surplus</th><th class="num">vs. base</th><th></th></tr>
    ${whatIfs.map(w => `<tr><td>${esc(w.label)}${w.illustrative ? ' <span class="src est">example</span>' : ''}</td>
      <td class="num ${w.r.surplus >= 0 ? 'good' : 'bad'}">${fmt(w.r.surplus)}</td>
      <td class="num">${w.id === 'base' ? '' : fmt(w.r.surplus - x.surplus)}</td>
      <td>${w.r.surplus >= 0 ? '✓ covered' : '✗ short'}</td></tr>`).join('')}
  </table>
  <p class="muted">Each line re-runs the lifetime balance sheet as a single path. The odds for retirement come from the market simulation (see Retirement: how the plan grows), under both outlooks.</p>
  ${s.marketDefaults ? `<h3>Market assumptions</h3>
  <table>
    <tr><th>Asset</th><th class="num">Real return</th><th>How it's built</th></tr>
    ${Object.entries(s.marketDefaults.defaults).map(([k, v]) => `<tr><td>${k === 'stocks' ? 'US stocks' : k === 'bonds' ? 'Bonds' : 'Cash'}</td><td class="num">${pct(v.realReturn)}</td><td>${esc(v.how)}</td></tr>`).join('')}
  </table>
  <p class="muted">Fetched ${esc(s.marketDefaults.fetchedAt.slice(0, 10))} from public sources: ${esc(Object.values(s.marketDefaults.sources).join('; '))}. Other asset classes keep fixed spreads to these.</p>
  ${(s.returnAssumptions || []).length ? `<table>
    <tr><th>Retirement account</th><th class="num">Default</th><th class="num">Used</th><th>Why</th></tr>
    ${s.returnAssumptions.map(r => `<tr${r.overridden ? ' class="est"' : ''}><td>${esc((e.lines.find(l => l.id === r.id) || {}).label || r.id)}${(e.lines.find(l => l.id === r.id) || {}).last4 ? ' …' + esc(e.lines.find(l => l.id === r.id).last4) : ''}</td><td class="num">${r.default != null ? pct(r.default) : '—'}</td><td class="num">${pct(r.used)}</td><td class="muted">${r.overridden ? 'override: ' + esc(r.source || '') : r.default == null ? 'set in the profile (no holdings data to build a default)' : 'default, from current holdings'}</td></tr>`).join('')}
  </table>` : ''}` : ''}
</section>

<section class="compact">
  <h2>Notes <small>(assumptions, sources, method)</small></h2>
  <h3>Assumptions</h3>
  <table>
    <tr><th>Assumption</th><th>Value</th><th>Source</th></tr>
    <tr><td>Ages</td><td>${p.household.members.map(m => `${esc(m.name)} ${m.age ?? '?'}`).join(', ')}</td><td>${esc([...new Set(p.household.members.map(m => m.source))].join('; '))}</td></tr>
    <tr><td>Retirement age (base)</td><td>${p.retirement.base} (also tested: ${p.retirement.scenarios.filter(a => a !== p.retirement.base).join(', ')})</td><td>${esc(p.retirement.source)}</td></tr>
    <tr><td>Plan to age</td><td>${p.retirement.planningHorizonAge}</td><td>Longevity buffer</td></tr>
    <tr><td>Tax on pay</td><td>${s.tax ? `${pct(s.tax.effectiveRate)} of gross, from the tax model (Taxes and take-home)` : pct(p.humanCapital.effectiveTaxRate)}</td><td>${esc(s.tax ? p.tax._note : p.humanCapital.effectiveTaxRateSource)}</td></tr>
    ${p.humanCapital.earners.map(er => `<tr><td>Real raises: ${esc(nameOf(er.member))}</td><td>${er.realGrowth.map((g, i, a) => `${g.rate >= 0 ? '+' : ''}${pct(g.rate)}/yr ${g.toAge >= 150 ? (i ? 'after that' : 'throughout') : `to age ${g.toAge}`}`).join(', ')}</td><td>${esc(er.growthSource)}</td></tr>`).join('')}
    <tr><td>Discount rates (real)</td><td>${p.humanCapital.earners.flatMap(er => er.streams.map(st => `${esc(nameOf(er.member))} ${esc(st.label.split(' (')[0].toLowerCase())} ${pct(st.discountReal)}`)).join(', ')}. Essential spending ${pct(p.spending.discountReal.essential)}, education ${pct(p.goalDiscountReal.important)}.</td><td>${esc(p.humanCapital._note || '')}</td></tr>
    ${p.goals.filter(g => g.annualOptions).map(g => `<tr><td>${esc(g.label)}</td><td>${esc(g.selected)}: ${fmt(g.annualOptions[g.selected])}/yr × ${g.years}, starting in ${g.startsInYears} yrs</td><td>${esc(g.source)}</td></tr>`).join('')}
  </table>
  <h3>Data freshness</h3>
  <ul>${s.stale.map(t => `<li>${esc(t)}</li>`).join('') || '<li>All synced accounts are under a week old.</li>'}</ul>
  <h3>Method</h3>
  <p>The family (extended) balance sheet, which adds human capital and the present value of lifestyle and goals to the explicit balance sheet; goals-based planning (describe → quantify and prioritize → subportfolios → manage), and liquidity and cash-flow planning. All implicit values are real (after inflation), with mid-year discounting. Human capital is after-tax pay to retirement. An employer match is counted pre-tax because it goes straight into the account. ${esc(p.careerScenarios.note || '')}</p>
  <h3>Not included yet</h3>
  <ul><li>${Object.keys(p.humanCapital.pension || {}).map(m => `${esc(nameOf(m))}'s pension`).concat(['Social Security']).join(', ')}. These would add to the surplus.</li>${p.spending.essentialShare == null ? '<li>A split of spending into essential and discretionary. Right now all of it is treated as essential, which is conservative.</li>' : ''}<li>Real tax modelling, health insurance before Medicare, and probability of success per goal.</li></ul>
  <div class="foot">Generated by Foliome on ${esc(s.generatedAt.slice(0, 10))}. This statement is saved so the next review can compare against it. Account numbers are shown by last 4 digits only.</div>
</section>
</body></html>`);
}

module.exports = { render, zoomChart, spendingDonut, progressBar, cardLibrary };
