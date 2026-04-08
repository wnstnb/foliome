import { CATEGORY_COLORS } from '@/lib/constants';

interface CategoryBadgeProps {
  category: string;
  showDot?: boolean;
}

export function CategoryBadge({ category, showDot = true }: CategoryBadgeProps) {
  const color = CATEGORY_COLORS[category] ?? '#6B7280';

  return (
    <span className="inline-flex items-center gap-1.5">
      {showDot && (
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: color }}
        />
      )}
      <span className="t-body">{category}</span>
    </span>
  );
}
