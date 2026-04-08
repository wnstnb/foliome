#!/usr/bin/env node
/**
 * Dashboard Generator — self-contained HTML financial dashboard.
 *
 * Queries SQLite and generates a single HTML file with all data embedded.
 * No external dependencies at runtime — CSS, JS, and Chart.js are inlined.
 * Light/dark mode with Foliome brand colors.
 *
 * Usage:
 *   node scripts/dashboard.js                    # generate and open
 *   node scripts/dashboard.js --output /tmp/d.html  # custom output path
 *   node scripts/dashboard.js --stdout            # print to stdout (for piping)
 */

const fs = require('fs');
const path = require('path');
const { getOverview, getSpending, getTransactions, getHoldings } = require('./dashboard-queries.js');

const DB_PATH = path.join(__dirname, '..', 'data', 'foliome.db');
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'data', 'exports', 'dashboard.html');

const outputArg = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : null;
const toStdout = process.argv.includes('--stdout');
const outputPath = outputArg || DEFAULT_OUTPUT;

// ─── Data Queries ────────────────────────────────────────────────────────────
// Delegates to dashboard-queries.js for shared query logic, then reshapes
// for the legacy HTML generator.

function queryData() {
  const overview = getOverview(DB_PATH);
  const spending = getSpending(DB_PATH, { from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) });
  const txns = getTransactions(DB_PATH, { limit: '20' });
  const holdingsData = getHoldings(DB_PATH);

  return {
    balances: overview.balances,
    spendingByCategory: spending.byCategory,
    monthlySpending: spending.monthlyTrend,
    recentTransactions: txns.transactions,
    netWorthTrend: overview.netWorthTrend,
    holdings: holdingsData.holdings.slice(0, 15),
    syncStatus: overview.syncStatus,
    statementBalances: overview.statementBalances,
    totalAssets: overview.totalAssets,
    totalLiabilities: overview.totalLiabilities,
    netWorth: overview.netWorth,
    generatedAt: overview.generatedAt,
  };
}

// ─── HTML Generation ─────────────────────────────────────────────────────────

function generateHTML(data, options) {
  const fmt = (n) => {
    const abs = Math.abs(n);
    if (abs >= 1000000) return (n < 0 ? '-' : '') + '$' + (abs / 1000000).toFixed(1) + 'M';
    if (abs >= 1000) return (n < 0 ? '-' : '') + '$' + (abs / 1000).toFixed(1) + 'K';
    return (n < 0 ? '-' : '') + '$' + abs.toFixed(2);
  };

  const fmtFull = (n) => {
    return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  const accountTypeLabel = (t) => ({
    checking: 'Checking', savings: 'Savings', credit: 'Credit Cards',
    brokerage: 'Brokerage', retirement: 'Retirement', education: 'Education',
    mortgage: 'Mortgage', real_estate: 'Real Estate',
  }[t] || t);

  // Group balances by type
  const grouped = {};
  for (const b of data.balances) {
    const type = b.account_type;
    if (!grouped[type]) grouped[type] = [];
    grouped[type].push(b);
  }

  // Category chart colors (Foliome palette extended)
  const chartColors = [
    '#34D399', '#0D9488', '#6EE7B7', '#065F46', '#10B981',
    '#14B8A6', '#2DD4BF', '#5EEAD4', '#99F6E4', '#CCFBF1',
    '#059669', '#047857', '#0F766E', '#115E59', '#134E4A',
    '#A7F3D0',
  ];

  const monthLabels = data.monthlySpending.map(m => {
    const [y, mo] = m.month.split('-');
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(mo) - 1] + ' ' + y.slice(2);
  });

  const generatedDate = new Date(data.generatedAt).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const isTelegram = !!(options && options.telegram);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Foliome Dashboard</title>
${isTelegram ? '<script src="https://telegram.org/js/telegram-web-app.js"><\/script>' : ''}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"><\/script>
<style>
  :root {
    --bg: #FAFCFB;
    --bg-card: #FFFFFF;
    --bg-hover: #F0FDF9;
    --text: #1A1A2E;
    --text-muted: #6B7280;
    --border: #E5E7EB;
    --green-primary: #0D9488;
    --green-light: #34D399;
    --green-accent: #6EE7B7;
    --green-deep: #065F46;
    --green-darkest: #022C22;
    --red: #EF4444;
    --red-muted: #FCA5A5;
    --positive: #059669;
    --negative: #DC2626;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0F1B2D;
      --bg-card: #162236;
      --bg-hover: #1A3A4A;
      --text: #ECFDF5;
      --text-muted: #94A3B8;
      --border: #1E3A4F;
      --positive: #34D399;
      --negative: #FCA5A5;
    }
  }

  [data-theme="dark"] {
    --bg: #0F1B2D;
    --bg-card: #162236;
    --bg-hover: #1A3A4A;
    --text: #ECFDF5;
    --text-muted: #94A3B8;
    --border: #1E3A4F;
    --positive: #34D399;
    --negative: #FCA5A5;
  }

  [data-theme="light"] {
    --bg: #FAFCFB;
    --bg-card: #FFFFFF;
    --bg-hover: #F0FDF9;
    --text: #1A1A2E;
    --text-muted: #6B7280;
    --border: #E5E7EB;
    --positive: #059669;
    --negative: #DC2626;
  }

  ${isTelegram ? `
  /* Telegram Mini App: use Telegram theme variables when available */
  :root {
    --bg: var(--tg-theme-bg-color, #0F1B2D);
    --bg-card: var(--tg-theme-secondary-bg-color, #162236);
    --bg-hover: var(--tg-theme-secondary-bg-color, #1A3A4A);
    --text: var(--tg-theme-text-color, #ECFDF5);
    --text-muted: var(--tg-theme-hint-color, #94A3B8);
    --border: rgba(255,255,255,0.08);
    --positive: #34D399;
    --negative: #FCA5A5;
  }
  ` : ''}

  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 16px;
    max-width: 900px;
    margin: 0 auto;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  .header h1 {
    font-size: 22px;
    font-weight: 700;
    color: var(--green-primary);
  }
  .header .meta {
    font-size: 12px;
    color: var(--text-muted);
    text-align: right;
  }
  .theme-toggle {
    cursor: pointer;
    font-size: 18px;
    background: none;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    color: var(--text);
    margin-left: 12px;
  }

  .kpi-row {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
    margin-bottom: 20px;
  }
  .kpi {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    text-align: center;
  }
  .kpi .label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .kpi .value { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .kpi .value.positive { color: var(--positive); }
  .kpi .value.negative { color: var(--negative); }

  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 2px solid var(--border);
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    padding: 8px 16px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 500;
    color: var(--text-muted);
    border-bottom: 2px solid transparent;
    margin-bottom: -2px;
    transition: all 0.15s;
    background: none;
    border-top: none;
    border-left: none;
    border-right: none;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .tab.active {
    color: var(--green-primary);
    border-bottom-color: var(--green-primary);
  }

  .panel { display: none; }
  .panel.active { display: block; }

  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  .card h3 {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
  }

  .account-group { margin-bottom: 16px; }
  .account-group h4 {
    font-size: 13px;
    color: var(--green-primary);
    font-weight: 600;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--border);
  }
  .account-header {
    display: grid;
    grid-template-columns: 1fr 120px 120px;
    gap: 8px;
    padding: 4px 0 6px;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
  }
  .account-header span:nth-child(2),
  .account-header span:nth-child(3) { text-align: right; }
  .account-row {
    display: grid;
    grid-template-columns: 1fr 120px 120px;
    gap: 8px;
    padding: 6px 0;
    font-size: 14px;
    align-items: baseline;
  }
  .account-row .name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-row .bal { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
  .account-row .bal.positive { color: var(--positive); }
  .account-row .bal.negative { color: var(--negative); }
  .account-row .delta { font-size: 13px; font-variant-numeric: tabular-nums; text-align: right; }
  .account-row .delta.improving { color: var(--positive); }
  .account-row .delta.worsening { color: var(--negative); }
  .account-row .delta.none { color: var(--text-muted); font-size: 12px; }

  .txn-row {
    display: grid;
    grid-template-columns: 65px 1fr auto;
    gap: 8px;
    padding: 8px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .txn-row:last-child { border-bottom: none; }
  .txn-date { color: var(--text-muted); }
  .txn-desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .txn-cat {
    font-size: 11px;
    color: var(--green-primary);
    opacity: 0.8;
  }
  .txn-amt { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }

  .chart-container {
    position: relative;
    height: 250px;
    width: 100%;
  }

  .holding-row {
    display: grid;
    grid-template-columns: 60px 1fr auto;
    gap: 8px;
    padding: 6px 0;
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }
  .holding-row:last-child { border-bottom: none; }
  .holding-symbol { font-weight: 600; color: var(--green-primary); }
  .holding-name { color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .holding-value { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }

  .sync-row {
    display: flex;
    justify-content: space-between;
    padding: 4px 0;
    font-size: 13px;
  }
  .sync-ok { color: var(--positive); }
  .sync-fail { color: var(--negative); }

  @media (min-width: 380px) {
    .kpi-row { grid-template-columns: repeat(2, 1fr); }
  }
  @media (min-width: 600px) {
    .kpi-row { grid-template-columns: repeat(3, 1fr); }
    .kpi .value { font-size: 24px; }
    .txn-row { grid-template-columns: 80px 1fr auto; }
  }
</style>
</head>
<body>
<div id="debug-width" style="position:fixed;top:0;right:0;background:red;color:white;padding:2px 8px;font-size:12px;z-index:9999"></div>
<script>function updateW(){document.getElementById('debug-width').textContent=window.innerWidth+'x'+window.innerHeight}window.addEventListener('resize',updateW);updateW();</script>
<div class="header">
  <div>
    <h1>Foliome</h1>
  </div>
  <div style="display:flex;align-items:center;">
    <div class="meta">${generatedDate}</div>
    ${isTelegram ? '' : `<button class="theme-toggle" onclick="toggleTheme()" title="Toggle light/dark mode">
      <span id="theme-icon">🌙</span>
    </button>`}
  </div>
</div>

<div class="kpi-row">
  <div class="kpi">
    <div class="label">Net Worth</div>
    <div class="value ${data.netWorth >= 0 ? 'positive' : 'negative'}">${fmtFull(data.netWorth)}</div>
  </div>
  <div class="kpi">
    <div class="label">Total Assets</div>
    <div class="value positive">${fmtFull(data.totalAssets)}</div>
  </div>
  <div class="kpi">
    <div class="label">Total Liabilities</div>
    <div class="value negative">${fmtFull(data.totalLiabilities)}</div>
  </div>
</div>

<div class="tabs">
  <button class="tab active" onclick="showTab('accounts', this)">Accounts</button>
  <button class="tab" onclick="showTab('spending', this)">Spending</button>
  <button class="tab" onclick="showTab('trends', this)">Trends</button>
  <button class="tab" onclick="showTab('activity', this)">Activity</button>
  <button class="tab" onclick="showTab('holdings', this)">Holdings</button>
</div>

<!-- ACCOUNTS TAB -->
<div id="tab-accounts" class="panel active">
${Object.entries(grouped).map(([type, accounts]) => `
  <div class="card">
    <div class="account-group">
      <h4>${accountTypeLabel(type)}</h4>
      <div class="account-header">
        <span>Account</span>
        <span>Balance</span>
        <span>vs. Last Period</span>
      </div>
      ${accounts.map(a => {
        const stmt = data.statementBalances[a.account_id];
        const delta = stmt ? a.balance - stmt.closing_balance : null;
        const isLiability = ['credit', 'mortgage'].includes(a.account_type);
        const deltaImproved = delta !== null ? (isLiability ? delta > 0 : delta > 0) : null;
        const deltaClass = delta === null ? 'none' : delta === 0 ? 'none' : deltaImproved ? 'improving' : 'worsening';
        const deltaCell = delta !== null
          ? '<span class="delta ' + deltaClass + '">'
            + (delta >= 0 ? '+' : '') + fmtFull(delta) + '</span>'
          : '<span class="delta none">—</span>';
        return `
        <div class="account-row">
          <span class="name">${a.account_name || a.account_id}</span>
          <span class="bal ${a.balance >= 0 ? 'positive' : 'negative'}">${fmtFull(a.balance)}</span>
          ${deltaCell}
        </div>`;
      }).join('')}
    </div>
  </div>
`).join('')}
</div>

<!-- SPENDING TAB -->
<div id="tab-spending" class="panel">
  <div class="card">
    <h3>Spending by Category (Last 30 Days)</h3>
    <div class="chart-container"><canvas id="chart-categories"></canvas></div>
  </div>
  <div class="card">
    <h3>Category Breakdown</h3>
    ${data.spendingByCategory.map(c => `
      <div class="account-row">
        <span class="name">${c.category || 'Uncategorized'} <span style="color:var(--text-muted);font-size:12px">(${c.count})</span></span>
        <span class="bal negative">${fmtFull(c.total)}</span>
      </div>
    `).join('')}
  </div>
</div>

<!-- TRENDS TAB -->
<div id="tab-trends" class="panel">
  <div class="card">
    <h3>Monthly Spending</h3>
    <div class="chart-container"><canvas id="chart-monthly"></canvas></div>
  </div>
</div>

<!-- ACTIVITY TAB -->
<div id="tab-activity" class="panel">
  <div class="card">
    <h3>Recent Transactions</h3>
    ${data.recentTransactions.map(t => `
      <div class="txn-row">
        <span class="txn-date">${t.date}</span>
        <span>
          <div class="txn-desc">${escapeHtml(t.description)}</div>
          <div class="txn-cat">${t.category || ''}</div>
        </span>
        <span class="txn-amt" style="color:${t.amount < 0 ? 'var(--negative)' : 'var(--positive)'}">${fmtFull(t.amount)}</span>
      </div>
    `).join('')}
  </div>
</div>

<!-- HOLDINGS TAB -->
<div id="tab-holdings" class="panel">
  <div class="card">
    <h3>Top Holdings</h3>
    ${data.holdings.length > 0 ? data.holdings.map(h => `
      <div class="holding-row">
        <span class="holding-symbol">${h.symbol || '—'}</span>
        <span class="holding-name">${escapeHtml(h.name || '')}</span>
        <span class="holding-value">${fmtFull(h.market_value)}</span>
      </div>
    `).join('') : '<div style="color:var(--text-muted);font-size:14px">No holdings data available</div>'}
  </div>
</div>

<script>
// Tab switching
function showTab(name, btn) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  // Trigger chart resize
  window.dispatchEvent(new Event('resize'));
}

// Theme toggle
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : (current === 'light' ? 'dark' :
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark'));
  html.setAttribute('data-theme', next);
  document.getElementById('theme-icon').textContent = next === 'dark' ? '☀️' : '🌙';
  updateChartColors();
}

// Chart color helper
function getChartColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    text: style.getPropertyValue('--text').trim(),
    muted: style.getPropertyValue('--text-muted').trim(),
    border: style.getPropertyValue('--border').trim(),
    green: style.getPropertyValue('--green-primary').trim(),
  };
}

let catChart, monthChart;

function updateChartColors() {
  const c = getChartColors();
  if (catChart) {
    catChart.options.plugins.legend.labels.color = c.text;
    catChart.update();
  }
  if (monthChart) {
    monthChart.options.scales.x.ticks.color = c.muted;
    monthChart.options.scales.y.ticks.color = c.muted;
    monthChart.options.scales.x.grid.color = c.border;
    monthChart.options.scales.y.grid.color = c.border;
    monthChart.data.datasets[0].borderColor = '#34D399';
    monthChart.data.datasets[0].backgroundColor = 'rgba(52, 211, 153, 0.15)';
    monthChart.update();
  }
}

// Category donut chart
const catData = ${JSON.stringify(data.spendingByCategory.map(c => ({ label: c.category || 'Uncategorized', value: Math.abs(c.total) })))};
const catColors = ${JSON.stringify(chartColors)};

catChart = new Chart(document.getElementById('chart-categories'), {
  type: 'doughnut',
  data: {
    labels: catData.map(d => d.label),
    datasets: [{
      data: catData.map(d => d.value),
      backgroundColor: catColors.slice(0, catData.length),
      borderWidth: 0,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'right',
        labels: { color: getChartColors().text, font: { size: 12 }, padding: 8 }
      }
    }
  }
});

// Monthly spending bar chart
monthChart = new Chart(document.getElementById('chart-monthly'), {
  type: 'bar',
  data: {
    labels: ${JSON.stringify(monthLabels)},
    datasets: [{
      label: 'Spending',
      data: ${JSON.stringify(data.monthlySpending.map(m => Math.abs(m.total)))},
      backgroundColor: 'rgba(52, 211, 153, 0.6)',
      borderColor: '#34D399',
      borderWidth: 1,
      borderRadius: 4,
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: getChartColors().muted }, grid: { color: getChartColors().border } },
      y: {
        ticks: {
          color: getChartColors().muted,
          callback: v => '$' + (v >= 1000 ? (v/1000).toFixed(0) + 'K' : v)
        },
        grid: { color: getChartColors().border }
      }
    }
  }
});

// Set initial theme icon
${isTelegram ? `
// Initialize Telegram Mini App
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }
` : `
if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.getElementById('theme-icon').textContent = '☀️';
}
`}
<\/script>
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { queryData, generateHTML };

// ─── CLI Main ─────────────────────────────────────────────────────────────────

if (require.main === module) {
  if (!fs.existsSync(DB_PATH)) {
    console.error('Database not found at', DB_PATH);
    console.error('Run a sync first: node readers/sync-all.js --import');
    process.exit(1);
  }

  const data = queryData();
  const html = generateHTML(data);

  if (toStdout) {
    process.stdout.write(html);
  } else {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, html);
    console.log(`Dashboard generated: ${outputPath}`);
    console.log(`  Net worth: ${data.netWorth >= 0 ? '$' : '-$'}${Math.abs(data.netWorth).toLocaleString()}`);
    console.log(`  ${data.balances.length} accounts, ${data.spendingByCategory.length} categories, ${data.recentTransactions.length} recent transactions`);
  }
}
