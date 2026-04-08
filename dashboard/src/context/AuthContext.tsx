import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { isTelegram, getTg, tgReady } from '@/lib/telegram';
import { setSessionToken } from '@/lib/api';

type AuthState = 'loading' | 'authenticated' | 'error';

interface AuthContextType {
  state: AuthState;
  error: string | null;
}

const AuthContext = createContext<AuthContextType>({ state: 'loading', error: null });

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function authenticate() {
      // In dev mode, check for a dev token
      if (import.meta.env.DEV) {
        const devToken = import.meta.env.VITE_DEV_TOKEN;
        if (devToken) {
          setSessionToken(devToken);
          setState('authenticated');
          return;
        }
      }

      if (!isTelegram()) {
        setError('Open this dashboard from Telegram');
        setState('error');
        return;
      }

      const tg = getTg();
      if (!tg) {
        setError('Telegram WebApp not available');
        setState('error');
        return;
      }

      tgReady();

      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'initData=' + encodeURIComponent(tg.initData),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: 'Auth failed' }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        setSessionToken(data.sessionToken || data.token);
        setState('authenticated');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Authentication failed');
        setState('error');
      }
    }

    authenticate();
  }, []);

  return (
    <AuthContext.Provider value={{ state, error }}>
      {children}
    </AuthContext.Provider>
  );
}
