import { INSTITUTION_COLORS, INSTITUTION_ICONS } from '@/lib/constants';

interface InstitutionIconProps {
  institution: string;
  size?: number;
}

export function InstitutionIcon({ institution, size = 32 }: InstitutionIconProps) {
  const slug = institution.toLowerCase().replace(/\s+/g, '-');
  const color = INSTITUTION_COLORS[slug] ?? '#6B7280';
  const iconSlug = INSTITUTION_ICONS[slug];

  if (iconSlug) {
    return (
      <div
        className="flex items-center justify-center rounded-lg shrink-0"
        style={{ width: size, height: size, background: `${color}15` }}
      >
        <img
          src={`https://cdn.simpleicons.org/${iconSlug}/${color.replace('#', '')}`}
          alt={institution}
          style={{ width: size * 0.56, height: size * 0.56 }}
        />
      </div>
    );
  }

  // Fallback: 2-letter abbreviation
  const abbr = institution
    .split(/[-\s]+/)
    .map(w => w[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);

  return (
    <div
      className="flex items-center justify-center rounded-lg shrink-0 text-[11px] font-bold"
      style={{ width: size, height: size, background: `${color}15`, color }}
    >
      {abbr}
    </div>
  );
}
