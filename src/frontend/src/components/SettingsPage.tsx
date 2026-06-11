import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { PiAuthSection } from './PiAuthSection';
import { ModelCurationSection } from './ModelCurationSection';

export default function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
      const updated = await api.settings.update(config);
      setConfig(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      alert(`Failed to save settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !config) {
    return <div className="p-6 text-faint text-sm">Loading settings…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-center justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-faint mt-0.5">Edit ~/.nexus/config.yaml. Some changes require a backend restart.</p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {saved && <span className="text-xs text-green-400">Saved ✓</span>}
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 accent-button text-sm rounded-lg disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>

        <div className="space-y-6">
          <Section title="Provider Auth">
            <PiAuthSection />
          </Section>

          <Section title="Curated Models">
            <ModelCurationSection />
          </Section>

          {/* Local server config — kept here because it's an env-style
              detail that doesn't fit a per-provider API key. */}
          <Section title="Local Model Server">
            <Field label="Base URL">
              <input
                type="text"
                value={config.models.local?.base_url ?? ''}
                onChange={(e) => update(['models', 'local', 'base_url'], e.target.value)}
                placeholder="http://localhost:8000/v1"
                className="w-full surface-panel border border-subtle rounded px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              />
              <p className="text-[10px] text-faint mt-1">
                OpenAI-compatible endpoint (omlx, LM Studio, llama.cpp…). Include the /v1 suffix.
              </p>
            </Field>
            <Field label="API key (env)">
              <input
                type="text"
                value={config.models.local?.api_key ?? ''}
                onChange={(e) => update(['models', 'local', 'api_key'], e.target.value)}
                placeholder="${OMLX_API_KEY} or paste a key"
                className="w-full surface-panel border border-subtle rounded px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              />
              <p className="text-[10px] text-faint mt-1">
                omlx requires this. Supports <span className="font-mono">{'${ENV_VAR}'}</span> interpolation.
              </p>
            </Field>
          </Section>

          {/* Memory */}
          <Section title="Memory Auto-Injection">
            <Field label="Enabled">
              <button
                onClick={() => update(['memory', 'auto_inject', 'enabled'], !config.memory.auto_inject.enabled)}
                className={`px-3 py-1 text-xs rounded transition-colors ${config.memory.auto_inject.enabled ? 'bg-green-500/20 text-green-400' : 'surface-elevated text-faint'}`}
              >
                {config.memory.auto_inject.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </Field>
            <Field label="Max memories injected">
              <input
                type="number"
                value={config.memory.auto_inject.max_memories}
                onChange={(e) => update(['memory', 'auto_inject', 'max_memories'], parseInt(e.target.value, 10) || 5)}
                className="w-32 surface-panel border border-subtle rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-strong"
              />
            </Field>
            <Field label="Token budget">
              <input
                type="number"
                value={config.memory.auto_inject.token_budget}
                onChange={(e) => update(['memory', 'auto_inject', 'token_budget'], parseInt(e.target.value, 10) || 1000)}
                className="w-32 surface-panel border border-subtle rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-strong"
              />
            </Field>
          </Section>

          {/* Jira */}
          <Section title="Jira">
            <Field label="Sync">
              <button
                onClick={() => update(['jira', 'enabled'], !config.jira.enabled)}
                className={`px-3 py-1 text-xs rounded transition-colors ${config.jira.enabled ? 'bg-green-500/20 text-green-400' : 'surface-elevated text-faint'}`}
              >
                {config.jira.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </Field>
            <Field label="Account email">
              <input
                type="text"
                value={config.jira.user}
                onChange={(e) => update(['jira', 'user'], e.target.value)}
                placeholder="you@example.com"
                className="w-full surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary"
              />
            </Field>
            <Field label="Instance host">
              <input
                type="text"
                value={config.jira.instance}
                onChange={(e) => update(['jira', 'instance'], e.target.value)}
                placeholder="your-company.atlassian.net (https:// optional)"
                className="w-full surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary"
              />
            </Field>
            <Field label="Project key">
              <input
                type="text"
                value={config.jira.project}
                onChange={(e) => update(['jira', 'project'], e.target.value)}
                placeholder="SUP"
                className="w-full surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary"
              />
            </Field>
            <Field label="Poll interval (minutes)">
              <input
                type="number"
                min={1}
                value={config.jira.poll_minutes}
                onChange={(e) => update(['jira', 'poll_minutes'], parseInt(e.target.value, 10) || 15)}
                className="w-full surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary"
              />
            </Field>
            <p className="text-xs text-faint">
              The API token is read from the <span className="font-mono text-muted">JIRA_TOKEN</span> environment
              variable, never stored here. Changes apply on the next backend restart.
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="surface-glass border border-subtle rounded-lg p-4">
      <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-faint mb-1">{label}</label>
      {children}
    </div>
  );
}
