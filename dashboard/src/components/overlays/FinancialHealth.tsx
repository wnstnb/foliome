import { useEffect, useState, useCallback } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtShort, fmtDelta, fmtPercent, fmtMonth } from '@/lib/format';
import { showBackButton, hideBackButton } from '@/lib/telegram';
import { EmptyState } from '@/components/shared/EmptyState';
import { ArrowLeft } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { HealthData, HealthMonth } from '@/lib/types';

type MetricKey = 'net_worth' | 'assets' | 'liabilities' | 'savings';

const METRIC_CONFIG: Record<MetricKey, { label: string; color: string; getValue: (m: HealthMonth) => number | null; format: (v: number) => string; yAxisId: string }> = {
  net_worth: { label: 'Net Worth', color: '#0D9488', getValue: m => m.net_worth, format: v => fmtShort(v), yAxisId: 'dollars' },
  assets: { label: 'Assets', color: '#34D399', getValue: m => m.assets, format: v => fmtShort(v), yAxisId: 'dollars' },
  liabilities: { label: 'Liabilities', color: '#F87171', getValue: m => m.liabilities, format: v => fmtShort(v), yAxisId: 'dollars' },
  savings: { label: 'Savings Rate', color: '#3B82F6', getValue: m => m.savings_rate ?? null, format: v => fmtPercent(v), yAxisId: 'pct' },
};

const EXPLAINERS: Record<MetricKey, { title: string; body: string }> = {
  net_worth: { title: 'How Net Worth is Calculated', body: 'Sum of all account balances (latest snapshot per account). Assets are positive balances, liabilities are negative. Net worth = assets + liabilities.' },
  assets: { title: 'How Assets are Calculated', body: 'Sum of all accounts with positive balances: checking, savings, brokerage, retirement, education, and real estate estimated values.' },
  liabilities: { title: 'How Liabilities are Calculated', body: 'Sum of all accounts with negative balances: credit cards and mortgage principal remaining.' },
  savings: { title: 'How Savings Rate is Calculated', body: 'Monthly savings rate = (income - spending) / income. Income is all transactions categorized as Income. Spending excludes transfers.' },
};

interface FinancialHealthProps {
  initialMetric?: MetricKey;
  onClose: () => void;
}

export function FinancialHealth({ initialMetric = 'net_worth', onClose }: FinancialHealthProps) {
  const [data, setData] = useState<HealthData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeMetrics, setActiveMetrics] = useState<Set<MetricKey>>(new Set([initialMetric]));

  // Telegram back button
  const handleBack = useCallback(() => { onClose(); }, [onClose]);
  useEffect(() => {
    showBackButton(handleBack);
    return () => hideBackButton(handleBack);
  }, [handleBack]);

  useEffect(() => {
    fetchWithAuth<HealthData>('/api/health')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  const toggleMetric = (metric: MetricKey) => {
    setActiveMetrics(prev => {
      const next = new Set(prev);
      if (next.has(metric)) {
        if (next.size > 1) next.delete(metric); // keep at least one
      } else {
        next.add(metric);
      }
      return next;
    });
  };

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;

  const chartData = data.months.map(m => ({
    month: fmtMonth(m.month),
    net_worth: m.net_worth,
    assets: m.assets,
    liabilities: m.liabilities,
    savings: m.savings_rate,
  }));

  const hasDollarMetric = activeMetrics.has('net_worth') || activeMetrics.has('assets') || activeMetrics.has('liabilities');
  const hasPctMetric = activeMetrics.has('savings');
  const primaryExplainer = [...activeMetrics][0];

  return (
    <div className="fixed inset-0 bg-[var(--bg)] z-50 overflow-y-auto animate-slide-up">
      <div className="max-w-[430px] mx-auto px-4 pt-4 pb-20">
        {/* Header */}
        <div className="flex items-center gap-3 mb-5">
          <button onClick={onClose} className="p-1 -ml-1 text-[var(--text)]">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <span className="t-value text-base">Financial Health</span>
        </div>

        {/* Metric toggles */}
        <div className="flex gap-1.5 mb-4 flex-wrap">
          {(Object.keys(METRIC_CONFIG) as MetricKey[]).map(key => {
            const isActive = activeMetrics.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleMetric(key)}
                className="py-1 px-3 rounded-full text-[11px] font-semibold border cursor-pointer transition-all duration-150"
                style={{
                  borderColor: isActive ? 'var(--brand)' : 'var(--border)',
                  background: isActive ? 'var(--brand)' : 'transparent',
                  color: isActive ? 'white' : 'var(--text-muted)',
                }}
              >
                {METRIC_CONFIG[key].label}
              </button>
            );
          })}
        </div>

        {/* Trend chart */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-4">
          <div className="h-[220px]">
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                <XAxis dataKey="month" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} />
                {hasDollarMetric && (
                  <YAxis
                    yAxisId="dollars"
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => fmtShort(v)}
                    width={50}
                  />
                )}
                {hasPctMetric && (
                  <YAxis
                    yAxisId="pct"
                    orientation="right"
                    tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={v => `${v}%`}
                    width={40}
                  />
                )}
                <Tooltip
                  contentStyle={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                />
                {(Object.keys(METRIC_CONFIG) as MetricKey[]).filter(k => activeMetrics.has(k)).map(key => (
                  <Line
                    key={key}
                    type="monotone"
                    dataKey={key}
                    yAxisId={METRIC_CONFIG[key].yAxisId}
                    stroke={METRIC_CONFIG[key].color}
                    strokeWidth={2}
                    dot={{ r: 3, fill: METRIC_CONFIG[key].color }}
                    activeDot={{ r: 5 }}
                    name={METRIC_CONFIG[key].label}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Monthly breakdown table */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-4">
          <p className="t-micro text-[var(--text-muted)] mb-2.5">Monthly Breakdown</p>
          <div className="grid grid-cols-4 gap-1 pb-2 border-b border-[var(--border)] mb-1.5">
            <span className="t-micro text-[var(--text-muted)]">Month</span>
            <span className="t-micro text-[var(--text-muted)] text-right">Net Worth</span>
            <span className="t-micro text-[var(--text-muted)] text-right">Change</span>
            <span className="t-micro text-[var(--text-muted)] text-right">Savings</span>
          </div>
          {[...data.months].reverse().slice(0, 12).map((m, i, arr) => {
            const prev = i < arr.length - 1 ? arr[i + 1] : null;
            const change = prev ? m.net_worth - prev.net_worth : 0;
            return (
              <div key={m.month} className="grid grid-cols-4 gap-1 py-2 border-b border-[var(--border)]/30 last:border-b-0 items-center">
                <span className="t-caption">{fmtMonth(m.month)}</span>
                <span className="t-value text-right text-[13px]">{fmtShort(m.net_worth)}</span>
                <span className={`t-caption text-right ${change >= 0 ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
                  {prev ? fmtDelta(change) : '--'}
                </span>
                <span className="t-caption text-right">
                  {m.savings_rate != null ? fmtPercent(m.savings_rate) : '--'}
                </span>
              </div>
            );
          })}
        </div>

        {/* Explainer card */}
        {primaryExplainer && (
          <div className="rounded-xl border border-[var(--brand)]/20 bg-[var(--bg-card)] p-3">
            <p className="t-micro text-[var(--brand)] mb-1">
              {EXPLAINERS[primaryExplainer].title}
            </p>
            <p className="t-caption text-[var(--text-muted)]">
              {EXPLAINERS[primaryExplainer].body}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
