import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { EmptyState } from '@/components/shared/EmptyState';
import type { SubscriptionsData } from '@/lib/types';

/** Map known merchant substrings to Simple Icons slugs */
const MERCHANT_ICONS: Record<string, { slug: string; color: string }> = {
  youtube: { slug: 'youtube', color: '#EF4444' },
  netflix: { slug: 'netflix', color: '#EF4444' },
  apple: { slug: 'apple', color: '#6B7280' },
  google: { slug: 'google', color: '#3B82F6' },
  anthropic: { slug: 'anthropic', color: '#F97316' },
  twitter: { slug: 'x', color: '#6B7280' },
  'x ': { slug: 'x', color: '#6B7280' },
  spotify: { slug: 'spotify', color: '#1DB954' },
  amazon: { slug: 'amazon', color: '#FF9900' },
};

function MerchantIcon({ merchant }: { merchant: string }) {
  const lower = merchant.toLowerCase();
  for (const [key, { slug, color }] of Object.entries(MERCHANT_ICONS)) {
    if (lower.includes(key)) {
      return (
        <div
          className="flex items-center justify-center rounded-lg shrink-0"
          style={{ width: 28, height: 28, background: `${color}15` }}
        >
          <img
            src={`https://cdn.simpleicons.org/${slug}/${color.replace('#', '')}`}
            alt={merchant}
            style={{ width: 16, height: 16 }}
          />
        </div>
      );
    }
  }

  // Fallback
  const abbr = merchant.trim().slice(0, 2).toUpperCase();
  return (
    <div
      className="flex items-center justify-center rounded-lg shrink-0 text-[10px] font-bold"
      style={{ width: 28, height: 28, background: 'rgba(107,114,128,0.1)', color: '#6B7280' }}
    >
      {abbr}
    </div>
  );
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

export function Subscriptions() {
  const [data, setData] = useState<SubscriptionsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<SubscriptionsData>('/api/subscriptions')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) return <EmptyState message={error} />;
  if (!data) return <div className="py-12 text-center t-caption text-[var(--text-muted)]">Loading...</div>;
  if (data.subscriptions.length === 0) return <EmptyState message="No recurring charges detected" />;

  return (
    <div className="animate-fade-in">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-4 mb-3">
        <div className="flex justify-between mb-3">
          <p className="t-micro text-[var(--text-muted)]">Recurring Charges</p>
          <span className="t-value">~${Math.round(data.monthlyTotal)}/mo</span>
        </div>
        {data.subscriptions.map(sub => {
          const monthlyAmt = Math.round(Math.abs(sub.avg_amount));
          const annualAmt = monthlyAmt * 12;
          return (
            <div
              key={sub.merchant}
              className="flex items-center justify-between py-3 border-b border-[var(--border)]/50 last:border-b-0"
            >
              <div className="flex items-center gap-2.5">
                <MerchantIcon merchant={sub.merchant} />
                <div>
                  <p className="t-body font-medium">{titleCase(sub.merchant.trim())}</p>
                  <p className="t-caption text-[var(--text-muted)]">Last: {fmtDate(sub.last_charged)}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="t-value">${monthlyAmt}/mo</p>
                <p className="t-caption text-[var(--text-muted)]">${annualAmt.toLocaleString()}/yr</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Annual total warning */}
      <div
        className="rounded-xl border border-[var(--bg-card)] p-3"
        style={{
          borderColor: 'color-mix(in srgb, var(--warning) 30%, transparent)',
          background: 'color-mix(in srgb, var(--warning) 5%, var(--bg-card))',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[var(--warning)] text-base">!</span>
          <div>
            <p className="t-body text-[var(--warning)] font-medium">
              ~${Math.round(data.annualTotal).toLocaleString()} annually
            </p>
            <p className="t-caption text-[var(--text-muted)]">
              ${Math.round(data.monthlyTotal)}/month across {data.subscriptions.length} services
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
