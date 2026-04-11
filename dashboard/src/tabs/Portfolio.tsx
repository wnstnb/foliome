import { useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtFull, fmtShort, fmtDelta } from '@/lib/format';
import { CHART_PALETTE } from '@/lib/constants';
import { EmptyState } from '@/components/shared/EmptyState';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend } from 'recharts';
import type { HoldingsData, HoldingGroup, Holding } from '@/lib/types';

/** Format option as: 2x Jan '27 $105 Call */
function fmtOption(h: Holding): string {
  const qty = Math.abs(h.quantity);
  const qtyStr = qty !== 1 ? `${qty}\u00D7 ` : '';
  if (!h.expiry || !h.strike || !h.put_call) return `${qtyStr}${h.symbol}`;

  const d = new Date(h.expiry + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const mon = months[d.getMonth()];
  const yr = String(d.getFullYear()).slice(2);
  const pc = h.put_call === 'call' ? 'Call' : 'Put';
  return `${qtyStr}${mon} '${yr} $${h.strike} ${pc}`;
}

/** Short account label: "...1314" from "schwab-23211314" */
function shortAccount(id: string): string {
  const last4 = id.replace(/\D/g, '').slice(-4);
  return last4 ? `\u2026${last4}` : id;
}

function GainLoss({ value, className }: { value: number; className?: string }) {
  const color = value >= 0 ? 'var(--positive)' : 'var(--negative)';
  return <span className={className} style={{ color }}>{fmtDelta(value)}</span>;
}

function GroupRow({ group, showAccountBreakdown }: { group: HoldingGroup; showAccountBreakdown: boolean }) {
  const [open, setOpen] = useState(false);
  const hasOptions = group.optionCount > 0;
  const isMulti = group.positions.length > 1;
  const expandable = isMulti;
  const gainLoss = group.totalMarketValue - group.totalCostBasis;

  // Summary line for shares + options
  const sharesLabel = group.totalShares
    ? `${Number(group.totalShares.toFixed(4)).toLocaleString()} shares`
    : '';
  const optLabel = hasOptions ? `${group.optionCount} option${group.optionCount > 1 ? 's' : ''}` : '';
  const summaryParts = [sharesLabel, optLabel].filter(Boolean);

  return (
    <div className="border-b border-[var(--border)]/40 last:border-b-0">
      {/* Group header */}
      <button
        className="w-full flex items-center justify-between py-2 px-1 text-left"
        onClick={() => expandable && setOpen(!open)}
        style={{ cursor: expandable ? 'pointer' : 'default' }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {expandable && (
            <span className="text-[10px] text-[var(--text-muted)] w-3 shrink-0">{open ? '\u25BC' : '\u25B6'}</span>
          )}
          <span className="text-[13px] font-semibold text-[var(--brand)]">{group.underlying}</span>
          <span className="text-[11px] text-[var(--text-muted)] truncate">
            {summaryParts.join(' + ')}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-2">
          <span className="text-[13px] font-semibold tabular-nums">{fmtShort(group.totalMarketValue)}</span>
          <span className="text-[10px] text-[var(--text-muted)]">({group.pct_allocation.toFixed(1)}%)</span>
          {group.totalCostBasis > 0 && <GainLoss value={gainLoss} className="text-[11px]" />}
        </div>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="pb-1.5 pl-5 space-y-0.5">
          {group.positions.map((p, i) => {
            const posGain = (p.market_value || 0) - (p.cost_basis || 0);
            const isOption = p.instrument_type === 'option';
            return (
              <div key={i} className="flex items-center justify-between py-0.5">
                <span className="text-[11px] text-[var(--text-muted)] truncate">
                  {isOption
                    ? fmtOption(p)
                    : showAccountBreakdown
                      ? `${shortAccount(p.account_id)} \u00B7 ${p.quantity?.toLocaleString()} shares`
                      : `${p.quantity?.toLocaleString()} shares`
                  }
                </span>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-[11px] tabular-nums">{fmtFull(p.market_value || 0)}</span>
                  {p.cost_basis != null && p.cost_basis > 0 && (
                    <GainLoss value={posGain} className="text-[10px]" />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Portfolio() {
  const [data, setData] = useState<HoldingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetchWithAuth<HoldingsData>('/api/holdings')
      .then(d => {
        setData(d);
        // Default: all accounts selected
        setSelectedAccounts(new Set((d.accounts || []).map(a => a.account_id)));
      })
      .catch(e => setError(e.message));
  }, []);

  // Filter and re-aggregate groups based on selected accounts
  const { groups, totalValue, allSelected } = useMemo(() => {
    if (!data) return { groups: [] as HoldingGroup[], totalValue: 0, allSelected: true };
    const all = selectedAccounts.size === (data.accounts || []).length;

    if (all) return { groups: data.groups || [], totalValue: data.totalValue, allSelected: true };

    // Re-filter holdings and rebuild groups
    const filtered = data.holdings.filter(h => selectedAccounts.has(h.account_id));
    const tv = filtered.reduce((s, h) => s + (h.market_value || 0), 0);

    const groupMap: Record<string, HoldingGroup> = {};
    for (const h of filtered) {
      const key = h.underlying || h.symbol || 'OTHER';
      if (!groupMap[key]) {
        groupMap[key] = { underlying: key, totalMarketValue: 0, totalCostBasis: 0, totalShares: 0, optionCount: 0, pct_allocation: 0, positions: [] };
      }
      groupMap[key].totalMarketValue += (h.market_value || 0);
      groupMap[key].totalCostBasis += (h.cost_basis || 0);
      if (h.instrument_type !== 'option') groupMap[key].totalShares += (h.quantity || 0);
      else groupMap[key].optionCount++;
      groupMap[key].positions.push(h);
    }

    const gs = Object.values(groupMap).map(g => {
      g.pct_allocation = tv > 0 ? (g.totalMarketValue / tv) * 100 : 0;
      g.positions.sort((a, b) => {
        if (a.instrument_type === 'equity' && b.instrument_type !== 'equity') return -1;
        if (a.instrument_type !== 'equity' && b.instrument_type === 'equity') return 1;
        if (a.expiry && b.expiry) return a.expiry.localeCompare(b.expiry);
        return 0;
      });
      return g;
    });
    gs.sort((a, b) => Math.abs(b.totalMarketValue) - Math.abs(a.totalMarketValue));

    return { groups: gs, totalValue: tv, allSelected: false };
  }, [data, selectedAccounts]);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;
  if (data.holdings.length === 0) return <EmptyState message="No holdings data available" />;

  const accounts = data.accounts || [];
  const showAccountFilter = accounts.length > 1;

  // Pie chart data from groups
  const chartData = groups.slice(0, 10).map(g => ({
    name: g.underlying || 'Other',
    value: Math.abs(g.totalMarketValue),
  }));

  function toggleAccount(id: string) {
    setSelectedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id); // Don't allow deselecting all
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    setSelectedAccounts(new Set(accounts.map(a => a.account_id)));
  }

  // Show per-account breakdown in expanded rows when multiple accounts are selected
  const showAccountBreakdown = selectedAccounts.size > 1;

  return (
    <div className="animate-fade-in">
      {/* Account filter chips */}
      {showAccountFilter && (
        <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2 scrollbar-hide">
          <button
            onClick={selectAll}
            className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
              allSelected
                ? 'bg-[var(--brand)] text-white'
                : 'bg-[var(--bg-card)] text-[var(--text-muted)] border border-[var(--border)]'
            }`}
          >
            All
          </button>
          {accounts.map(a => {
            const active = selectedAccounts.has(a.account_id) && !allSelected;
            return (
              <button
                key={a.account_id}
                onClick={() => toggleAccount(a.account_id)}
                className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors ${
                  active
                    ? 'bg-[var(--brand)]/20 text-[var(--brand)] border border-[var(--brand)]/40'
                    : 'bg-[var(--bg-card)] text-[var(--text-muted)] border border-[var(--border)]'
                }`}
              >
                {shortAccount(a.account_id)}
              </button>
            );
          })}
        </div>
      )}

      {/* Allocation donut */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3 mb-2">
        <p className="t-micro text-[var(--text-muted)] mb-1.5">Allocation — {fmtShort(totalValue)}</p>
        <div className="h-[180px] md:h-[260px]">
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
                iconSize={6}
                formatter={(value: string) => <span style={{ color: 'var(--text)', fontSize: 10 }}>{value}</span>}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Grouped positions */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
        <p className="t-micro text-[var(--text-muted)] mb-1.5">Positions</p>
        {groups.map(g => (
          <GroupRow key={g.underlying} group={g} showAccountBreakdown={showAccountBreakdown} />
        ))}
      </div>
    </div>
  );
}
