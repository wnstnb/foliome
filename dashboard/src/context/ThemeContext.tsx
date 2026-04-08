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

  const toggleTheme = useCallback(() => {
    if (isTg) return; // Telegram controls theme
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, [isTg]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    if (isTg) {
      root.classList.add('tg-theme');
    }
  }, [theme, isTg]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, isTg }}>
      {children}
    </ThemeContext.Provider>
  );
}
