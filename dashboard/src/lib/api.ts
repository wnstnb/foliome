/**
 * API client with session token management.
 */

import { inPortal } from './portal';

let sessionToken: string | null = null;

export function setSessionToken(token: string) {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export async function fetchWithAuth<T>(path: string, params?: Record<string, string>): Promise<T> {
  const portal = inPortal();
  // Telegram mode authorizes with a Bearer session token; portal mode authorizes via
  // the portal_session cookie injected by the reverse proxy (no token needed).
  if (!portal && !sessionToken) throw new Error('Not authenticated');

  // Resolve relative to the document base (document.baseURI) so requests work under
  // both "/" (Telegram) and "/foliome/" (portal). The leading slash is stripped so
  // the injected <base href> applies; absolute paths would ignore it.
  const rel = path.replace(/^\//, '');
  const url = new URL(rel, document.baseURI);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = {};
  if (sessionToken) headers['Authorization'] = `Bearer ${sessionToken}`;

  const res = await fetch(url.toString(), {
    headers,
    credentials: 'include', // send portal_session cookie on same-origin XHR
  });

  if (res.status === 401) {
    sessionToken = null;
    throw new Error('Session expired');
  }

  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }

  return res.json() as Promise<T>;
}
