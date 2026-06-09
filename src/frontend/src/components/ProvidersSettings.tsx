import { useState, useEffect, useCallback } from 'react';
import { Provider, ProviderKind } from '@nexus/shared';
import { api, ProviderTestResult } from '../api';
import { Plus, Trash, PencilSimple, Plugs, SignIn, CheckCircle, XCircle, Spinner } from '@phosphor-icons/react';

const KINDS: { value: ProviderKind; label: string }[] = [
  { value: 'openai_compat', label: 'OpenAI-compatible (OpenRouter / local / omlx)' },
  { value: 'claude_code', label: 'Claude Code (CLI)' },
  { value: 'codex', label: 'Codex (CLI)' },
  { value: 'opencode', label: 'OpenCode (CLI)' },
  { value: 'hermes', label: 'Hermes (remote HTTP agent)' },
];

const blank: Partial<Provider> = { name: '', kind: 'openai_compat', base_url: '', api_key: '', default_model: '' };

export default function ProvidersSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Partial<Provider> | null>(null);
  const [tests, setTests] = useState<Record<string, ProviderTestResult | 'loading'>>({});

  const load = useCallback(async () => {
    try { setProviders(await api.providers.list()); } catch (e) { console.error(e); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const runTest = async (id: string) => {
    setTests(t => ({ ...t, [id]: 'loading' }));
    try {
      const res = await api.providers.test(id);
      setTests(t => ({ ...t, [id]: res }));
    } catch (e: any) {
      setTests(t => ({ ...t, [id]: { ok: false, detail: e.message } }));
    }
  };

  const save = async () => {
    if (!editing) return;
    try {
      if (editing.id) await api.providers.update(editing.id, editing);
      else await api.providers.create(editing);
      setEditing(null);
      await load();
    } catch (e: any) { alert(`Failed to save provider: ${e.message}`); }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this provider?')) return;
    try { await api.providers.delete(id); await load(); } catch (e) { console.error(e); }
  };

  // ── OAuth flow state ──
  interface AuthProvider {
    id: string; name: string; oauthSupported: boolean; loggedIn: boolean;
    hasCredential: boolean; credentialType: string | null;
  }
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [oauthFlow, setOauthFlow] = useState<{ providerId: string; status: 'starting' | 'waiting' | 'complete' | 'error' | 'cancelled'; message?: string; url?: string } | null>(null);

  const loadAuth = useCallback(async () => {
    try { const r = await api.auth.status(); setAuthProviders(r.providers); } catch (e) { console.error(e); }
  }, []);
  useEffect(() => { loadAuth(); }, [loadAuth]);

  const startOAuth = async (providerId: string) => {
    setOauthFlow({ providerId, status: 'starting' });
    try {
      await api.auth.startOAuth(providerId, (ev) => {
        if (ev.kind === 'auth_url') {
          setOauthFlow({ providerId, status: 'waiting', url: (ev as any).url, message: (ev as any).instructions });
          // Open the browser (Electron shell or web popup)
          const url = (ev as any).url as string;
          if (typeof window !== 'undefined' && (window as any).__TAURI__?.shell?.open) {
            (window as any).__TAURI__.shell.open(url);
          } else {
            window.open(url, '_blank');
          }
        } else if (ev.kind === 'progress') {
          setOauthFlow({ providerId, status: 'waiting', message: (ev as any).message });
        } else if (ev.kind === 'complete') {
          setOauthFlow({ providerId, status: 'complete' });
          setTimeout(() => setOauthFlow(null), 2000);
          loadAuth();
        } else if (ev.kind === 'cancelled') {
          setOauthFlow({ providerId, status: 'cancelled' });
          setTimeout(() => setOauthFlow(null), 2000);
        } else if (ev.kind === 'error') {
          setOauthFlow({ providerId, status: 'error', message: (ev as any).error });
        }
      });
    } catch (e: any) {
      setOauthFlow({ providerId, status: 'error', message: e.message });
    }
  };

  const cancelOAuth = async () => {
    try { await api.auth.cancelOAuth(); } catch {}
    setOauthFlow((f) => f ? { ...f, status: 'cancelled' } : null);
    setTimeout(() => setOauthFlow(null), 2000);
  };

  const logout = async (providerId: string) => {
    if (!confirm(`Sign out of ${providerId}?`)) return;
    try { await api.auth.logout(providerId); loadAuth(); } catch (e) { console.error(e); }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      {/* OAuth sign-in section */}
      <div className="mb-4">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">OAuth Sign-in</h2>
        <div className="space-y-2">
          {authProviders.filter(p => p.oauthSupported).map(p => {
            const flow = oauthFlow?.providerId === p.id ? oauthFlow : null;
            return (
              <div key={p.id} className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-200">{p.name}</span>
                    {p.loggedIn && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400">
                        <CheckCircle size={12} weight="fill" /> Signed in
                      </span>
                    )}
                  </div>
                  {flow && (
                    <div className="text-[11px] text-zinc-400 mt-0.5">
                      {flow.status === 'starting' && <><Spinner size={10} className="inline animate-spin mr-1" />Starting…</>}
                      {flow.status === 'waiting' && (flow.message || 'Waiting for browser…')}
                      {flow.status === 'complete' && <span className="text-emerald-400">✓ Signed in!</span>}
                      {flow.status === 'cancelled' && <span className="text-zinc-500">Cancelled</span>}
                      {flow.status === 'error' && <span className="text-red-400">✗ {flow.message}</span>}
                    </div>
                  )}
                </div>
                {flow?.status === 'waiting' ? (
                  <button onClick={cancelOAuth} className="text-xs text-zinc-400 hover:text-zinc-200">Cancel</button>
                ) : p.loggedIn ? (
                  <button onClick={() => logout(p.id)} className="text-xs text-zinc-400 hover:text-zinc-200">Sign out</button>
                ) : (
                  <button
                    onClick={() => startOAuth(p.id)}
                    disabled={flow?.status === 'starting' || flow?.status === 'complete'}
                    className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                  >
                    <SignIn size={12} /> Sign in
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Providers</h2>
        {!editing && (
          <button onClick={() => setEditing({ ...blank })} className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300">
            <Plus size={14} /> Add provider
          </button>
        )}
      </div>

      <div className="space-y-2">
        {providers.map(p => {
          const t = tests[p.id];
          return (
            <div key={p.id} className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200">{p.name}</span>
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">{p.kind}</span>
                </div>
                <div className="text-[11px] text-zinc-500 truncate">
                  {p.kind === 'openai_compat' ? (p.base_url || 'no base URL') : 'CLI'}
                  {p.default_model ? ` · ${p.default_model}` : ''}
                </div>
                {t && t !== 'loading' && (
                  <div className={`text-[11px] mt-0.5 ${t.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                    {t.ok ? '✓' : '✗'} {t.detail}{t.latencyMs != null ? ` · ${t.latencyMs}ms` : ''}
                  </div>
                )}
              </div>
              <button onClick={() => runTest(p.id)} title="Test connectivity" className="shrink-0 flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded px-2 py-1">
                <Plugs size={13} /> {t === 'loading' ? '…' : 'Test'}
              </button>
              <button onClick={() => setEditing(p)} title="Edit" className="shrink-0 text-zinc-500 hover:text-zinc-200"><PencilSimple size={15} /></button>
              <button onClick={() => remove(p.id)} title="Delete" className="shrink-0 text-zinc-600 hover:text-red-400"><Trash size={15} /></button>
            </div>
          );
        })}
        {providers.length === 0 && <div className="text-xs text-zinc-600">No providers yet.</div>}
      </div>

      {editing && (
        <div className="mt-3 border-t border-zinc-800 pt-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500/70">{editing.id ? 'Edit provider' : 'New provider'}</div>
          <input
            value={editing.name ?? ''}
            onChange={e => setEditing({ ...editing, name: e.target.value })}
            placeholder="Name (e.g. Local Qwen 14B)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <select
            value={editing.kind}
            onChange={e => setEditing({ ...editing, kind: e.target.value as ProviderKind })}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm text-zinc-200 focus:outline-none"
          >
            {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          {(editing.kind === 'openai_compat' || editing.kind === 'hermes') && (
            <>
              <input
                value={editing.base_url ?? ''}
                onChange={e => setEditing({ ...editing, base_url: e.target.value })}
                placeholder="Base URL incl. /v1 (e.g. http://127.0.0.1:4002/v1)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
              <input
                value={editing.api_key ?? ''}
                onChange={e => setEditing({ ...editing, api_key: e.target.value })}
                placeholder="API key (optional; supports ${ENV_VAR})"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
            </>
          )}
          <input
            value={editing.default_model ?? ''}
            onChange={e => setEditing({ ...editing, default_model: e.target.value })}
            placeholder="Default model (optional)"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          {(editing.kind === 'claude_code' || editing.kind === 'codex') && (
            <textarea
              value={(editing.models ?? []).join('\n')}
              onChange={e => setEditing({ ...editing, models: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) })}
              placeholder={'Models (one per line)\nopus\nsonnet\nhaiku'}
              rows={3}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50 resize-none"
            />
          )}
          {editing.kind === 'opencode' && (
            <>
              <div className="text-[11px] text-zinc-500">Models for OpenCode are curated in the <span className="text-zinc-300">OpenCode Models</span> view.</div>
              <input
                value={editing.args ?? ''}
                onChange={e => setEditing({ ...editing, args: e.target.value })}
                placeholder="Extra CLI args (optional, e.g. --agent build)"
                className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1.5 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
              />
            </>
          )}
          <div className="flex gap-2">
            <button onClick={save} className="px-3 py-1.5 text-sm bg-indigo-500 text-ink rounded hover:bg-indigo-600">Save provider</button>
            <button onClick={() => setEditing(null)} className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
