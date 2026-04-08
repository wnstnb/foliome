/**
 * Telegram Mini App helpers.
 * Wraps window.Telegram.WebApp with safe access.
 */

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe: Record<string, unknown>;
        ready: () => void;
        expand: () => void;
        close: () => void;
        colorScheme: 'light' | 'dark';
        themeParams: Record<string, string>;
        BackButton: {
          show: () => void;
          hide: () => void;
          onClick: (cb: () => void) => void;
          offClick: (cb: () => void) => void;
        };
        HapticFeedback: {
          impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
          notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
          selectionChanged: () => void;
        };
      };
    };
  }
}

export function getTg() {
  return window.Telegram?.WebApp ?? null;
}

export function isTelegram(): boolean {
  const tg = getTg();
  return !!(tg && tg.initData);
}

export function tgReady() {
  const tg = getTg();
  if (tg) {
    tg.ready();
    tg.expand();
  }
}

export function tgColorScheme(): 'light' | 'dark' {
  const tg = getTg();
  return tg?.colorScheme ?? 'dark';
}

export function haptic(style: 'light' | 'medium' | 'heavy' = 'light') {
  getTg()?.HapticFeedback.impactOccurred(style);
}

export function showBackButton(cb: () => void) {
  const tg = getTg();
  if (tg) {
    tg.BackButton.onClick(cb);
    tg.BackButton.show();
  }
}

export function hideBackButton(cb: () => void) {
  const tg = getTg();
  if (tg) {
    tg.BackButton.offClick(cb);
    tg.BackButton.hide();
  }
}
