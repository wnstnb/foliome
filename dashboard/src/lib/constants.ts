/** Chart categorical palette (diversified, matches design spec) */
export const CHART_PALETTE = [
  '#0D9488', '#3B82F6', '#8B5CF6', '#F59E0B', '#EC4899', '#06B6D4', '#EF4444',
  '#34D399', '#A855F7', '#F97316', '#14B8A6', '#6366F1', '#E11D48',
];

/** Category → chart color mapping */
export const CATEGORY_COLORS: Record<string, string> = {
  Restaurants: '#0D9488',
  Groceries: '#34D399',
  Shopping: '#F59E0B',
  Transportation: '#3B82F6',
  Entertainment: '#06B6D4',
  Utilities: '#3B82F6',
  Subscription: '#8B5CF6',
  Healthcare: '#EC4899',
  Insurance: '#14B8A6',
  Housing: '#6366F1',
  Travel: '#EF4444',
  Education: '#A855F7',
  'Personal Care': '#F97316',
  Transfer: '#6B7280',
  Income: '#059669',
  Fees: '#DC2626',
};

/** Institution → brand color for icon backgrounds */
export const INSTITUTION_COLORS: Record<string, string> = {
  // Big 4
  chase: '#117ACA',
  'bank-of-america': '#DC143C',
  'wells-fargo': '#D71E28',
  citi: '#003B70',
  citibank: '#003B70',
  // Regional banks
  'us-bank': '#D42629',
  usbank: '#D42629',
  pnc: '#F58025',
  truist: '#8031A7',
  'td-bank': '#34A853',
  'fifth-third': '#00543C',
  regions: '#00833E',
  keybank: '#EF3E42',
  huntington: '#00875A',
  'mt-bank': '#8B1A10',
  citizens: '#00754A',
  bmo: '#0075BE',
  // Credit cards
  'capital-one': '#D03027',
  'american-express': '#2E77BB',
  amex: '#2E77BB',
  discover: '#FF6000',
  apple: '#6B7280',
  'apple-card': '#6B7280',
  // Online / neo banks
  ally: '#6E2585',
  marcus: '#000000',
  sofi: '#BE9B5A',
  chime: '#1EC677',
  varo: '#3CAEA3',
  synchrony: '#00263E',
  // Brokerages
  schwab: '#00A3E0',
  fidelity: '#4B8B3B',
  'net-benefits': '#4B8B3B',
  netbenefits: '#4B8B3B',
  vanguard: '#C22E2A',
  'e-trade': '#6633CC',
  etrade: '#6633CC',
  robinhood: '#00C805',
  'interactive-brokers': '#D4001A',
  'merrill-lynch': '#012169',
  merrill: '#012169',
  // Credit unions
  'navy-federal': '#003768',
  penfed: '#003C71',
  becu: '#004B87',
  alliant: '#00457C',
  // Fintech / payment
  paypal: '#003087',
  venmo: '#3D95CE',
  'cash-app': '#00D632',
  cashapp: '#00D632',
  // Specialty
  usaa: '#003B75',
  wealthfront: '#480FEB',
  betterment: '#0A4BF5',
  'goldman-sachs': '#6D8A96',
  tiaa: '#00558C',
  nationwide: '#004B87',
};

/** Simple Icons CDN slugs for known institutions */
export const INSTITUTION_ICONS: Record<string, string> = {
  chase: 'chase',
  'bank-of-america': 'bankofamerica',
  'wells-fargo': 'wellsfargo',
  apple: 'apple',
  'apple-card': 'apple',
  paypal: 'paypal',
  'american-express': 'americanexpress',
  amex: 'americanexpress',
  discover: 'discover',
  robinhood: 'robinhood',
  venmo: 'venmo',
  'cash-app': 'cashapp',
  cashapp: 'cashapp',
  'goldman-sachs': 'goldmansachs',
  marcus: 'goldmansachs',
};

/** Account type display labels */
export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  credit: 'Credit Cards',
  brokerage: 'Brokerage',
  retirement: 'Retirement',
  education: 'Education',
  mortgage: 'Mortgage',
  real_estate: 'Real Estate',
};

/** Account type group colors */
export const ACCOUNT_TYPE_COLORS: Record<string, string> = {
  checking: 'var(--positive)',
  savings: 'var(--positive)',
  credit: 'var(--negative)',
  brokerage: '#3B82F6',
  retirement: '#3B82F6',
  education: '#8B5CF6',
  mortgage: 'var(--brand)',
  real_estate: 'var(--brand)',
};

/** Liability account types (delta wording changes) */
export const LIABILITY_TYPES = new Set(['credit', 'mortgage']);

/** Wiki page type display labels */
export const WIKI_TYPE_LABELS: Record<string, string> = {
  goal: 'Goals',
  preference: 'Preferences',
  concern: 'Concerns',
  context: 'Context',
  pattern: 'Patterns',
  article: 'Articles',
  reflection: 'Reflections',
};

/** Wiki status → CSS color */
export const WIKI_STATUS_COLORS: Record<string, string> = {
  active: 'var(--positive)',
  resolved: 'var(--text-muted)',
  archived: 'var(--border)',
};

/** Date filter presets */
export const DATE_PRESETS = [
  { label: 'This month', value: 'this-month' },
  { label: 'Last month', value: 'last-month' },
  { label: 'Last 30 days', value: '30d' },
  { label: 'Last 60 days', value: '60d' },
  { label: 'Last 90 days', value: '90d' },
] as const;

export type DatePreset = typeof DATE_PRESETS[number]['value'];

/** Resolve a date preset to from/to date strings */
export function resolveDatePreset(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);

  switch (preset) {
    case 'this-month': {
      const from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      return { from, to };
    }
    case 'last-month': {
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const last = new Date(now.getFullYear(), now.getMonth(), 0);
      return {
        from: prev.toISOString().slice(0, 10),
        to: last.toISOString().slice(0, 10),
      };
    }
    case '30d': {
      const d = new Date(now); d.setDate(d.getDate() - 30);
      return { from: d.toISOString().slice(0, 10), to };
    }
    case '60d': {
      const d = new Date(now); d.setDate(d.getDate() - 60);
      return { from: d.toISOString().slice(0, 10), to };
    }
    case '90d': {
      const d = new Date(now); d.setDate(d.getDate() - 90);
      return { from: d.toISOString().slice(0, 10), to };
    }
  }
}
