import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import ProvidersSettings from './ProvidersSettings';

export default function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.settings.get();
      setConfig(data);
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = (path: string[], value: any) => {
    setConfig((prev: any) => {
      const next = structuredClone(prev);
      let node = next;
      for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
      node[path[path.length - 1]] = value;
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const payload = structuredClone(config);
      // Only send a new API key if the user typed one; otherwise leave masked.
      if (apiKeyInput.trim()) {
        payload.models.openrouter.api_key = apiKeyInput.trim();
      }
      const updated = await api.settings.update(payload);
      setConfig(updated);
      setApiKeyInput('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      alert(`Failed to save settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) {
    return <div className="p-6 text-zinc-500 text-sm">Loading settings…</div>;
  }

  return (
    <div className="p-6 max-w-2xl mx-auto overflow-y-auto h-full">
      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Edit ~/.nexus/config.yaml. Some changes require a backend restart.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {saved && <span className="text-xs text-green-400">Saved ✓</span>}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-indigo-500 text-white text-sm rounded-lg hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {/* Providers — first-class, addable, testable */}
        <ProvidersSettings />

        {/* Models (memory daemon + legacy fallback config) */}
        <Section title="Models">
          <Field label="OpenRouter API Key">
            <input
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder={config.models.openrouter.api_key || 'sk-or-...'}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              Current: <span className="font-mono">{config.models.openrouter.api_key || '(unset)'}</span>. Leave blank to keep unchanged.
            </p>
          </Field>
          <Field label="Local Server Base URL">
            <input
              type="text"
              value={config.models.local?.base_url ?? ''}
              onChange={e => update(['models', 'local', 'base_url'], e.target.value)}
              placeholder="http://localhost:8000/v1"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              OpenAI-compatible endpoint (omlx, LM Studio, llama.cpp…). Include the /v1 suffix.
            </p>
          </Field>
          <Field label="Local Server API Key">
            <input
              type="text"
              value={config.models.local?.api_key ?? ''}
              onChange={e => update(['models', 'local', 'api_key'], e.target.value)}
              placeholder="${OMLX_API_KEY} or paste a key"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              omlx requires this. Supports <span className="font-mono">{'${ENV_VAR}'}</span> interpolation.
            </p>
          </Field>
          <Field label="Embedding Model (optional)">
            <input
              type="text"
              value={config.models.local?.embedding_model ?? ''}
              onChange={e => update(['models', 'local', 'embedding_model'], e.target.value)}
              placeholder="leave blank to use lexical search"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
          <Field label="Reranker Model (optional)">
            <input
              type="text"
              value={config.models.local?.rerank_model ?? ''}
              onChange={e => update(['models', 'local', 'rerank_model'], e.target.value)}
              placeholder="leave blank to disable reranking"
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
        </Section>

        {/* Memory */}
        <Section title="Memory Auto-Injection">
          <Field label="Enabled">
            <button
              onClick={() => update(['memory', 'auto_inject', 'enabled'], !config.memory.auto_inject.enabled)}
              className={`px-3 py-1 text-xs rounded transition-colors ${config.memory.auto_inject.enabled ? 'bg-green-500/20 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}
            >
              {config.memory.auto_inject.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </Field>
          <Field label="Max memories injected">
            <input
              type="number"
              value={config.memory.auto_inject.max_memories}
              onChange={e => update(['memory', 'auto_inject', 'max_memories'], parseInt(e.target.value, 10) || 5)}
              className="w-32 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
          <Field label="Token budget">
            <input
              type="number"
              value={config.memory.auto_inject.token_budget}
              onChange={e => update(['memory', 'auto_inject', 'token_budget'], parseInt(e.target.value, 10) || 1000)}
              className="w-32 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
        </Section>

        {/* Scheduler */}
        <Section title="Scheduler">
          <Field label="Enabled">
            <button
              onClick={() => update(['scheduler', 'enabled'], !config.scheduler.enabled)}
              className={`px-3 py-1 text-xs rounded transition-colors ${config.scheduler.enabled ? 'bg-green-500/20 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}
            >
              {config.scheduler.enabled ? 'Enabled' : 'Disabled'}
            </button>
            <p className="text-[10px] text-zinc-600 mt-1">Requires backend restart to take effect.</p>
          </Field>
        </Section>

        {/* CLI commands */}
        <Section title="CLI Providers">
          <Field label="Claude Code command">
            <input
              type="text"
              value={config.claude_code.command}
              onChange={e => update(['claude_code', 'command'], e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
          <Field label="Codex command">
            <input
              type="text"
              value={config.codex.command}
              onChange={e => update(['codex', 'command'], e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 focus:outline-none focus:border-indigo-500/50"
            />
          </Field>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
      <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      {children}
    </div>
  );
}
