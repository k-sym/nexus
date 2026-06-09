/**
 * ZosmaAuthSection — auth UI for the Zosma sign-in panel in Settings.
 *
 * The Zosma sidecar is gone; the pi runtime is the new engine, but
 * the auth model is the same: one AuthStorage file, multiple
 * providers. Each row shows the credential state and a sign-in /
 * sign-out button.
 *
 * OAuth providers (Anthropic, OpenAI Codex, GitHub Copilot) get an
 * "OAuth" button that currently returns 501 from the backend — the
 * PKCE loopback flow is a follow-up. API-key providers (Anthropic,
 * OpenAI, OpenCode Go, OpenRouter, etc.) get an input + Save.
 */
import { useMemo, useState } from 'react';
import { useZosmaAuth } from '../hooks/useZosmaAuth';

interface ProviderSpec {
  id: string;
  label: string;
  supportsApiKey: boolean;
  supportsOauth: boolean;
}

const PROVIDERS: ProviderSpec[] = [
  { id: 'anthropic', label: 'Anthropic (Claude)', supportsApiKey: true, supportsOauth: true },
  { id: 'openai-codex', label: 'OpenAI Codex', supportsApiKey: true, supportsOauth: true },
  { id: 'opencode-go', label: 'OpenCode Go', supportsApiKey: true, supportsOauth: false },
  { id: 'openrouter', label: 'OpenRouter', supportsApiKey: true, supportsOauth: false },
];

export function ZosmaAuthSection() {
  const { status, loading, saving, error, saveKey, logout } = useZosmaAuth();
  const [keyByProvider, setKeyByProvider] = useState<Record<string, string>>({});

  const known = useMemo(() => {
    const map = new Map<string, { type: 'api_key' | 'oauth' }>();
    for (const p of status.providers) map.set(p.id, { type: p.type });
    return map;
  }, [status]);

  return (
    <div className="space-y-4" data-testid="zosma-auth-section">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">Zosma sign-in</h3>
        <p className="text-xs text-zinc-500 mt-1">
          One shared <code className="text-zinc-400">~/.nexus/auth.json</code> for chat, the orchestrator, and the model selector.
        </p>
      </div>

      {loading ? (
        <div className="text-xs text-zinc-500">Loading…</div>
      ) : (
        <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded-lg">
          {PROVIDERS.map((p) => {
            const entry = known.get(p.id);
            return (
              <li key={p.id} className="px-3 py-2 flex items-center gap-2" data-testid={`auth-row-${p.id}`}>
                <span className="w-44 text-sm text-zinc-200 shrink-0">{p.label}</span>
                <span className="text-xs text-zinc-500 flex-1 min-w-0">
                  {entry
                    ? entry.type === 'oauth'
                      ? 'Signed in (OAuth)'
                      : 'API key saved'
                    : 'Not configured'}
                </span>
                {entry && (
                  <button
                    onClick={() => logout(p.id)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Sign out
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="space-y-2">
        <h4 className="text-xs font-semibold text-zinc-300">Add or update an API key</h4>
        {PROVIDERS.filter((p) => p.supportsApiKey).map((p) => (
          <div key={p.id} className="flex items-center gap-2" data-testid={`auth-form-${p.id}`}>
            <span className="w-32 text-xs text-zinc-400 shrink-0">{p.label}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyByProvider[p.id] ?? ''}
              onChange={(e) => setKeyByProvider((s) => ({ ...s, [p.id]: e.target.value }))}
              placeholder={known.has(p.id) ? '••• (saved)' : 'API key'}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
            />
            <button
              onClick={async () => {
                const key = (keyByProvider[p.id] ?? '').trim();
                if (!key) return;
                const ok = await saveKey(p.id, key);
                if (ok) setKeyByProvider((s) => ({ ...s, [p.id]: '' }));
              }}
              disabled={saving || !(keyByProvider[p.id] ?? '').trim()}
              className="px-2.5 py-1 text-xs bg-indigo-500 text-ink rounded disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        ))}
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}
