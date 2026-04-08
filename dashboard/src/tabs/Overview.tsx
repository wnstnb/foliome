import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtShort, fmtDelta, fmtPercent, staleness, fmtAge } from '@/lib/format';
import { ACCOUNT_TYPE_LABELS, ACCOUNT_TYPE_COLORS, LIABILITY_TYPES } from '@/lib/constants';
import { KPICard } from '@/components/shared/KPICard';
import { AccountRow } from '@/components/shared/AccountRow';
import { Sparkline } from '@/components/shared/Sparkline';
import { EmptyState } from '@/components/shared/EmptyState';
import type { OverviewData } from '@/lib/types';

interface OverviewProps {
  onAccountClick: (accountId: string) => void;
  onKPIClick: (metric: string) => void;
}

export function Overview({ onAccountClick, onKPIClick }: OverviewProps) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<OverviewData>('/api/overview')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;

  // Group balances by type
  const grouped: Record<string, typeof data.balances> = {};
  for (const b of data.balances) {
    if (!grouped[b.account_type]) grouped[b.account_type] = [];
    grouped[b.account_type].push(b);
  }

  // Net worth trend for sparkline
  const trendValues = data.netWorthTrend.map(t => t.net_worth);
  const lastTwo = trendValues.slice(-2);
  const monthDelta = lastTwo.length === 2 ? lastTwo[1] - lastTwo[0] : 0;

  // Group subtotals
  const groupTotal = (accounts: typeof data.balances) =>
    accounts.reduce((s, a) => s + a.balance, 0);

  // Order: checking, savings, credit, brokerage, retirement, education, real_estate, mortgage
  const typeOrder = ['checking', 'savings', 'credit', 'brokerage', 'retirement', 'education', 'real_estate', 'mortgage'];
  const sortedTypes = Object.keys(grouped).sort((a, b) => {
    const ai = typeOrder.indexOf(a);
    const bi = typeOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Find stale institutions (>48h)
  const staleInstitutions = new Map<string, number>();
  for (const b of data.balances) {
    const age = staleness(b.synced_at);
    if (age.level === 'old') {
      const existing = staleInstitutions.get(b.institution);
      if (!existing || age.hours > existing) staleInstitutions.set(b.institution, age.hours);
    }
  }

  return (
    <div className="animate-fade-in">
      {/* Stale data warning */}
      {staleInstitutions.size > 0 && (
        <div className="rounded-xl border border-[var(--negative)]/30 bg-[var(--negative)]/5 p-3 mb-3">
          <p className="t-caption text-[var(--negative)] font-medium mb-0.5">Stale data</p>
          {[...staleInstitutions.entries()].map(([inst, hours]) => (
            <p key={inst} className="t-caption text-[var(--text-muted)]">
              {inst} — last synced {Math.round(hours / 24)}d ago
            </p>
          ))}
        </div>
      )}

      {/* Hero net worth */}
      <KPICard
        variant="hero"
        label="Net Worth"
        value={fmtShort(data.netWorth)}
        sparkline={<Sparkline data={trendValues} />}
        subtitle={monthDelta !== 0 ? `${fmtDelta(monthDelta)} this month` : undefined}
        subtitleClass={monthDelta >= 0 ? 'bg-[var(--brand)]/10 text-[var(--positive)]' : 'bg-[var(--negative)]/10 text-[var(--negative)]'}
        onClick={() => onKPIClick('net_worth')}
      />

      {/* Secondary KPIs */}
      <div className="grid grid-cols-3 gap-2 my-3">
        <KPICard
          label="Assets"
          value={fmtShort(data.totalAssets)}
          valueClass="text-[var(--positive)]"
          onClick={() => onKPIClick('assets')}
        />
        <KPICard
          label="Liabilities"
          value={fmtShort(data.totalLiabilities)}
          onClick={() => onKPIClick('liabilities')}
        />
        <KPICard
          label="Savings"
          value={data.savingsRate !== null ? fmtPercent(data.savingsRate) : '--'}
          valueClass={data.savingsRate !== null && data.savingsRate > 0 ? 'text-[var(--positive)]' : undefined}
          onClick={() => onKPIClick('savings')}
        />
      </div>

      {/* Alerts */}
      {data.alerts.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--warning)]" />
            <span className="t-caption">
              {data.alerts[0].account_name} due {(data.alerts[0].days_until ?? 0) <= 1 ? 'today' : `in ${data.alerts[0].days_until}d`}
            </span>
          </div>
          <span className="t-value text-[var(--warning)]">{fmtShort(Math.abs(data.alerts[0].balance))}</span>
        </div>
      )}

      {/* Account groups */}
      <div className="md:grid md:grid-cols-2 md:gap-3">
        {sortedTypes.map(type => {
          const accounts = grouped[type];
          const total = groupTotal(accounts);
          const isLiability = LIABILITY_TYPES.has(type);

          return (
            <div key={type} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3 md:mb-0">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: ACCOUNT_TYPE_COLORS[type] ?? 'var(--text-muted)' }} />
                  <span className="t-micro text-[var(--text-muted)]">{ACCOUNT_TYPE_LABELS[type] ?? type}</span>
                </div>
                <span className={`t-caption ${isLiability ? '' : 'text-[var(--positive)]'}`}>
                  {fmtShort(total)}
                </span>
              </div>
              {accounts.map(b => (
                <AccountRow
                  key={b.account_id}
                  balance={b}
                  statementBalance={data.statementBalances[b.account_id]}
                  onClick={() => onAccountClick(b.account_id)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
