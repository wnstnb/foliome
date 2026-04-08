import { fmtAccounting } from '@/lib/format';
import { CATEGORY_COLORS } from '@/lib/constants';
import type { Transaction } from '@/lib/types';

interface TransactionRowProps {
  txn: Transaction;
}

export function TransactionRow({ txn }: TransactionRowProps) {
  const cat = txn.user_category || txn.category || '';
  const catColor = CATEGORY_COLORS[cat] ?? '#6B7280';
  const isCredit = txn.amount > 0;

  return (
    <div className="flex items-center justify-between py-3 border-b border-[var(--border)]/50 last:border-b-0">
      <div className="min-w-0 mr-2">
        <p className="t-body font-medium whitespace-nowrap overflow-hidden text-ellipsis">
          {txn.description}
        </p>
        <div className="flex gap-1.5 mt-0.5">
          {cat && (
            <span
              className="inline-flex items-center px-1.5 py-px rounded text-[10px] font-medium"
              style={{ background: `${catColor}15`, color: catColor }}
            >
              {cat}
            </span>
          )}
          <span className="t-caption text-[var(--text-muted)]">
            {txn.account_id}
          </span>
        </div>
      </div>
      <span className={`t-value shrink-0 ${isCredit ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
        {isCredit ? `+${fmtAccounting(txn.amount)}` : fmtAccounting(txn.amount)}
      </span>
    </div>
  );
}
