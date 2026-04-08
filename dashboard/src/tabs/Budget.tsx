import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { EmptyState } from '@/components/shared/EmptyState';
import type { BudgetsData } from '@/lib/types';

export function Budget() {
  const [data, setData] = useState<BudgetsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<BudgetsData>('/api/budgets')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;
  if (data.categories.length === 0) return <EmptyState message="No budget configured. Add categories to config/budgets.json" />;

  const pctUsed = data.totalBudget > 0 ? Math.round((data.totalSpent / data.totalBudget) * 100) : 0;
  const monthName = new Date().toLocaleString('en-US', { month: 'long' });

  return (
    <div className="animate-fade-in">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">
        <div className="flex justify-between mb-3">
          <p className="t-micro text-[var(--text-muted)]">{monthName} Budget</p>
          <span className="t-caption text-[var(--text-muted)]">{data.dayOfMonth} days in</span>
        </div>

        {data.categories.map(cat => {
          const pct = cat.budget > 0 ? Math.round((cat.spent / cat.budget) * 100) : 0;
          const remaining = cat.budget - cat.spent;
          const isOver = pct > 100;
          const isWarning = pct >= 60 && !isOver;
          const barColor = isOver ? 'var(--negative)' : isWarning ? 'var(--warning)' : 'var(--positive)';
          const pctOfMonth = data.daysInMonth > 0 ? Math.round((data.dayOfMonth / data.daysInMonth) * 100) : 0;

          return (
            <div key={cat.category} className="mb-4 last:mb-0">
              <div className="flex justify-between mb-1">
                <span className="t-body font-medium">{cat.category}</span>
                <span className="t-caption">
                  <span>${cat.spent.toLocaleString()}</span> / ${cat.budget.toLocaleString()}
                </span>
              </div>
              <div className="prog-track">
                <div className="prog-fill" style={{ width: `${Math.min(pct, 100)}%`, background: barColor }} />
              </div>
              <p className={`t-caption mt-0.5 ${isOver ? 'text-[var(--negative)]' : isWarning ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
                {isOver
                  ? `$${Math.abs(remaining).toLocaleString()} over budget`
                  : isWarning
                    ? `$${remaining.toLocaleString()} left \u2014 ${pct}% used in ${data.dayOfMonth} days`
                    : `$${remaining.toLocaleString()} remaining`
                }
                {isWarning && pct > pctOfMonth && ' (pace: over)'}
              </p>
            </div>
          );
        })}
      </div>

      {/* Total budget gauge */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
        <div className="flex justify-between items-center">
          <span className="t-body font-medium">
            ${data.totalSpent.toLocaleString()} of ${data.totalBudget.toLocaleString()}
          </span>
          <span className={`t-value ${pctUsed > 100 ? 'text-[var(--negative)]' : 'text-[var(--positive)]'}`}>
            {pctUsed}%
          </span>
        </div>
        <div className="prog-track mt-2" style={{ height: 8 }}>
          <div
            className="prog-fill"
            style={{
              width: `${Math.min(pctUsed, 100)}%`,
              background: pctUsed > 100 ? 'var(--negative)' : 'var(--positive)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
