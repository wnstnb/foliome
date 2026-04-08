import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { isTelegram, tgColorScheme } from '@/lib/telegram';

type Theme = 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  isTg: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  isTg: false,
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const isTg = isTelegram();

  const [theme, setTheme] = useState<Theme>(() => {
    if (isTg) return tgColorScheme();
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    return 'light';
  });

  // Track whether user has manually toggled — disables Telegram theme override
  const [userOverride, setUserOverride] = useState(false);

  const toggleTheme = useCallback(() => {
    setUserOverride(true);
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    // Only apply tg-theme if user hasn't manually toggled
    if (isTg && !userOverride) {
      root.classList.add('tg-theme');
    } else {
      root.classList.remove('tg-theme');
    }
  }, [theme, isTg, userOverride]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, isTg }}>
      {children}
    </ThemeContext.Provider>
  );
}
