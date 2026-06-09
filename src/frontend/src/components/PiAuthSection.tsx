import { useState, useEffect, useCallback } from 'react';

interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
  configured?: boolean;
}

export function PiAuthSection() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/status');
      const data = await res.json();
      setProviders(data.providers || []);
    } catch (err) {
      console.error('Failed to load auth status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveKey = async (provider: string) => {
    const key = newKey[provider];
    if (!key) return;
    setSaving(provider);
    try {
      await fetch('/api/auth/save-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key }),
      });
      setNewKey((prev) => ({ ...prev, [provider]: '' }));
      await load();
    } catch (err) {
      console.error('Failed to save key:', err);
    } finally {
      setSaving(null);
    }
  };

  const logout = async (provider: string) => {
    setSaving(provider);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      await load();
    } catch (err) {
      console.error('Failed to logout:', err);
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return <div className="text-xs text-zinc-500">Loading auth status…</div>;
  }

  const knownProviders = [
    { id: 'openrouter', label: 'OpenRouter' },
    { id: 'anthropic', label: 'Anthropic (Claude)' },
    { id: 'openai', label: 'OpenAI' },
    { id: 'openai-codex', label: 'OpenAI Codex' },
    { id: 'google', label: 'Google (Gemini)' },
  ];

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        API keys are stored in <span className="font-mono">~/.nexus/auth.json</span> and managed by the Pi runtime.
      </p>
      {knownProviders.map((p) => {
        const status = providers.find((x) => x.id === p.id);
        const configured = status?.type === 'api_key' || status?.type === 'oauth';
        return (
          <div key={p.id} className="flex items-center gap-2">
            <span className="text-sm text-zinc-300 w-40">{p.label}</span>
            {configured ? (
              <>
                <span className="text-xs text-green-400">✓ Configured</span>
                <button
                  onClick={() => logout(p.id)}
                  disabled={saving === p.id}
                  className="ml-auto px-2 py-1 text-xs bg-zinc-800 text-zinc-400 rounded hover:bg-zinc-700 disabled:opacity-40"
                >
                  {saving === p.id ? '…' : 'Remove'}
                </button>
              </>
            ) : (
              <>
                <input
                  type="password"
                  value={newKey[p.id] || ''}
                  onChange={(e) => setNewKey((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  placeholder="sk-…"
                  className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
                />
                <button
                  onClick={() => saveKey(p.id)}
                  disabled={saving === p.id || !newKey[p.id]}
                  className="px-2 py-1 text-xs bg-indigo-500 text-ink rounded hover:bg-indigo-600 disabled:opacity-40"
                >
                  {saving === p.id ? '…' : 'Save'}
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
