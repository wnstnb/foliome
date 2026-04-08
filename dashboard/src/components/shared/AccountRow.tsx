import { InstitutionIcon } from './InstitutionIcon';
import { fmtAccounting, fmtLiabilityDelta, staleness, fmtAge } from '@/lib/format';
import { LIABILITY_TYPES } from '@/lib/constants';
import { haptic } from '@/lib/telegram';
import type { Balance, StatementBalance } from '@/lib/types';

interface AccountRowProps {
  balance: Balance;
  statementBalance?: StatementBalance;
  dueDateLabel?: string;
  onClick?: () => void;
}

const STALENESS_COLORS = {
  fresh: 'var(--positive)',
  stale: 'var(--warning)',
  old: 'var(--negative)',
} as const;

export function AccountRow({ balance, statementBalance, dueDateLabel, onClick }: AccountRowProps) {
  const isLiability = LIABILITY_TYPES.has(balance.account_type);
  const delta = statementBalance
    ? fmtLiabilityDelta(balance.balance, statementBalance.closing_balance, isLiability)
    : null;
  const age = staleness(balance.synced_at);

  return (
    <div
      className="flex items-center justify-between py-2.5 px-3 -mx-3 cursor-pointer rounded-lg transition-colors duration-100 active:bg-[var(--bg-hover)]"
      onClick={() => { haptic(); onClick?.(); }}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <InstitutionIcon institution={balance.institution} />
        <div className="min-w-0">
          <p className="t-body font-medium whitespace-nowrap overflow-hidden text-ellipsis">
            {balance.account_name || balance.account_id}
          </p>
          <div className="flex items-center gap-1.5">
            {dueDateLabel ? (
              <p className="t-caption text-[var(--warning)]">{dueDateLabel}</p>
            ) : (
              <p className="t-caption text-[var(--text-muted)]">{balance.institution}</p>
            )}
            <span
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: STALENESS_COLORS[age.level] }}
              title={fmtAge(balance.synced_at)}
            />
            {age.level !== 'fresh' && (
              <span className="t-caption" style={{ color: STALENESS_COLORS[age.level], fontSize: 10 }}>
                {fmtAge(balance.synced_at)}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="text-right shrink-0 ml-2">
        <p className="t-value">{fmtAccounting(balance.balance)}</p>
        {delta && delta.direction !== 'neutral' && (
          <p className={`t-caption ${delta.direction === 'positive' ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
            {delta.text}
          </p>
        )}
      </div>
    </div>
  );
}
