import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/api';
import { fmtShort, fmtDelta, fmtPercent, fmtAge } from '@/lib/format';
import { CATEGORY_COLORS } from '@/lib/constants';
import { Sparkline } from '@/components/shared/Sparkline';
import type { BriefData, BriefSection } from '@/lib/types';

export function Brief() {
  const [data, setData] = useState<BriefData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWithAuth<BriefData>('/api/brief')
      .then(setData)
      .catch(e => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="py-12 text-center">
        <p className="t-body text-[var(--text-muted)]">{error}</p>
      </div>
    );
  }

  if (!data) {
    return <BriefSkeleton />;
  }

  if (!data.exists || !data.headline) {
    return (
      <div className="animate-fade-in py-16 text-center px-6">
        <p className="t-value text-[var(--text)] mb-2">No brief yet</p>
        <p className="t-body text-[var(--text-muted)] leading-relaxed">
          Your morning brief will appear here after your first sync.
          Tell the agent "good morning" or run /morning-brief to generate one.
        </p>
      </div>
    );
  }

  const { greeting, headline, sections = [], generatedAt } = data;

  return (
    <div className="animate-fade-in">
      {/* Above the fold: date + net worth + summary */}
      <div className="mb-5">
        <p className="t-caption text-[var(--text-muted)] mb-1">{greeting}</p>
        <div className="flex items-baseline gap-2">
          <span className="t-hero text-[var(--text)]">{fmtShort(headline.netWorth)}</span>
          {headline.sparkline.length >= 2 && (
            <Sparkline data={headline.sparkline} width={56} height={28} />
          )}
        </div>
        {headline.delta !== 0 && (
          <span
            className={`inline-block mt-1.5 px-2 py-0.5 rounded-full t-caption ${
              headline.delta >= 0
                ? 'bg-[var(--brand)]/10 text-[var(--positive)]'
                : 'bg-[var(--negative)]/10 text-[var(--negative)]'
            }`}
          >
            {fmtDelta(headline.delta)} {headline.deltaPeriod}
          </span>
        )}
        <p className="t-body text-[var(--text-muted)] mt-2">{headline.summary}</p>
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {sections.map((section, i) => (
          <SectionRenderer key={`${section.type}-${i}`} section={section} />
        ))}
      </div>

      {/* Footer */}
      {generatedAt && (
        <p className="t-micro text-[var(--text-muted)] mt-6 mb-2 text-center opacity-50">
          Generated {fmtAge(generatedAt)}
        </p>
      )}
    </div>
  );
}

function SectionRenderer({ section }: { section: BriefSection }) {
  switch (section.type) {
    case 'goal_progress':
      return <GoalSection section={section} />;
    case 'budget_pulse':
      return <BudgetSection section={section} />;
    case 'upcoming':
      return <UpcomingSection section={section} />;
    default:
      return <ProseSection section={section} />;
  }
}

/** Generic prose section — used for recent_activity, concern, insight, account_health, portfolio */
function ProseSection({ section }: { section: BriefSection }) {
  return (
    <div className="border-t border-[var(--border)] pt-4">
      <p className="t-micro text-[var(--text-muted)] mb-1.5">{section.title}</p>
      <p className="t-body text-[var(--text)] leading-relaxed whitespace-pre-line">{section.body}</p>
    </div>
  );
}

/** Goal progress with progress bar */
function GoalSection({ section }: { section: BriefSection }) {
  const pct = Math.min((section.progress ?? 0) * 100, 100);

  return (
    <div className="border-t border-[var(--border)] pt-4">
      <p className="t-micro text-[var(--text-muted)] mb-1.5">{section.title}</p>
      <p className="t-body text-[var(--text)] leading-relaxed mb-2">{section.body}</p>
      <div className="prog-track">
        <div
          className="prog-fill"
          style={{
            width: `${pct}%`,
            background: 'var(--brand)',
          }}
        />
      </div>
      <p className="t-caption text-[var(--text-muted)] mt-1">{fmtPercent(pct, 0)} complete</p>
    </div>
  );
}

/** Budget pulse with colored progress bar + pace indicator */
function BudgetSection({ section }: { section: BriefSection }) {
  const spent = section.spent ?? 0;
  const budget = section.budget ?? 1;
  const pct = Math.min((spent / budget) * 100, 100);
  const color = CATEGORY_COLORS[section.category ?? ''] ?? 'var(--brand)';
  const isOver = spent > budget;
  const paceColor = section.pace === 'above' ? 'var(--warning)' : section.pace === 'over' ? 'var(--negative)' : 'var(--positive)';

  return (
    <div className="border-t border-[var(--border)] pt-4">
      <div className="flex items-center justify-between mb-1.5">
        <p className="t-micro text-[var(--text-muted)]">{section.title}</p>
        <span className="t-caption" style={{ color: paceColor }}>
          {fmtShort(spent)} / {fmtShort(budget)}
        </span>
      </div>
      <p className="t-body text-[var(--text)] leading-relaxed mb-2">{section.body}</p>
      <div className="prog-track">
        <div
          className="prog-fill"
          style={{
            width: `${pct}%`,
            background: isOver ? 'var(--negative)' : color,
          }}
        />
      </div>
    </div>
  );
}

/** Upcoming payments section */
function UpcomingSection({ section }: { section: BriefSection }) {
  return (
    <div className="border-t border-[var(--border)] pt-4">
      <p className="t-micro text-[var(--text-muted)] mb-1.5">{section.title}</p>
      <p className="t-body text-[var(--text)] leading-relaxed">{section.body}</p>
      {section.payments && section.payments.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {section.payments.map((p, i) => (
            <div key={i} className="flex items-center justify-between">
              <span className="t-caption text-[var(--text-muted)]">
                {p.account_name} {p.days_until != null && `— ${p.days_until <= 1 ? 'due today' : `in ${p.days_until}d`}`}
              </span>
              <span className="t-value text-[var(--warning)]">{fmtShort(Math.abs(p.balance))}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Skeleton loading state */
function BriefSkeleton() {
  return (
    <div className="animate-fade-in space-y-4">
      <div>
        <div className="h-3 w-24 rounded bg-[var(--border)] mb-2" />
        <div className="h-8 w-40 rounded bg-[var(--border)] mb-2" />
        <div className="h-3 w-48 rounded bg-[var(--border)]" />
      </div>
      {[1, 2, 3].map(i => (
        <div key={i} className="border-t border-[var(--border)] pt-4">
          <div className="h-3 w-20 rounded bg-[var(--border)] mb-2" />
          <div className="h-3 w-full rounded bg-[var(--border)] mb-1" />
          <div className="h-3 w-3/4 rounded bg-[var(--border)]" />
        </div>
      ))}
    </div>
  );
}
