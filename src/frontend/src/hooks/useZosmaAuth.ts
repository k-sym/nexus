/**
 * useZosmaAuth — frontend hook for the Zosma auth section in Settings.
 *
 * Talks to the pi-backed /api/auth/* endpoints:
 *   GET  /api/auth/status        — list of providers with credentials
 *   POST /api/auth/save-key      — store an API key for a provider
 *   POST /api/auth/logout        — clear a provider's credentials
 *
 * OAuth start/cancel are stubbed in the backend for now (501); the
 * UI exposes an API-key form for every provider and the OAuth
 * button is a follow-up.
 */
import { useCallback, useEffect, useState } from 'react';

export interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
}

export interface AuthStatus {
  providers: AuthProvider[];
  hasAny: boolean;
}

export function useZosmaAuth() {
  const [status, setStatus] = useState<AuthStatus>({ providers: [], hasAny: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/status');
      if (!res.ok) throw new Error(`status: ${res.status}`);
      const data = (await res.json()) as AuthStatus;
      setStatus(data);
    } catch (err) {
      console.error('useZosmaAuth: refresh failed', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(
    async (provider: string, key: string) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch('/api/auth/save-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider, key }),
        });
        if (!res.ok) throw new Error(`save-key: ${res.status}`);
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh],
  );

  const logout = useCallback(
    async (provider: string) => {
      setError(null);
      try {
        const res = await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        });
        if (!res.ok) throw new Error(`logout: ${res.status}`);
        await refresh();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [refresh],
  );

  return { status, loading, saving, error, refresh, saveKey, logout };
}
