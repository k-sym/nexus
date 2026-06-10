import { useState, useEffect, useCallback } from 'react';

interface AuthProvider {
  id: string;
  type: 'api_key' | 'oauth';
  configured?: boolean;
}

interface OAuthFlow {
  id: string;
  provider: string;
  status: 'starting' | 'waiting' | 'prompt' | 'complete' | 'error' | 'cancelled';
  message?: string;
  instructions?: string;
  authUrl?: string;
  deviceCode?: string;
  prompt?: string;
  error?: string;
}

interface OAuthFlowResponse {
  id: string;
  provider: string;
  state?: 'pending' | 'needs_input' | 'complete' | 'error' | 'cancelled';
  status?: OAuthFlow['status'];
  authUrl?: string;
  instructions?: string;
  deviceCode?: string | {
    userCode: string;
    verificationUri: string;
  };
  prompt?: string | {
    message?: string;
    placeholder?: string;
  };
  message?: string;
  messages?: string[];
  error?: string;
}

const subscriptionProviders = new Set(['anthropic', 'openai-codex']);

function normalizeFlow(data: OAuthFlowResponse): OAuthFlow {
  const status =
    data.status ??
    (data.state === 'needs_input'
      ? 'prompt'
      : data.state === 'pending'
        ? 'waiting'
        : data.state ?? 'waiting');
  const deviceCode = typeof data.deviceCode === 'string' ? data.deviceCode : data.deviceCode?.userCode;
  const authUrl =
    data.authUrl ?? (typeof data.deviceCode === 'object' ? data.deviceCode.verificationUri : undefined);
  const prompt = typeof data.prompt === 'string' ? data.prompt : data.prompt?.message;
  return {
    id: data.id,
    provider: data.provider,
    status,
    message: data.message ?? data.messages?.at(-1),
    instructions: data.instructions,
    authUrl,
    deviceCode,
    prompt,
    error: data.error,
  };
}

export function PiAuthSection() {
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<Record<string, string>>({});
  const [flow, setFlow] = useState<OAuthFlow | null>(null);
  const [manualValue, setManualValue] = useState('');

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

  const pollFlow = useCallback(
    async (flowId: string) => {
      const res = await fetch(`/api/auth/oauth/${flowId}`);
      if (!res.ok) throw new Error('OAuth flow status failed');
      const data = normalizeFlow((await res.json()) as OAuthFlowResponse);
      setFlow(data);
      if (data.status === 'complete') {
        setManualValue('');
        await load();
        window.dispatchEvent(new Event('nexus:models-refresh'));
      }
      return data;
    },
    [load],
  );

  useEffect(() => {
    if (!flow || ['complete', 'error', 'cancelled'].includes(flow.status)) return;
    const timer = window.setInterval(() => {
      pollFlow(flow.id).catch((err) => {
        setFlow((prev) =>
          prev?.id === flow.id ? { ...prev, status: 'error', error: String(err) } : prev,
        );
      });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [flow, pollFlow]);

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

  const startOAuth = async (provider: string) => {
    setSaving(provider);
    setManualValue('');
    try {
      const res = await fetch('/api/auth/start-oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const data = await res.json();
      if (!res.ok || !data.flowId) throw new Error(data.error || 'OAuth start failed');
      setFlow({ id: data.flowId, provider, status: 'starting', message: 'Starting OAuth…' });
      await pollFlow(data.flowId);
    } catch (err) {
      setFlow({
        id: `${provider}-error`,
        provider,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(null);
    }
  };

  const submitManualValue = async () => {
    if (!flow || !manualValue.trim()) return;
    setSaving(flow.provider);
    try {
      await fetch(`/api/auth/oauth/${flow.id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: manualValue }),
      });
      setManualValue('');
      await pollFlow(flow.id);
    } catch (err) {
      setFlow((prev) =>
        prev
          ? { ...prev, status: 'error', error: err instanceof Error ? err.message : String(err) }
          : prev,
      );
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
      {flow && (
        <div className="rounded-md border border-indigo-500/30 bg-indigo-500/10 p-3 text-xs text-zinc-300">
          <div className="font-medium text-indigo-200">
            Subscription login: {flow.provider}
          </div>
          {flow.message && <div className="mt-1 text-zinc-400">{flow.message}</div>}
          {flow.instructions && <div className="mt-1 text-zinc-300">{flow.instructions}</div>}
          {flow.authUrl && (
            <a
              href={flow.authUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex text-indigo-300 hover:text-indigo-200"
            >
              Open login page
            </a>
          )}
          {flow.deviceCode && (
            <div className="mt-2 inline-flex rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-zinc-100">
              {flow.deviceCode}
            </div>
          )}
          {flow.prompt && (
            <div className="mt-2 flex gap-2">
              <label className="sr-only" htmlFor="oauth-manual-value">
                {flow.prompt}
              </label>
              <input
                id="oauth-manual-value"
                value={manualValue}
                onChange={(e) => setManualValue(e.target.value)}
                placeholder={flow.prompt}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
              <button
                type="button"
                onClick={submitManualValue}
                disabled={saving === flow.provider || !manualValue.trim()}
                className="px-2 py-1 text-xs bg-indigo-500 text-ink rounded hover:bg-indigo-600 disabled:opacity-40"
              >
                Submit OAuth response
              </button>
            </div>
          )}
          {flow.error && <div className="mt-2 text-red-300">{flow.error}</div>}
        </div>
      )}
      {knownProviders.map((p) => {
        const status = providers.find((x) => x.id === p.id);
        const configured = status?.type === 'api_key' || status?.type === 'oauth';
        const supportsSubscription = subscriptionProviders.has(p.id);
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
                {supportsSubscription && (
                  <button
                    type="button"
                    onClick={() => startOAuth(p.id)}
                    disabled={saving === p.id}
                    aria-label={`Subscription login ${p.label}`}
                    className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded hover:bg-zinc-700 disabled:opacity-40"
                  >
                    Subscription login
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
