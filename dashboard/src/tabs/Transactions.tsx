import { useEffect, useState, useRef, useCallback } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtShort, fmtDate, fmtAccounting } from '@/lib/format';
import { CATEGORY_COLORS, CHART_PALETTE, DATE_PRESETS, resolveDatePreset } from '@/lib/constants';
import type { DatePreset } from '@/lib/constants';
import { TransactionRow } from '@/components/shared/TransactionRow';
import { EmptyState } from '@/components/shared/EmptyState';
import { haptic } from '@/lib/telegram';
import { Search, ChevronRight, ChevronDown, CalendarDays } from 'lucide-react';
import { PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip } from 'recharts';
import type { TransactionsData, SpendingData } from '@/lib/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';

function MultiSelect({ label, options, selected, onChange }: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const toggle = (item: string) => {
    haptic();
    onChange(selected.includes(item) ? selected.filter(s => s !== item) : [...selected, item]);
  };

  const filtered = query
    ? options.filter(o => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  const display = selected.length === 0 ? label
    : selected.length === 1 ? selected[0]
    : `${selected.length} ${label.replace('All ', '')}`;

  return (
    <Popover onOpenChange={(open) => { if (!open) setQuery(''); }}>
      <PopoverTrigger
        className={`flex items-center gap-1 rounded-xl border px-3 py-2 text-xs font-medium cursor-pointer whitespace-nowrap ${
          selected.length > 0
            ? 'bg-[var(--brand)]/10 border-[var(--brand)]/30 text-[var(--brand)]'
            : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text)]'
        }`}
      >
        <span className="truncate max-w-[100px]">{display}</span>
        <ChevronDown className="w-3 h-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-0">
        {/* Search input */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-[var(--border)]">
          <Search className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder={`Search ${label.replace('All ', '').toLowerCase()}...`}
            className="flex-1 bg-transparent text-xs text-[var(--text)] placeholder:text-[var(--text-muted)] outline-none"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        {/* Options list */}
        <div className="max-h-52 overflow-y-auto p-1">
          {selected.length > 0 && !query && (
            <button
              className="w-full text-left px-2.5 py-1.5 text-xs text-[var(--brand)] rounded-md hover:bg-[var(--bg-hover)] transition-colors"
              onClick={() => { haptic(); onChange([]); }}
            >
              Clear filter
            </button>
          )}
          {filtered.map(opt => (
            <label
              key={opt}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-[var(--bg-hover)] transition-colors"
            >
              <Checkbox
                checked={selected.includes(opt)}
                onCheckedChange={() => toggle(opt)}
              />
              <span className="text-xs text-[var(--text)] truncate">{opt}</span>
            </label>
          ))}
          {filtered.length === 0 && (
            <p className="px-2.5 py-3 text-xs text-[var(--text-muted)] text-center">No matches</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface TransactionsProps {
  initialAccount?: string;
  initialCategory?: string;
  initialSubTab?: 'spending' | 'activity';
}

export function Transactions({ initialAccount, initialCategory, initialSubTab }: TransactionsProps) {
  const [subTab, setSubTab] = useState<'spending' | 'activity'>(initialSubTab ?? 'spending');
  const [datePreset, setDatePreset] = useState<DatePreset>(initialSubTab === 'activity' ? 'this-month' : '30d');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>(initialAccount ? [initialAccount] : []);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(initialCategory ? [initialCategory] : []);

  const [txnData, setTxnData] = useState<TransactionsData | null>(null);
  const [spendData, setSpendData] = useState<SpendingData | null>(null);
  const scrollRef = useRef(0);

  // Fetch transactions
  const fetchTxns = useCallback(async () => {
    const { from, to } = resolveDatePreset(datePreset);
    const params: Record<string, string> = { from, to };
    if (selectedAccounts.length) params.accounts = selectedAccounts.join(',');
    if (selectedCategories.length) params.categories = selectedCategories.join(',');
    if (searchQuery) params.q = searchQuery;

    try {
      const data = await fetchWithAuth<TransactionsData>('/api/transactions', params);
      setTxnData(data);
    } catch {}
  }, [datePreset, selectedAccounts, selectedCategories, searchQuery]);

  // Fetch spending
  const fetchSpending = useCallback(async () => {
    const { from, to } = resolveDatePreset(datePreset);
    const params: Record<string, string> = { from, to };
    if (selectedAccounts.length) params.accounts = selectedAccounts.join(',');

    try {
      const data = await fetchWithAuth<SpendingData>('/api/spending', params);
      setSpendData(data);
    } catch {}
  }, [datePreset, selectedAccounts]);

  useEffect(() => {
    fetchTxns();
    fetchSpending();
  }, [fetchTxns, fetchSpending]);

  // Sub-tab switch with scroll preservation
  const switchSubTab = (tab: 'spending' | 'activity') => {
    if (tab === subTab) return;
    haptic();
    scrollRef.current = window.scrollY;
    setSubTab(tab);
    requestAnimationFrame(() => window.scrollTo(0, scrollRef.current));
  };

  // Group transactions by date
  const groupedTxns: Record<string, TransactionsData['transactions']> = {};
  if (txnData) {
    for (const txn of txnData.transactions) {
      if (!groupedTxns[txn.date]) groupedTxns[txn.date] = [];
      groupedTxns[txn.date].push(txn);
    }
  }

  return (
    <div className="animate-fade-in">
      {/* Search */}
      <div className="relative mb-3">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-muted)]" />
        <input
          type="text"
          placeholder="Search transactions..."
          className="w-full rounded-xl bg-[var(--bg-card)] border border-[var(--border)] py-2.5 pl-9 pr-3 text-sm outline-none text-[var(--text)] placeholder:text-[var(--text-muted)]"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <Popover>
          <PopoverTrigger className="flex items-center gap-1 rounded-xl bg-[var(--bg-card)] border border-[var(--border)] px-3 py-2 text-xs font-medium text-[var(--text)] cursor-pointer whitespace-nowrap">
            <CalendarDays className="w-3 h-3 shrink-0 text-[var(--text-muted)]" />
            <span>{DATE_PRESETS.find(p => p.value === datePreset)?.label ?? 'Date'}</span>
            <ChevronDown className="w-3 h-3 shrink-0" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 p-1">
            {DATE_PRESETS.map(p => (
              <button
                key={p.value}
                className={`w-full text-left px-2.5 py-1.5 text-xs rounded-md cursor-pointer transition-colors ${
                  datePreset === p.value
                    ? 'bg-[var(--brand)]/10 text-[var(--brand)] font-medium'
                    : 'text-[var(--text)] hover:bg-[var(--bg-hover)]'
                }`}
                onClick={() => { haptic(); setDatePreset(p.value); }}
              >
                {p.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>

        <MultiSelect
          label="All accounts"
          options={txnData?.accounts ?? []}
          selected={selectedAccounts}
          onChange={setSelectedAccounts}
        />

        <MultiSelect
          label="All categories"
          options={txnData?.categories ?? []}
          selected={selectedCategories}
          onChange={setSelectedCategories}
        />
      </div>

      {/* Sub-tabs (segmented control) */}
      <div className="flex gap-1 p-[3px] bg-[var(--bg-card)] border border-[var(--border)] rounded-[10px] mb-4">
        <button
          className={`flex-1 py-1.5 text-xs font-medium rounded-[7px] transition-all duration-150 ${subTab === 'spending' ? 'bg-[var(--brand)] text-white shadow-sm' : 'text-[var(--text-muted)]'}`}
          onClick={() => switchSubTab('spending')}
        >
          Spending
        </button>
        <button
          className={`flex-1 py-1.5 text-xs font-medium rounded-[7px] transition-all duration-150 ${subTab === 'activity' ? 'bg-[var(--brand)] text-white shadow-sm' : 'text-[var(--text-muted)]'}`}
          onClick={() => switchSubTab('activity')}
        >
          Activity
        </button>
      </div>

      {/* Spending sub-tab */}
      {subTab === 'spending' && spendData && (
        <div className={subTab === 'spending' ? 'animate-slide-right' : 'animate-slide-left'}>
          <div className="md:grid md:grid-cols-2 md:gap-3">
          {/* Donut chart */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3 md:mb-0">
            <div className="relative h-[200px] md:h-[280px]">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={spendData.byCategory.map(c => ({ name: c.category, value: Math.abs(c.total) }))}
                    innerRadius="75%"
                    outerRadius="95%"
                    paddingAngle={2}
                    dataKey="value"
                    stroke="none"
                  >
                    {spendData.byCategory.map((c, i) => (
                      <Cell key={c.category} fill={CATEGORY_COLORS[c.category] ?? CHART_PALETTE[i % CHART_PALETTE.length]} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-center pointer-events-none">
                <p className="t-micro text-[var(--text-muted)]">Total</p>
                <p className="t-value text-lg">{fmtShort(Math.abs(spendData.total))}</p>
              </div>
            </div>
          </div>

          {/* Category breakdown */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3 md:mb-0">
            <p className="t-micro text-[var(--text-muted)] mb-2.5">By Category</p>
            {spendData.byCategory.map(c => {
              const pct = spendData.total !== 0 ? Math.round((c.total / spendData.total) * 100) : 0;
              return (
                <div
                  key={c.category}
                  className="flex items-center gap-2 py-2 px-1 -mx-1 border-b border-[var(--border)]/50 last:border-b-0 rounded-md cursor-pointer active:bg-[var(--bg-hover)] transition-colors"
                  onClick={() => { haptic(); setSelectedCategories([c.category]); switchSubTab('activity'); }}
                >
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: CATEGORY_COLORS[c.category] ?? '#6B7280' }} />
                  <span className="t-body flex-1">{c.category}</span>
                  <span className="t-caption text-[var(--text-muted)]">{pct}%</span>
                  <span className="t-value min-w-[70px] text-right">{fmtAccounting(c.total)}</span>
                  <ChevronRight className="w-3 h-3 text-[var(--text-muted)] shrink-0 ml-1" />
                </div>
              );
            })}
          </div>
          </div>

          {/* Monthly trend */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            <p className="t-micro text-[var(--text-muted)] mb-2.5">Monthly Trend</p>
            <div className="h-[200px]">
              <ResponsiveContainer>
                <AreaChart data={spendData.monthlyTrend.map(m => ({
                  month: m.month.slice(5),
                  value: Math.abs(m.total),
                }))}>
                  <defs>
                    <linearGradient id="spendGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#0D9488" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#0D9488" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v / 1000).toFixed(0)}K`} width={45} />
                  <Tooltip
                    contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                    formatter={(v) => [`$${Number(v).toLocaleString()}`, 'Spending']}
                  />
                  <Area type="monotone" dataKey="value" stroke="#0D9488" strokeWidth={2} fill="url(#spendGrad)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Activity sub-tab */}
      {subTab === 'activity' && txnData && (
        <div className={subTab === 'activity' ? 'animate-slide-left' : 'animate-slide-right'}>
          {/* Summary bar */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 flex justify-between mb-3">
            <div className="flex gap-4">
              <div>
                <p className="t-micro text-[var(--text-muted)]">Txns</p>
                <p className="t-value">{txnData.summary.count}</p>
              </div>
              <div>
                <p className="t-micro text-[var(--text-muted)]">In</p>
                <p className="t-value text-[var(--positive)]">{fmtShort(txnData.summary.inflow)}</p>
              </div>
              <div>
                <p className="t-micro text-[var(--text-muted)]">Out</p>
                <p className="t-value text-[var(--negative)]">{fmtAccounting(txnData.summary.outflow)}</p>
              </div>
            </div>
            <div className="text-right">
              <p className="t-micro text-[var(--text-muted)]">Net</p>
              <p className={`t-value ${txnData.summary.net >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
                {txnData.summary.net >= 0 ? `+${fmtShort(txnData.summary.net)}` : fmtAccounting(txnData.summary.net)}
              </p>
            </div>
          </div>

          {/* Transaction list grouped by date */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
            {Object.keys(groupedTxns).length === 0 ? (
              <EmptyState message="No transactions found" />
            ) : (
              Object.entries(groupedTxns).map(([date, txns]) => (
                <div key={date}>
                  <p className="t-micro text-[var(--text-muted)] mb-2 mt-3 first:mt-0">{fmtDate(date)}</p>
                  {txns.map((txn, i) => (
                    <TransactionRow key={`${txn.date}-${txn.description}-${i}`} txn={txn} />
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
