import { useState } from 'react';
import { PersonaConfig, Persona } from '@nexus/shared';
import { api } from '../api';

interface PersonaEditorProps {
  onClose: () => void;
  onCreated: (persona: Persona) => void;
}

const PROVIDERS: { value: PersonaConfig['provider']; label: string }[] = [
  { value: 'claude_code', label: 'Claude Code (CLI)' },
  { value: 'codex', label: 'Codex (CLI)' },
  { value: 'openrouter', label: 'OpenRouter (API)' },
  { value: 'local', label: 'Local (omlx / OpenAI-compatible)' },
];

const ALL_TOOLS = ['read_file', 'write_file', 'run_command', 'list_files', 'search', 'web_fetch'];

export default function PersonaEditor({ onClose, onCreated }: PersonaEditorProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [provider, setProvider] = useState<PersonaConfig['provider']>('openrouter');
  const [model, setModel] = useState('openrouter/anthropic/claude-sonnet-4');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>(['read_file', 'write_file']);
  const [workspace, setWorkspace] = useState('~/Projects/{project}');
  const [startupScripts, setStartupScripts] = useState('');
  const [tokenBudget, setTokenBudget] = useState('4000');

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slug || slug === name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) {
      setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    }
  };

  const toggleTool = (tool: string) => {
    setSelectedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;

    const config: PersonaConfig = {
      name: name.trim(),
      slug: slug.trim(),
      provider,
      model: model.trim(),
      system_prompt: systemPrompt.trim(),
      tools: selectedTools,
      workspace,
      startup_scripts: startupScripts.split('\n').map(s => s.trim()).filter(Boolean),
      token_budget: parseInt(tokenBudget, 10) || 4000,
    };

    try {
      const persona = await api.personas.create(config);
      onCreated(persona);
    } catch (err) {
      console.error('Failed to create persona:', err);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-2xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">New Persona</h2>
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
              <label className="block text-xs text-zinc-500 mb-1">Slug</label>
              <input
                type="text"
                value={slug}
                onChange={e => setSlug(e.target.value)}
                placeholder="reviewer"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Provider</label>
              <select
                value={provider}
                onChange={e => {
                  setProvider(e.target.value as PersonaConfig['provider']);
                  if (e.target.value === 'claude_code') setModel('claude-sonnet-4');
                  else if (e.target.value === 'codex') setModel('codex-default');
                  else if (e.target.value === 'openrouter') setModel('openrouter/anthropic/claude-sonnet-4');
                  else if (e.target.value === 'local') setModel('qwen2.5:14b');
                }}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/50"
              >
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">Model</label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="anthropic/claude-sonnet-4"
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
              />
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
            <button type="submit" disabled={!name.trim() || !slug.trim()} className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Create Persona
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
