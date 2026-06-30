import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { PiAuthSection } from './PiAuthSection';
import { ModelCurationSection } from './ModelCurationSection';
import { TrustPrivacySection } from './TrustPrivacySection';
import { getBackgroundMotion, setBackgroundMotion, type BackgroundMotion } from '../appearance';

const MOTION_OPTIONS: { mode: BackgroundMotion; label: string }[] = [
  { mode: 'off', label: 'Off' },
  { mode: 'on', label: 'Smooth' },
  { mode: 'low', label: 'Battery saver' },
];

export default function SettingsPage() {
  const [config, setConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testingLocalModel, setTestingLocalModel] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState<{ ok: boolean; message: string } | null>(null);
  // Appearance prefs are local-only (localStorage) and apply instantly, so they
  // live outside the config object and the Save Changes flow.
  const [motion, setMotion] = useState<BackgroundMotion>(getBackgroundMotion);

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
      window.dispatchEvent(new Event('nexus:models-refresh'));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      alert(`Failed to save settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleTestLocalModel = async () => {
    setTestingLocalModel(true);
    setLocalModelStatus(null);
    try {
      const local = config.models.local ?? {};
      const result = await api.settings.testLocalModel({
        base_url: local.base_url ?? '',
        api_key: local.api_key ?? '',
        chat_model: local.chat_model ?? '',
      });
      setLocalModelStatus({ ok: result.ok, message: result.message });
    } catch (err: any) {
      setLocalModelStatus({ ok: false, message: err?.message || 'Local model test failed.' });
    } finally {
      setTestingLocalModel(false);
    }
  };

  if (loading || !config) {
    return <div className="p-6 text-faint text-sm">Loading settings…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl mx-auto">
        <div className="sticky top-0 z-10 -mx-6 px-6 py-4 mb-6 flex items-center justify-between gap-4 surface-glass border-b border-subtle">
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
          <Section title="Appearance">
            <Field label="Animated background">
              <div className="inline-flex rounded overflow-hidden border border-subtle">
                {MOTION_OPTIONS.map(({ mode, label }) => (
                  <button
                    key={mode}
                    onClick={() => {
                      setMotion(mode);
                      setBackgroundMotion(mode);
                    }}
                    className={`px-3 py-1 text-xs transition-colors ${motion === mode ? 'bg-green-500/20 text-green-400' : 'surface-elevated text-faint'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-faint mt-1">
                Drifts and twinkles the starfield. <span className="text-muted">Off</span> (default) shows
                the static starfield with zero animation cost. <span className="text-muted">Smooth</span> is
                full 60fps. <span className="text-muted">Battery saver</span> keeps the motion but steps it
                to ~5fps — near-identical, far less GPU. Applies instantly and pauses when the window
                isn't focused.
              </p>
            </Field>
          </Section>

          <Section title="Provider Auth">
            <PiAuthSection />
          </Section>

          <Section title="Assistant">
            <Field label="Assistant URL">
              <input
                type="text"
                value={config.assistant?.url ?? ''}
                onChange={(e) => update(['assistant', 'url'], e.target.value)}
                placeholder="https://assistant.example.com/v1"
                className="w-full surface-panel border border-subtle rounded px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              />
              <p className="text-[10px] text-faint mt-1">
                Remote OpenAI-compatible assistant endpoint for Hermes, OpenClaw, or similar.
              </p>
            </Field>
            <Field label="Key">
              <input
                type="text"
                value={config.assistant?.api_key ?? ''}
                onChange={(e) => update(['assistant', 'api_key'], e.target.value)}
                placeholder="${ASSISTANT_API_KEY} or paste a key"
                className="w-full surface-panel border border-subtle rounded px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              />
              <p className="text-[10px] text-faint mt-1">
                Supports <span className="font-mono">{'${ASSISTANT_API_KEY}'}</span>. Existing saved keys are masked on load.
              </p>
            </Field>
          </Section>

          <Section title="Curated Models">
            <ModelCurationSection />
          </Section>

          {/* Local server config — kept here because it's an env-style
              detail that doesn't fit a per-provider API key. */}
          <Section title="Local Model Server">
            <Field label="Base URL">
              <input
                aria-label="Base URL"
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
                aria-label="API key"
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
            <Field label="Chat model id">
              <input
                aria-label="Chat model id"
                type="text"
                value={config.models.local?.chat_model ?? ''}
                onChange={(e) => update(['models', 'local', 'chat_model'], e.target.value)}
                placeholder="qwen2.5-coder:7b"
                className="w-full surface-panel border border-subtle rounded px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              />
              <p className="text-[10px] text-faint mt-1">
                Saved as <span className="font-mono">local/&lt;model id&gt;</span> in the curated model list.
              </p>
            </Field>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleTestLocalModel}
                disabled={testingLocalModel}
                className="px-3 py-1.5 text-xs rounded surface-elevated text-muted hover:text-primary border border-subtle disabled:opacity-40 transition-colors"
              >
                {testingLocalModel ? 'Testing…' : 'Test local model'}
              </button>
              {localModelStatus && (
                <span className={`text-xs ${localModelStatus.ok ? 'text-green-400' : 'text-red-400'}`}>
                  {localModelStatus.message}
                </span>
              )}
            </div>
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
            <Field label="Content strip rules">
              <div className="space-y-2">
                {((config.jira.content_rules ?? []) as string[]).map((rule: string, i: number) => (
                  <div key={i} className="flex gap-2">
                    <textarea
                      value={rule}
                      onChange={(e) => {
                        const next = [...((config.jira.content_rules ?? []) as string[])];
                        next[i] = e.target.value;
                        update(['jira', 'content_rules'], next);
                      }}
                      rows={3}
                      placeholder="Paste a footer chunk to strip from every ticket..."
                      className="flex-1 surface-panel border border-subtle rounded px-2 py-1 text-sm text-primary font-mono resize-y"
                    />
                    <button
                      onClick={() => {
                        const next = ((config.jira.content_rules ?? []) as string[]).filter((_: string, j: number) => j !== i);
                        update(['jira', 'content_rules'], next);
                      }}
                      title="Remove rule"
                      className="shrink-0 px-2 py-1 text-xs surface-elevated text-faint hover:text-red-400 rounded transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  onClick={() => update(['jira', 'content_rules'], [...((config.jira.content_rules ?? []) as string[]), ''])}
                  className="px-3 py-1 text-xs surface-elevated text-faint hover:text-primary rounded transition-colors"
                >
                  + Add rule
                </button>
                <p className="text-[10px] text-faint">
                  Pasted text is removed from every ticket preview (ignores whitespace and case). Use{' '}
                  <span className="font-mono text-muted">***</span> for parts that vary between tickets, e.g. a tracking URL.
                </p>
              </div>
            </Field>
            <p className="text-xs text-faint">
              The API token is read from the <span className="font-mono text-muted">JIRA_TOKEN</span> environment
              variable, never stored here. Changes apply on the next backend restart.
            </p>
          </Section>

          {/* GitHub */}
          <Section title="GitHub">
            <Field label="Issue sync">
              <button
                onClick={() => update(['github', 'enabled'], !config.github?.enabled)}
                className={`px-3 py-1 text-xs rounded transition-colors ${config.github?.enabled ? 'bg-green-500/20 text-green-400' : 'surface-elevated text-faint'}`}
              >
                {config.github?.enabled ? 'Enabled' : 'Disabled'}
              </button>
            </Field>
            <Field label="Token">
              <span className={`text-sm ${config.github_token_detected ? 'text-green-400' : 'text-faint'}`}>
                {config.github_token_detected ? 'detected' : 'not detected'}
              </span>
            </Field>
            <p className="text-xs text-faint">
              The API token is read from the <span className="font-mono text-muted">GITHUB_TOKEN</span> environment
              variable in <span className="font-mono text-muted">.env</span>, never stored here. A token is optional
              for public repositories. Changes apply on the next backend restart.
            </p>
          </Section>

          <TrustPrivacySection />
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
