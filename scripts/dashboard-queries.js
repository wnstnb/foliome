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

// getHoldings(dbPath) - current investment positions, grouped by underlying
function getHoldings(dbPath) {
  const db = openDb(dbPath);

  // Fetch latest holdings including new structured fields
  const holdings = db.prepare(`
    SELECT h.account_id, h.symbol, h.name, h.quantity, h.price, h.market_value, h.cost_basis,
           h.underlying, h.instrument_type, h.put_call, h.strike, h.expiry, h.multiplier
    FROM holdings h
    INNER JOIN (SELECT account_id, symbol, MAX(synced_at) as ms FROM holdings GROUP BY account_id, symbol) m
    ON h.account_id = m.account_id AND h.symbol = m.symbol AND h.synced_at = m.ms
    WHERE h.market_value != 0 OR h.quantity != 0
    ORDER BY h.market_value DESC
  `).all();

  const totalValue = holdings.reduce((s, h) => s + (h.market_value || 0), 0);

  // Build account list with display names (from balances table)
  const accountIds = [...new Set(holdings.map(h => h.account_id))];
  const accounts = accountIds.map(id => {
    let name = id;
    try {
      const bal = db.prepare(`SELECT account_name FROM balances WHERE account_id = ? ORDER BY synced_at DESC LIMIT 1`).get(id);
      if (bal?.account_name) name = bal.account_name;
    } catch {}
    return { account_id: id, account_name: name };
  });

  // Build grouped structure by underlying
  const groupMap = {};
  for (const h of holdings) {
    const key = h.underlying || h.symbol || 'OTHER';
    if (!groupMap[key]) {
      groupMap[key] = {
        underlying: key,
        totalMarketValue: 0,
        totalCostBasis: 0,
        totalShares: 0,
        optionCount: 0,
        pct_allocation: 0,
        positions: [],
      };
    }
    groupMap[key].totalMarketValue += (h.market_value || 0);
    groupMap[key].totalCostBasis += (h.cost_basis || 0);
    if (h.instrument_type !== 'option') groupMap[key].totalShares += (h.quantity || 0);
    else groupMap[key].optionCount++;
    groupMap[key].positions.push(h);
  }

  // Sort positions within each group: equity first, then options by expiry
  const groups = Object.values(groupMap).map(g => {
    g.positions.sort((a, b) => {
      if (a.instrument_type === 'equity' && b.instrument_type !== 'equity') return -1;
      if (a.instrument_type !== 'equity' && b.instrument_type === 'equity') return 1;
      if (a.expiry && b.expiry) return a.expiry.localeCompare(b.expiry);
      return 0;
    });
    g.pct_allocation = totalValue > 0 ? (g.totalMarketValue / totalValue) * 100 : 0;
    return g;
  });

  groups.sort((a, b) => Math.abs(b.totalMarketValue) - Math.abs(a.totalMarketValue));

  db.close();
  return { holdings, groups, accounts, totalValue };
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
// Supports: plain numbers, {limit, rollover} objects, and scoped budgets
// Scoped budgets filter by account_type, institution, or explicit account list
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
  // GROUP BY 1 ensures grouping by the COALESCE alias, not the raw column
  const spending = db.prepare(`
    SELECT COALESCE(user_category, category) as category,
           SUM(amount) as spent,
           COUNT(*) as txn_count
    FROM transactions
    WHERE date >= date('now', 'start of month')
      AND category NOT IN ('Transfer', 'Income')
      AND amount < 0
    GROUP BY 1
    ORDER BY spent ASC
  `).all();

  // Last month spending by category (for rollover calculation)
  const lastMonthSpending = db.prepare(`
    SELECT COALESCE(user_category, category) as category,
           SUM(amount) as spent
    FROM transactions
    WHERE date >= date('now', 'start of month', '-1 month')
      AND date < date('now', 'start of month')
      AND category NOT IN ('Transfer', 'Income')
      AND amount < 0
    GROUP BY 1
  `).all();

  // All current-month transactions with account + category info (for scoped budgets)
  const allTxns = db.prepare(`
    SELECT t.account_id, t.amount,
           COALESCE(t.user_category, t.category) as category,
           (SELECT b.account_type FROM balances b
            WHERE b.account_id = t.account_id
            ORDER BY b.synced_at DESC LIMIT 1) as account_type
    FROM transactions t
    WHERE t.date >= date('now', 'start of month')
      AND t.amount < 0
  `).all();

  db.close();

  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dayOfMonth = now.getDate();

  const categories = [];
  const scopedBudgets = [];

  for (const [label, value] of Object.entries(budgetConfig)) {
    // Parse config: plain number, {limit} object, or {limit, scope} object
    const isObject = typeof value === 'object' && value !== null;
    const limit = isObject ? value.limit : value;
    const rollover = isObject && value.rollover === true;
    const scope = isObject ? value.scope : undefined;

    if (scope) {
      // Scoped budget — filter transactions by scope criteria
      const matched = allTxns.filter(t => {
        // Account filter (at least one must be specified)
        let accountMatch = false;
        if (scope.accounts) accountMatch = scope.accounts.includes(t.account_id);
        else if (scope.account_type) accountMatch = t.account_type === scope.account_type;
        else if (scope.institution) accountMatch = t.account_id.startsWith(scope.institution + '-');
        if (!accountMatch) return false;

        // Category filter (optional — whitelist takes precedence over blacklist)
        if (scope.categories) return scope.categories.includes(t.category);
        if (scope.exclude_categories) return !scope.exclude_categories.includes(t.category);
        return true;
      });
      const spent = matched.reduce((s, t) => s + Math.abs(t.amount), 0);

      // Build human-readable description of what this budget tracks
      const descParts = [];
      if (scope.account_type) descParts.push(`All ${scope.account_type} accounts`);
      else if (scope.institution) descParts.push(`All ${scope.institution} accounts`);
      else if (scope.accounts) descParts.push(`Accounts: ${scope.accounts.join(', ')}`);
      if (scope.categories) descParts.push(`Only: ${scope.categories.join(', ')}`);
      if (scope.exclude_categories) descParts.push(`Excludes: ${scope.exclude_categories.join(', ')}`);
      descParts.push(`Limit: $${limit.toLocaleString()}/mo`);

      scopedBudgets.push({
        label,
        budget: limit,
        spent: Math.round(spent * 100) / 100,
        txn_count: matched.length,
        scope,
        description: descParts.join(' · '),
      });
    } else {
      // Category budget
      const actual = spending.find(s => s.category === label);
      let effectiveBudget = limit;
      let rolloverAmount = 0;

      if (rollover) {
        const lastMonth = lastMonthSpending.find(s => s.category === label);
        const lastMonthSpent = lastMonth ? Math.abs(lastMonth.spent) : 0;
        rolloverAmount = limit - lastMonthSpent;
        // Cap rollover at 1x the monthly limit to prevent balloon
        rolloverAmount = Math.max(-limit, Math.min(limit, rolloverAmount));
        effectiveBudget = limit + rolloverAmount;
      }

      // Build description
      const catDescParts = [`Category: ${label}`, `Limit: $${limit.toLocaleString()}/mo`];
      if (rollover) catDescParts.push(`Rollover enabled (capped at $${limit.toLocaleString()})`);

      categories.push({
        category: label,
        budget: effectiveBudget,
        baseBudget: limit,
        rollover,
        rolloverAmount: rollover ? rolloverAmount : 0,
        spent: actual ? Math.abs(actual.spent) : 0,
        txn_count: actual ? actual.txn_count : 0,
        description: catDescParts.join(' · '),
      });
    }
  }

  const totalBudget = categories.reduce((s, c) => s + c.budget, 0);
  const totalSpent = categories.reduce((s, c) => s + c.spent, 0);

  // Daily cumulative spending for pacing chart (category budgets only)
  // Build a day-by-day cumulative total from allTxns filtered to budget categories
  const budgetCategoryNames = new Set(categories.map(c => c.category));
  const dailySpend = {};
  for (const t of allTxns) {
    if (!t.category || !budgetCategoryNames.has(t.category)) continue;
    // Extract day-of-month from account_id? No — need date. Query separately.
  }

  // Query daily totals for budget categories
  const reopenDb = openDb(dbPath);
  const budgetCatList = categories.map(c => c.category);
  const placeholders = budgetCatList.map((_, i) => `$cat${i}`).join(',');
  const catParams = {};
  budgetCatList.forEach((c, i) => catParams[`cat${i}`] = c);

  let dailyCumulative = [];
  if (budgetCatList.length > 0) {
    const dailyRows = reopenDb.prepare(`
      SELECT CAST(strftime('%d', date) AS INTEGER) as day,
             ROUND(SUM(ABS(amount)), 2) as spent
      FROM transactions
      WHERE date >= date('now', 'start of month')
        AND COALESCE(user_category, category) IN (${placeholders})
        AND amount < 0
      GROUP BY day
      ORDER BY day
    `).all(catParams);

    // Build cumulative array for every day up to today
    let cumulative = 0;
    const spendByDay = {};
    dailyRows.forEach(r => spendByDay[r.day] = r.spent);
    for (let d = 1; d <= dayOfMonth; d++) {
      cumulative += (spendByDay[d] || 0);
      dailyCumulative.push({
        day: d,
        actual: Math.round(cumulative * 100) / 100,
        pace: Math.round((totalBudget / daysInMonth) * d * 100) / 100,
      });
    }
  }
  reopenDb.close();

  return { categories, scopedBudgets, totalBudget, totalSpent, daysInMonth, dayOfMonth, dailyCumulative };
}

module.exports = { getOverview, getTransactions, getSpending, getHoldings, getSubscriptions, getHealth, getBudgets };
