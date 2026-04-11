/** API response types */

export interface Balance {
  institution: string;
  account_id: string;
  account_name: string;
  account_type: string;
  balance: number;
  synced_at: string;
}

export interface StatementBalance {
  account_id: string;
  period_end: string;
  closing_balance: number;
}

export interface SyncStatus {
  institution: string;
  status: string;
  last_success: string;
}

export interface Transaction {
  institution: string;
  account_id: string;
  date: string;
  description: string;
  amount: number;
  category: string;
  user_category?: string;
}

export interface CategorySpending {
  category: string;
  total: number;
  count: number;
}

export interface MonthlySpending {
  month: string;
  total: number;
}

export interface Holding {
  account_id: string;
  symbol: string;
  name: string;
  quantity: number;
  price: number;
  market_value: number;
  cost_basis?: number;
  underlying?: string;
  instrument_type?: string;
  put_call?: string;
  strike?: number;
  expiry?: string;
  multiplier?: number;
  pct_allocation?: number;
}

export interface HoldingGroup {
  underlying: string;
  totalMarketValue: number;
  totalCostBasis: number;
  totalShares: number;
  optionCount: number;
  pct_allocation: number;
  positions: Holding[];
}

export interface HoldingAccount {
  account_id: string;
  account_name: string;
}

export interface Subscription {
  merchant: string;
  occurrences: number;
  avg_amount: number;
  last_charged: string;
  total: number;
}

export interface HealthMonth {
  month: string;
  assets: number;
  liabilities: number;
  net_worth: number;
  income?: number;
  spending?: number;
  savings_rate?: number;
}

export interface BudgetCategory {
  category: string;
  budget: number;
  baseBudget: number;
  rollover: boolean;
  rolloverAmount: number;
  spent: number;
  txn_count: number;
  description: string;
}

export interface BudgetScope {
  account_type?: string;
  accounts?: string[];
  institution?: string;
  categories?: string[];
  exclude_categories?: string[];
}

export interface ScopedBudget {
  label: string;
  budget: number;
  spent: number;
  txn_count: number;
  scope: BudgetScope;
  description: string;
}

export interface PaymentDue {
  account_id: string;
  account_name: string;
  balance: number;
  due_day?: number;
  days_until?: number;
}

// ─── Brief ───

export interface BriefHeadline {
  netWorth: number;
  delta: number;
  deltaPeriod: string;
  sparkline: number[];
  summary: string;
}

export interface BriefSection {
  type: 'goal_progress' | 'budget_pulse' | 'recent_activity' | 'upcoming' | 'concern' | 'portfolio' | 'account_health' | 'insight';
  title: string;
  body: string;
  progress?: number;
  account?: string;
  category?: string;
  spent?: number;
  budget?: number;
  pace?: string;
  transactions?: Transaction[];
  payments?: PaymentDue[];
}

export interface BriefData {
  exists: boolean;
  generatedAt?: string;
  greeting?: string;
  headline?: BriefHeadline;
  sections?: BriefSection[];
}

// ─── API responses ───

export interface OverviewData {
  balances: Balance[];
  statementBalances: Record<string, StatementBalance>;
  syncStatus: SyncStatus[];
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
  netWorthTrend: { month: string; net_worth: number }[];
  savingsRate: number | null;
  alerts: PaymentDue[];
  generatedAt: string;
}

export interface TransactionsData {
  transactions: Transaction[];
  summary: { count: number; inflow: number; outflow: number; net: number };
  accounts: string[];
  categories: string[];
}

export interface SpendingData {
  byCategory: CategorySpending[];
  monthlyTrend: MonthlySpending[];
  total: number;
}

export interface HoldingsData {
  holdings: Holding[];
  groups: HoldingGroup[];
  accounts: HoldingAccount[];
  totalValue: number;
}

export interface SubscriptionsData {
  subscriptions: Subscription[];
  monthlyTotal: number;
  annualTotal: number;
}

export interface HealthData {
  months: HealthMonth[];
}

export interface DailyCumulative {
  day: number;
  actual: number;
  pace: number;
}

export interface BudgetsData {
  categories: BudgetCategory[];
  scopedBudgets: ScopedBudget[];
  totalBudget: number;
  totalSpent: number;
  daysInMonth: number;
  dayOfMonth: number;
  dailyCumulative: DailyCumulative[];
}

// ─── Wiki ───

export interface WikiPageMeta {
  path: string;
  title: string;
  type: string;
  created: string;
  updated: string;
  status: string;
  tags: string[];
  summary: string;
  source_url?: string;
  source_type?: string;
}

export interface WikiIndexData {
  groups: { type: string; label: string; pages: WikiPageMeta[] }[];
  totalPages: number;
}

export interface WikiPageData {
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
}
