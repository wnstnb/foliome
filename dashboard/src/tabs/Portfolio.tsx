import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtFull, fmtShort } from '@/lib/format';
import { CHART_PALETTE } from '@/lib/constants';
import { EmptyState } from '@/components/shared/EmptyState';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend } from 'recharts';
import type { HoldingsData } from '@/lib/types';

export function Portfolio() {
  const [data, setData] = useState<HoldingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<HoldingsData>('/api/holdings')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;
  if (data.holdings.length === 0) return <EmptyState message="No holdings data available" />;

  const chartData = data.holdings.slice(0, 10).map(h => ({
    name: h.symbol || 'Other',
    value: h.market_value,
  }));

  return (
    <div className="animate-fade-in">
      {/* Allocation donut */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">
        <p className="t-micro text-[var(--text-muted)] mb-2">Allocation — {fmtShort(data.totalValue)}</p>
        <div className="h-[200px] md:h-[300px]">
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={chartData}
                innerRadius="65%"
                outerRadius="90%"
                paddingAngle={2}
                dataKey="value"
                stroke="none"
              >
                {chartData.map((_entry, i) => (
                  <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                ))}
              </Pie>
              <Legend
                layout="vertical"
                align="right"
                verticalAlign="middle"
                iconType="circle"
                iconSize={8}
                formatter={(value: string) => <span style={{ color: 'var(--text)', fontSize: 11 }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top positions */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
        <p className="t-micro text-[var(--text-muted)] mb-2.5">Top Positions</p>
        {data.holdings.map(h => (
          <div key={`${h.account_id}-${h.symbol}`} className="flex items-center justify-between py-3 border-b border-[var(--border)]/50 last:border-b-0">
            <div className="flex items-center gap-2">
              <span className="t-value text-[var(--brand)] w-12">{h.symbol || '--'}</span>
              <span className="t-caption text-[var(--text-muted)]">{h.name || ''}</span>
            </div>
            <div className="text-right">
              <p className="t-value">{fmtFull(h.market_value)}</p>
              <p className="t-caption text-[var(--text-muted)]">{h.quantity?.toLocaleString()} shares</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
