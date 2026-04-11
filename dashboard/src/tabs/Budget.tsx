import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { fetchWithAuth } from '@/lib/api';
import { EmptyState } from '@/components/shared/EmptyState';
import type { BudgetsData, BudgetCategory, ScopedBudget, DailyCumulative } from '@/lib/types';

function InfoIcon({ description }: { description: string }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex ml-1.5 align-middle">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="w-4 h-4 rounded-full border border-[var(--text-muted)] text-[var(--text-muted)] flex items-center justify-center text-[10px] leading-none hover:border-[var(--text-primary)] hover:text-[var(--text-primary)] transition-colors"
        aria-label="Budget details"
      >
        i
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-6 z-20 w-56 rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-2.5 shadow-lg">
            <p className="t-caption text-[var(--text-muted)] whitespace-pre-wrap">{description.split(' · ').join('\n')}</p>
          </div>
        </>
      )}
    </span>
  );
}

function PacingChart({ data, totalBudget, daysInMonth, dayOfMonth }: {
  data: DailyCumulative[];
  totalBudget: number;
  daysInMonth: number;
  dayOfMonth: number;
}) {
  // Extend pace line to end of month
  const chartData: DailyCumulative[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const existing = data.find(p => p.day === d);
    chartData.push({
      day: d,
      actual: d <= dayOfMonth ? (existing?.actual ?? (d > 1 ? chartData[d - 2]?.actual ?? 0 : 0)) : undefined as unknown as number,
      pace: Math.round((totalBudget / daysInMonth) * d * 100) / 100,
    });
  }

  // Fill in gaps for actual (carry forward last known value)
  for (let i = 1; i < chartData.length && chartData[i].day <= dayOfMonth; i++) {
    if (chartData[i].actual === undefined || chartData[i].actual === null) {
      chartData[i].actual = chartData[i - 1].actual;
    }
  }

  const lastActual = data.length > 0 ? data[data.length - 1].actual : 0;
  const lastPace = data.length > 0 ? data[data.length - 1].pace : 0;
  const underPace = lastActual <= lastPace;
  const pctUsed = totalBudget > 0 ? Math.round((lastActual / totalBudget) * 100) : 0;

  const monthName = new Date().toLocaleString('en-US', { month: 'long' });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">
      <div className="flex justify-between items-start mb-1">
        <div>
          <p className="t-micro text-[var(--text-muted)]">{monthName} Budget</p>
          <p className="t-value text-lg">
            ${lastActual.toLocaleString()}
            <span className="t-caption text-[var(--text-muted)]"> of ${totalBudget.toLocaleString()}</span>
          </p>
        </div>
        <div className="text-right">
          <span className={`t-value text-lg ${underPace ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
            {pctUsed}%
          </span>
          <p className="t-caption text-[var(--text-muted)]">{dayOfMonth} of {daysInMonth} days</p>
        </div>
      </div>
      <div style={{ height: 140 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <defs>
              <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={underPace ? 'var(--positive)' : 'var(--negative)'} stopOpacity={0.3} />
                <stop offset="95%" stopColor={underPace ? 'var(--positive)' : 'var(--negative)'} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="day"
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              axisLine={false}
              tickLine={false}
              interval={Math.floor(daysInMonth / 5) - 1}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={v => `$${(v / 1000).toFixed(v >= 1000 ? 1 : 0)}${v >= 1000 ? 'K' : ''}`}
              domain={[0, (max: number) => Math.max(max, totalBudget) * 1.05]}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(val, name) => [`$${Number(val).toLocaleString()}`, name === 'actual' ? 'Spent' : 'Pace']}
              labelFormatter={day => `Day ${day}`}
            />
            <ReferenceLine
              x={dayOfMonth}
              stroke="var(--text-muted)"
              strokeDasharray="3 3"
              strokeOpacity={0.4}
            />
            {/* Budget pace line — full month */}
            <Area
              type="linear"
              dataKey="pace"
              stroke="var(--text-muted)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              fill="none"
              dot={false}
              activeDot={false}
            />
            {/* Actual cumulative spend — up to today */}
            <Area
              type="monotone"
              dataKey="actual"
              stroke={underPace ? 'var(--positive)' : 'var(--negative)'}
              strokeWidth={2}
              fill="url(#actualGrad)"
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-center gap-4 mt-1">
        <span className="t-caption text-[var(--text-muted)] flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 rounded" style={{ background: underPace ? 'var(--positive)' : 'var(--negative)' }} /> Spent
        </span>
        <span className="t-caption text-[var(--text-muted)] flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 rounded border-t border-dashed border-[var(--text-muted)]" /> Pace
        </span>
      </div>
    </div>
  );
}

function BudgetBar({ label, spent, budget, subtitle, description }: { label: string; spent: number; budget: number; subtitle?: string; description?: string }) {
  const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const remaining = budget - spent;
  const isOver = pct > 100;
  const isWarning = pct >= 60 && !isOver;
  const barColor = isOver ? 'var(--negative)' : isWarning ? 'var(--warning)' : 'var(--positive)';

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex justify-between mb-1">
        <span className="t-body font-medium">
          {label}
          {description && <InfoIcon description={description} />}
        </span>
        <span className="t-caption">
          <span>${spent.toLocaleString()}</span> / ${budget.toLocaleString()}
        </span>
      </div>
      <div className="prog-track">
        <div className="prog-fill" style={{ width: `${Math.min(pct, 100)}%`, background: barColor }} />
      </div>
      <p className={`t-caption mt-0.5 ${isOver ? 'text-[var(--negative)]' : isWarning ? 'text-[var(--warning)]' : 'text-[var(--text-muted)]'}`}>
        {isOver
          ? `$${Math.abs(remaining).toLocaleString()} over budget`
          : `$${remaining.toLocaleString()} remaining`
        }
        {subtitle && ` \u2014 ${subtitle}`}
      </p>
    </div>
  );
}

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
  if (data.categories.length === 0 && (!data.scopedBudgets || data.scopedBudgets.length === 0)) {
    return <EmptyState message="No budget configured. Add categories to config/budgets.json" />;
  }

  const allBudgets = [
    ...data.categories.map((cat: BudgetCategory) => ({
      key: cat.category,
      label: cat.category,
      spent: cat.spent,
      budget: cat.budget,
      description: cat.description,
      subtitle: cat.rollover && cat.rolloverAmount !== 0
        ? cat.rolloverAmount > 0
          ? `+$${cat.rolloverAmount.toLocaleString()} rollover`
          : `-$${Math.abs(cat.rolloverAmount).toLocaleString()} carried over`
        : undefined,
    })),
    ...((data.scopedBudgets || []).map((sb: ScopedBudget) => ({
      key: sb.label,
      label: sb.label,
      spent: sb.spent,
      budget: sb.budget,
      description: sb.description,
      subtitle: undefined,
    }))),
  ];

  return (
    <div className="animate-fade-in">
      {/* Pacing chart — cumulative spend vs budget pace */}
      {data.dailyCumulative && data.dailyCumulative.length > 0 && (
        <PacingChart
          data={data.dailyCumulative}
          totalBudget={data.totalBudget}
          daysInMonth={data.daysInMonth}
          dayOfMonth={data.dayOfMonth}
        />
      )}

      {/* All budgets in one card */}
      {allBudgets.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
          {allBudgets.map(b => (
            <BudgetBar
              key={b.key}
              label={b.label}
              spent={b.spent}
              budget={b.budget}
              subtitle={b.subtitle}
              description={b.description}
            />
          ))}
        </div>
      )}
    </div>
  );
}
