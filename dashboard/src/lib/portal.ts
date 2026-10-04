/**
 * Portal mode helpers.
 *
 * When the dashboard is served behind the agent portal reverse proxy, the server
 * injects <meta name="portal-mode" content="true"> + <base href="/foliome/"> into
 * index.html. In portal mode the Telegram initData handshake is skipped — the proxy
 * authenticates every request (X-Portal-Auth header / portal_session cookie), so API
 * calls authorize via the cookie rather than a Bearer session token.
 */

export function inPortal(): boolean {
  if (typeof document === 'undefined') return false;
  const meta = document.querySelector('meta[name="portal-mode"]');
  return meta?.getAttribute('content') === 'true';
}
