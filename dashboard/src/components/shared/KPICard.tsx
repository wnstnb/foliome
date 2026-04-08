import { haptic } from '@/lib/telegram';

interface KPICardProps {
  label: string;
  value: string;
  variant?: 'hero' | 'secondary';
  valueClass?: string;
  subtitle?: string;
  subtitleClass?: string;
  sparkline?: React.ReactNode;
  onClick?: () => void;
}

export function KPICard({ label, value, variant = 'secondary', valueClass, subtitle, subtitleClass, sparkline, onClick }: KPICardProps) {
  const isHero = variant === 'hero';

  return (
    <div
      className={`rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-center cursor-pointer active:scale-[0.97] transition-transform duration-100 ${isHero ? 'p-5' : 'p-3'}`}
      onClick={() => { haptic(); onClick?.(); }}
    >
      <p className="t-micro text-[var(--text-muted)]" style={{ marginBottom: isHero ? 4 : 2 }}>{label}</p>
      <div className="flex items-center justify-center gap-1">
        <span className={isHero ? 't-hero' : 't-value'} style={valueClass ? {} : undefined}>
          <span className={valueClass}>{value}</span>
        </span>
        {sparkline}
      </div>
      {subtitle && (
        <div style={{ marginTop: 8 }}>
          <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${subtitleClass ?? ''}`}>
            {subtitle}
          </span>
        </div>
      )}
    </div>
  );
}
