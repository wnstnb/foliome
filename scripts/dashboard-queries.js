const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB = path.join(__dirname, '..', 'data', 'foliome.db');

function openDb(dbPath) {
  return new Database(dbPath || DEFAULT_DB, { readonly: true });
}

// getOverview(dbPath) - returns balances, statement balances, sync status, net worth trend, alerts
// This is the most important one - it powers the Overview tab
function getOverview(dbPath) {
  const db = openDb(dbPath);

  // Latest balance per account
  const balances = db.prepare(`
    SELECT b.institution, b.account_id, b.account_name, b.account_type, b.balance, b.synced_at
    FROM balances b
    INNER JOIN (SELECT account_id, MAX(synced_at) as ms FROM balances GROUP BY account_id) m
    ON b.account_id = m.account_id AND b.synced_at = m.ms
    ORDER BY b.account_type, b.balance DESC
  `).all();

  // Most recent statement closing balance per account
  let statementBalances = {};
  try {
    const stmts = db.prepare(`
      SELECT sb.account_id, sb.period_end, sb.closing_balance
      FROM statement_balances sb
      INNER JOIN (SELECT account_id, MAX(period_end) as mp FROM statement_balances GROUP BY account_id) m
      ON sb.account_id = m.account_id AND sb.period_end = m.mp
    `).all();
    for (const sb of stmts) statementBalances[sb.account_id] = sb;
  } catch {}

  // Net worth trend (monthly, last 12 months)
  const netWorthTrend = db.prepare(`
    SELECT month, SUM(balance) as net_worth FROM (
      SELECT strftime('%Y-%m', b.synced_at) as month, b.account_id, b.balance
      FROM balances b
      INNER JOIN (
        SELECT account_id as aid, strftime('%Y-%m', synced_at) as m, MAX(synced_at) as ms
        FROM balances GROUP BY aid, m
      ) latest ON b.account_id = latest.aid AND b.synced_at = latest.ms
    )
    GROUP BY month ORDER BY month
  `).all();

  // Sync status
  const syncStatus = db.prepare(`
    SELECT institution, status, last_success FROM sync_status ORDER BY institution
  `).all();

  // Savings rate (current month income vs spending)
  let savingsRate = null;
  try {
    const sr = db.prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 AND category = 'Income' THEN amount ELSE 0 END) as income,
        SUM(CASE WHEN amount < 0 AND category NOT IN ('Transfer', 'Income') THEN amount ELSE 0 END) as spending
      FROM transactions
      WHERE date >= date('now', 'start of month')
    `).get();
    if (sr && sr.income > 0) savingsRate = ((sr.income + sr.spending) / sr.income) * 100;
  } catch {}

  // Alerts: credit cards with upcoming due dates
  // (We get credit balances; payment-schedule.json has due dates)
  const creditBalances = balances.filter(b => b.account_type === 'credit');
  let alerts = [];
  try {
    const schedulePath = path.join(__dirname, '..', 'config', 'payment-schedule.json');
    if (fs.existsSync(schedulePath)) {
      const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
      const now = new Date();
      alerts = creditBalances.map(b => {
        const entry = schedule[b.account_id];
        if (!entry) return null;
        const dueDay = entry.due_day;
        let dueDate = new Date(now.getFullYear(), now.getMonth(), dueDay);
        if (dueDate < now) dueDate = new Date(now.getFullYear(), now.getMonth() + 1, dueDay);
        const daysUntil = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
        return {
          account_id: b.account_id,
          account_name: b.account_name || entry.account_name || b.account_id,
          balance: b.balance,
          due_day: dueDay,
          days_until: daysUntil,
        };
      }).filter(Boolean).sort((a, b) => a.days_until - b.days_until);
    }
  } catch {}

  const totalAssets = balances.filter(b => b.balance > 0).reduce((s, b) => s + b.balance, 0);
  const totalLiabilities = balances.filter(b => b.balance < 0).reduce((s, b) => s + b.balance, 0);

  db.close();
  return {
    balances,
    statementBalances,
    syncStatus,
    totalAssets,
    totalLiabilities,
    netWorth: totalAssets + totalLiabilities,
    netWorthTrend,
    savingsRate,
    alerts,
    generatedAt: new Date().toISOString(),
  };
}

// getTransactions(dbPath, filters) - filtered transaction list
function getTransactions(dbPath, filters = {}) {
  const db = openDb(dbPath);
  const { from, to, accounts, categories, q, limit } = filters;

  let where = ['1=1'];
  const params = {};

  if (from) { where.push('date >= $from'); params.from = from; }
  if (to) { where.push('date <= $to'); params.to = to; }
  if (accounts && accounts.length) {
    where.push(`account_id IN (${accounts.map((_, i) => `$a${i}`).join(',')})`);
    accounts.forEach((a, i) => params[`a${i}`] = a);
  }
  if (categories && categories.length) {
    where.push(`COALESCE(user_category, category) IN (${categories.map((_, i) => `$c${i}`).join(',')})`);
    categories.forEach((c, i) => params[`c${i}`] = c);
  }
  if (q) { where.push('description LIKE $q'); params.q = `%${q}%`; }

  const whereClause = where.join(' AND ');
  const limitClause = limit ? `LIMIT ${parseInt(limit)}` : 'LIMIT 200';

  const transactions = db.prepare(`
    SELECT institution, account_id, date, description, amount,
           category, user_category
    FROM transactions
    WHERE ${whereClause}
    ORDER BY date DESC, created_at DESC
    ${limitClause}
  `).all(params);

  const summary = db.prepare(`
    SELECT COUNT(*) as count,
           SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) as inflow,
           SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) as outflow,
           SUM(amount) as net
    FROM transactions
    WHERE ${whereClause}
  `).get(params);

  // Get distinct accounts and categories for filter options
  const accountList = db.prepare(`SELECT DISTINCT account_id FROM transactions ORDER BY account_id`).all().map(r => r.account_id);
  const categoryList = db.prepare(`SELECT DISTINCT COALESCE(user_category, category) as cat FROM transactions WHERE cat IS NOT NULL ORDER BY cat`).all().map(r => r.cat);

  db.close();
  return {
    transactions,
    summary: summary || { count: 0, inflow: 0, outflow: 0, net: 0 },
    accounts: accountList,
    categories: categoryList,
  };
}

// getSpending(dbPath, filters) - category breakdown + monthly trend
function getSpending(dbPath, filters = {}) {
  const db = openDb(dbPath);
  const { from, to, accounts } = filters;

  let where = ["category NOT IN ('Transfer', 'Income')", 'amount < 0'];
  const params = {};

  if (from) { where.push('date >= $from'); params.from = from; }
  if (to) { where.push('date <= $to'); params.to = to; }
  if (accounts && accounts.length) {
    where.push(`account_id IN (${accounts.map((_, i) => `$a${i}`).join(',')})`);
    accounts.forEach((a, i) => params[`a${i}`] = a);
  }

  const whereClause = where.join(' AND ');

  const byCategory = db.prepare(`
    SELECT COALESCE(user_category, category) as category, SUM(amount) as total, COUNT(*) as count
    FROM transactions
    WHERE ${whereClause}
    GROUP BY COALESCE(user_category, category)
    ORDER BY total ASC
  `).all(params);

  const monthlyTrend = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(amount) as total
    FROM transactions
    WHERE ${whereClause}
    GROUP BY month
    ORDER BY month
  `).all(params);

  const total = byCategory.reduce((s, c) => s + c.total, 0);

  db.close();
  return { byCategory, monthlyTrend, total };
}

// getHoldings(dbPath) - current investment positions
function getHoldings(dbPath) {
  const db = openDb(dbPath);

  const holdings = db.prepare(`
    SELECT h.account_id, h.symbol, h.name, h.quantity, h.price, h.market_value,
           h.market_value * 100.0 / SUM(h.market_value) OVER () as pct_allocation
    FROM holdings h
    INNER JOIN (SELECT account_id, symbol, MAX(synced_at) as ms FROM holdings GROUP BY account_id, symbol) m
    ON h.account_id = m.account_id AND h.symbol = m.symbol AND h.synced_at = m.ms
    WHERE h.market_value > 0
    ORDER BY h.market_value DESC
  `).all();

  const totalValue = holdings.reduce((s, h) => s + h.market_value, 0);

  db.close();
  return { holdings, totalValue };
}

// getSubscriptions(dbPath) - recurring charges detected by pattern
function getSubscriptions(dbPath) {
  const db = openDb(dbPath);

  const subscriptions = db.prepare(`
    SELECT LOWER(SUBSTR(description, 1, 30)) as merchant,
           COUNT(*) as occurrences,
           AVG(amount) as avg_amount,
           MAX(date) as last_charged,
           SUM(amount) as total
    FROM transactions
    WHERE COALESCE(user_category, category) = 'Subscription'
      AND date >= date('now', '-90 days')
    GROUP BY merchant
    HAVING occurrences >= 2
    ORDER BY avg_amount ASC
  `).all();

  const monthlyTotal = subscriptions.reduce((s, sub) => s + Math.abs(sub.avg_amount), 0);

  db.close();
  return {
    subscriptions,
    monthlyTotal,
    annualTotal: monthlyTotal * 12,
  };
}

// getHealth(dbPath) - monthly net worth, assets, liabilities, savings rate history
function getHealth(dbPath) {
  const db = openDb(dbPath);

  const months = db.prepare(`
    SELECT month,
           SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END) as assets,
           SUM(CASE WHEN balance < 0 THEN balance ELSE 0 END) as liabilities,
           SUM(balance) as net_worth
    FROM (
      SELECT strftime('%Y-%m', b.synced_at) as month, b.account_id, b.balance
      FROM balances b
      INNER JOIN (
        SELECT account_id as aid, strftime('%Y-%m', synced_at) as m, MAX(synced_at) as ms
        FROM balances GROUP BY aid, m
      ) latest ON b.account_id = latest.aid AND b.synced_at = latest.ms
    )
    GROUP BY month
    ORDER BY month
  `).all();

  // Add savings rate per month
  for (const m of months) {
    try {
      const sr = db.prepare(`
        SELECT
          SUM(CASE WHEN amount > 0 AND category = 'Income' THEN amount ELSE 0 END) as income,
          SUM(CASE WHEN amount < 0 AND category NOT IN ('Transfer', 'Income') THEN amount ELSE 0 END) as spending
        FROM transactions
        WHERE strftime('%Y-%m', date) = $month
      `).get({ month: m.month });
      m.income = sr?.income || 0;
      m.spending = sr?.spending || 0;
      m.savings_rate = sr && sr.income > 0 ? ((sr.income + sr.spending) / sr.income) * 100 : null;
    } catch {
      m.savings_rate = null;
    }
  }

  db.close();
  return { months };
}

// getBudgets(dbPath, configPath) - budget config + current month spending
function getBudgets(dbPath, configPath) {
  const db = openDb(dbPath);
  const budgetConfigPath = configPath || path.join(__dirname, '..', 'config', 'budgets.json');

  let budgetConfig = {};
  try {
    if (fs.existsSync(budgetConfigPath)) {
      budgetConfig = JSON.parse(fs.readFileSync(budgetConfigPath, 'utf8'));
    }
  } catch {}

  // Current month spending by category
  const spending = db.prepare(`
    SELECT COALESCE(user_category, category) as category,
           SUM(amount) as spent,
           COUNT(*) as txn_count
    FROM transactions
    WHERE date >= date('now', 'start of month')
      AND category NOT IN ('Transfer', 'Income')
      AND amount < 0
    GROUP BY category
    ORDER BY spent ASC
  `).all();

  db.close();

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  // Merge budget config with actual spending
  const categories = Object.entries(budgetConfig).map(([category, budget]) => {
    const actual = spending.find(s => s.category === category);
    return {
      category,
      budget,
      spent: actual ? Math.abs(actual.spent) : 0,
      txn_count: actual ? actual.txn_count : 0,
    };
  });

  const totalBudget = categories.reduce((s, c) => s + c.budget, 0);
  const totalSpent = categories.reduce((s, c) => s + c.spent, 0);

  return { categories, totalBudget, totalSpent, daysInMonth, dayOfMonth };
}

module.exports = { getOverview, getTransactions, getSpending, getHoldings, getSubscriptions, getHealth, getBudgets };
