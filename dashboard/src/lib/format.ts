/**
 * Accounting-style number formatting for Foliome dashboard.
 * Parentheses for negatives, abbreviations for large numbers.
 */

/** Format with accounting parentheses: ($1,234.56) */
export function fmtAccounting(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `($${str})` : `$${str}`;
}

/** Format abbreviated: $1.3M, $45.2K, $123 */
export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  const wrap = (s: string) => n < 0 ? `(${s})` : s;
  if (abs >= 1_000_000) return wrap(`$${(abs / 1_000_000).toFixed(1)}M`);
  if (abs >= 10_000) return wrap(`$${(abs / 1_000).toFixed(0)}K`);
  if (abs >= 1_000) return wrap(`$${(abs / 1_000).toFixed(1)}K`);
  return wrap(`$${abs.toFixed(0)}`);
}

/** Format with explicit sign: +$1,234 or ($1,234) */
export function fmtDelta(n: number): string {
  const abs = Math.abs(n);
  const str = abs >= 1_000
    ? abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n >= 0 ? `+$${str}` : `($${str})`;
}

/** Format full precision: $1,234.56 or -$1,234.56 */
export function fmtFull(n: number): string {
  const abs = Math.abs(n);
  const str = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `-$${str}` : `$${str}`;
}

/**
 * Liability delta wording.
 * Credit cards / mortgages: "paid down" (green) or "more owed" (red)
 * Assets: plain delta
 */
export function fmtLiabilityDelta(
  current: number,
  previous: number,
  isLiability: boolean
): { text: string; direction: 'positive' | 'negative' | 'neutral' } {
  const delta = current - previous;
  if (delta === 0) return { text: '--', direction: 'neutral' };

  const absDelta = Math.abs(delta);
  const fmtAbs = absDelta >= 1_000
    ? `$${(absDelta / 1_000).toFixed(0)}K`
    : `$${absDelta.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  if (isLiability) {
    // For liabilities (negative balances): balance going more negative = bad, less negative = good
    if (delta > 0) {
      // Balance increased (less negative) = paid down
      return { text: `\u25B2 ${fmtAbs} paid down`, direction: 'positive' };
    } else {
      // Balance decreased (more negative) = more owed
      return { text: `\u25BC ${fmtAbs} more owed`, direction: 'negative' };
    }
  } else {
    if (delta > 0) {
      return { text: `\u25B2 ${fmtAbs}`, direction: 'positive' };
    } else {
      return { text: `\u25BC ${fmtAbs}`, direction: 'negative' };
    }
  }
}

/** Format a percentage */
export function fmtPercent(n: number, decimals = 1): string {
  return `${n.toFixed(decimals)}%`;
}

/** Format a date as short month name + day */
export function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

/** Format YYYY-MM as "Mar 2026" */
export function fmtMonth(ym: string): string {
  const [y, m] = ym.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(m) - 1]} ${y}`;
}

/** Staleness from a synced_at ISO string. Returns hours and a severity level. */
export function staleness(syncedAt: string): { hours: number; level: 'fresh' | 'stale' | 'old' } {
  const hours = (Date.now() - new Date(syncedAt).getTime()) / 3_600_000;
  if (hours > 48) return { hours, level: 'old' };
  if (hours > 24) return { hours, level: 'stale' };
  return { hours, level: 'fresh' };
}

/** Human-readable age label: "2h ago", "1d ago", "3d ago" */
export function fmtAge(syncedAt: string): string {
  const hours = (Date.now() - new Date(syncedAt).getTime()) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
