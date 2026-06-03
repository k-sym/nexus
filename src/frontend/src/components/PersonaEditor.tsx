import { useState, useEffect } from 'react';
import { PersonaConfig, Persona, Provider } from '@nexus/shared';
import { api } from '../api';

interface PersonaEditorProps {
  onClose: () => void;
  onCreated: (persona: Persona) => void;
  /** when set, the editor edits this persona instead of creating a new one */
  initial?: PersonaConfig;
}

const ALL_TOOLS = ['read_file', 'write_file', 'run_command', 'list_files', 'search', 'web_fetch'];

/** Best-effort legacy provider enum from a Provider record (back-compat fallback). */
function legacyEnum(p?: Provider): PersonaConfig['provider'] {
  if (!p) return 'openrouter';
  if (p.kind === 'claude_code') return 'claude_code';
  if (p.kind === 'codex') return 'codex';
  return /openrouter\.ai/.test(p.base_url || '') ? 'openrouter' : 'local';
}

export default function PersonaEditor({ onClose, onCreated, initial }: PersonaEditorProps) {
  const editing = !!initial;
  const [providers, setProviders] = useState<Provider[]>([]);
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState(initial?.slug ?? '');
  const [providerId, setProviderId] = useState(initial?.provider_id ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [customModel, setCustomModel] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState(initial?.system_prompt ?? '');
  const [selectedTools, setSelectedTools] = useState<string[]>(initial?.tools ?? ['read_file', 'write_file']);
  const [workspace, setWorkspace] = useState(initial?.workspace ?? '~/Projects/{project}');
  const [startupScripts, setStartupScripts] = useState((initial?.startup_scripts ?? []).join('\n'));
  const [tokenBudget, setTokenBudget] = useState(String(initial?.token_budget ?? 4000));

  useEffect(() => {
    api.providers.list().then(list => {
      setProviders(list);
      setProviderId(prev => {
        if (prev) return prev;
        // No provider_id (legacy persona) — match its old enum to a provider.
        const legacy = initial?.provider;
        const match = list.find(p =>
          legacy === 'claude_code' ? p.kind === 'claude_code'
          : legacy === 'codex' ? p.kind === 'codex'
          : legacy === 'openrouter' ? p.kind === 'openai_compat' && /openrouter\.ai/.test(p.base_url || '')
          : (legacy === 'local' || legacy === 'ollama') ? p.kind === 'openai_compat' && !/openrouter\.ai/.test(p.base_url || '')
          : false,
        );
        return match?.id || list[0]?.id || '';
      });
      // Leave model blank for new personas → "use provider default" (no snapshot).
    }).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!editing && (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  };

  // Don't copy the provider's model into the persona — leaving the model blank
  // means "use the provider's model", so later provider edits propagate live.
  const onProviderChange = (id: string) => { setProviderId(id); setModel(''); setCustomModel(false); };
  const selectedProvider = providers.find(p => p.id === providerId);

  const toggleTool = (tool: string) =>
    setSelectedTools(prev => (prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;
    const selected = providers.find(p => p.id === providerId);
    const config: PersonaConfig = {
      name: name.trim(),
      slug: slug.trim(),
      provider: legacyEnum(selected),
      provider_id: providerId || undefined,
      model: model.trim(),
      system_prompt: systemPrompt.trim(),
      tools: selectedTools,
      workspace,
      startup_scripts: startupScripts.split('\n').map(s => s.trim()).filter(Boolean),
      token_budget: parseInt(tokenBudget, 10) || 4000,
    };
    try {
      onCreated(await api.personas.create(config));
    } catch (err) {
      console.error('Failed to save persona:', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">{editing ? `Edit Agent — ${initial!.name}` : 'New Agent'}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                placeholder="Code Reviewer"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Slug{editing ? ' (fixed)' : ''}</label>
              <input
                type="text"
                value={slug}
                onChange={e => setSlug(e.target.value)}
                disabled={editing}
                placeholder="reviewer"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Provider</label>
              <select
                value={providerId}
                onChange={e => onProviderChange(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
              >
                {providers.length === 0 && <option value="">No providers — add one in Settings</option>}
                {providers.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Model</label>
              {customModel || (selectedProvider?.models?.length ?? 0) === 0 ? (
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder={selectedProvider?.default_model ? `${selectedProvider.default_model} (provider default)` : 'model id'}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
                />
              ) : (
                <select
                  value={model}
                  onChange={e => { if (e.target.value === '__custom__') { setCustomModel(true); setModel(''); } else setModel(e.target.value); }}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
                >
                  <option value="">Provider default{selectedProvider?.default_model ? ` (${selectedProvider.default_model})` : ''}</option>
                  {selectedProvider!.models.map(m => <option key={m} value={m}>{m}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
              )}
              <p className="text-[10px] text-zinc-600 mt-1">Leave on “Provider default” to track the provider's model live.</p>
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">System Prompt</label>
            <textarea
              value={systemPrompt}
              onChange={e => setSystemPrompt(e.target.value)}
              placeholder="You are a..."
              rows={4}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600/40 resize-none focus:outline-none focus:border-indigo-500/50 font-mono"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Tools</label>
            <div className="flex flex-wrap gap-2">
              {ALL_TOOLS.map(tool => (
                <button
                  key={tool}
                  type="button"
                  onClick={() => toggleTool(tool)}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${selectedTools.includes(tool) ? 'border-indigo-500 bg-indigo-500/20 text-white' : 'border-zinc-800 text-zinc-500 hover:text-zinc-200'}`}
                >
                  {tool}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Workspace Path</label>
            <input
              type="text"
              value={workspace}
              onChange={e => setWorkspace(e.target.value)}
              placeholder="~/Projects/{project}"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Startup Scripts (one per line)</label>
            <textarea
              value={startupScripts}
              onChange={e => setStartupScripts(e.target.value)}
              placeholder="git fetch origin&#10;npm install"
              rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 resize-none focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1">Token Budget</label>
            <input
              type="number"
              value={tokenBudget}
              onChange={e => setTokenBudget(e.target.value)}
              className="w-32 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-200 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || !slug.trim()} className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {editing ? 'Save Agent' : 'Create Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
