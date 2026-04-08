import { useState, useCallback, useEffect } from 'react';
import { AuthProvider, useAuth } from '@/context/AuthContext';
import { ThemeProvider, useTheme } from '@/context/ThemeContext';
import { Brief } from '@/tabs/Brief';
import { Overview } from '@/tabs/Overview';
import { Transactions } from '@/tabs/Transactions';
import { Budget } from '@/tabs/Budget';
import { Portfolio } from '@/tabs/Portfolio';
import { Subscriptions } from '@/tabs/Subscriptions';
import { Wiki } from '@/tabs/Wiki';
import { FinancialHealth } from '@/components/overlays/FinancialHealth';
import { fetchWithAuth } from '@/lib/api';
import { haptic } from '@/lib/telegram';
import { Sun, Moon } from 'lucide-react';
import type { BriefData } from '@/lib/types';

type HealthMetric = 'net_worth' | 'assets' | 'liabilities' | 'savings';

const TABS: { id: string; label: string }[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'overview', label: 'Overview' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budget', label: 'Budget' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'subs', label: 'Subs' },
  { id: 'wiki', label: 'Wiki' },
];

function DashboardApp() {
  const { state, error } = useAuth();
  const { theme, toggleTheme, isTg } = useTheme();
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [briefChecked, setBriefChecked] = useState(false);

  // Smart default: switch to Brief tab if a brief exists
  useEffect(() => {
    if (state !== 'authenticated' || briefChecked) return;
    fetchWithAuth<BriefData>('/api/brief')
      .then(data => {
        if (data.exists) setActiveTab('brief');
      })
      .catch(() => {})
      .finally(() => setBriefChecked(true));
  }, [state, briefChecked]);
  const [healthMetric, setHealthMetric] = useState<HealthMetric | null>(null);

  // Drill-down state for Transactions tab
  const [txnAccount, setTxnAccount] = useState<string | undefined>();
  const [txnCategory, setTxnCategory] = useState<string | undefined>();
  const [txnSubTab, setTxnSubTab] = useState<'spending' | 'activity' | undefined>();

  const switchTab = useCallback((tab: string) => {
    haptic();
    setActiveTab(tab);
  }, []);

  const handleAccountClick = useCallback((accountId: string) => {
    setTxnAccount(accountId);
    setTxnCategory(undefined);
    setTxnSubTab('activity');
    switchTab('transactions');
  }, [switchTab]);

  const handleKPIClick = useCallback((metric: string) => {
    haptic();
    setHealthMetric(metric as HealthMetric);
  }, []);

  // Auth states
  if (state === 'loading') {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="t-body text-[var(--text-muted)]">Loading...</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center justify-center h-screen px-4">
        <p className="t-body text-[var(--text-muted)] text-center">{error || 'Access denied'}</p>
      </div>
    );
  }

  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="max-w-[430px] md:max-w-3xl lg:max-w-5xl mx-auto px-4 md:px-8 pt-4 md:pt-6 pb-20 safe-bottom">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <span className="t-value text-[var(--brand)] text-lg" style={{ letterSpacing: '-0.3px' }}>Foliome</span>
          <p className="t-caption text-[var(--text-muted)] mt-0.5">{today}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--brand)]/10 text-[var(--brand)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)]" />
            Synced
          </span>
          {!isTg && (
            <button
              onClick={toggleTheme}
              className="relative w-[52px] h-7 rounded-full border-none cursor-pointer p-0 transition-colors duration-200 shrink-0"
              style={{ background: theme === 'light' ? 'var(--brand)' : 'var(--border)' }}
              aria-label="Toggle theme"
            >
              <div
                className="absolute top-[3px] w-[22px] h-[22px] rounded-full bg-[var(--bg-card)] shadow-sm flex items-center justify-center transition-transform duration-250"
                style={{
                  left: 3,
                  transform: theme === 'light' ? 'translateX(24px)' : 'translateX(0)',
                  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                }}
              >
                {theme === 'dark' ? (
                  <Moon className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                ) : (
                  <Sun className="w-3.5 h-3.5 text-amber-500" />
                )}
              </div>
            </button>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-[var(--border)] mb-5 overflow-x-auto" style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`shrink-0 px-3.5 md:px-5 py-2 md:py-2.5 text-xs md:text-sm font-medium relative transition-colors duration-150 border-none bg-transparent cursor-pointer ${
              activeTab === tab.id ? 'text-[var(--brand)]' : 'text-[var(--text-muted)]'
            }`}
            onClick={() => switchTab(tab.id)}
          >
            {tab.label}
            {activeTab === tab.id && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-0.5 bg-[var(--brand)]" />
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'brief' && <Brief />}
      {activeTab === 'overview' && (
        <Overview onAccountClick={handleAccountClick} onKPIClick={handleKPIClick} />
      )}
      {activeTab === 'transactions' && (
        <Transactions
          initialAccount={txnAccount}
          initialCategory={txnCategory}
          initialSubTab={txnSubTab}
        />
      )}
      {activeTab === 'budget' && <Budget />}
      {activeTab === 'portfolio' && <Portfolio />}
      {activeTab === 'subs' && <Subscriptions />}
      {activeTab === 'wiki' && <Wiki />}

      {/* Financial Health overlay */}
      {healthMetric && (
        <FinancialHealth
          initialMetric={healthMetric}
          onClose={() => setHealthMetric(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <DashboardApp />
      </ThemeProvider>
    </AuthProvider>
  );
}
