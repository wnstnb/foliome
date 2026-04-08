/**
 * API client with session token management.
 */

let sessionToken: string | null = null;

export function setSessionToken(token: string) {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export async function fetchWithAuth<T>(path: string, params?: Record<string, string>): Promise<T> {
  if (!sessionToken) throw new Error('Not authenticated');

  const url = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${sessionToken}` },
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
