import { useState, useEffect, useCallback } from 'react';
import { Provider } from '@nexus/shared';
import { api } from '../api';
import { Plus, Trash, Stack } from '@phosphor-icons/react';

export default function OpenCodeModelsView() {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const list = await api.providers.list();
    const oc = list.find(p => p.kind === 'opencode') ?? null;
    setProvider(oc);
    setModels(oc?.models ?? []);
  }, []);
  useEffect(() => { load().catch(console.error); }, [load]);

  const persist = async (next: string[]) => {
    if (!provider) return;
    setModels(next);
    await api.providers.update(provider.id, { models: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const add = () => {
    const v = draft.trim();
    if (!v || models.includes(v)) { setDraft(''); return; }
    persist([...models, v]); setDraft('');
  };
  const remove = (m: string) => persist(models.filter(x => x !== m));

  if (!provider) {
    return (
      <div className="flex-1 p-6">
        <div className="text-sm text-zinc-500">No OpenCode provider found. Add one in <span className="text-zinc-300">Settings → Providers</span> (kind “OpenCode”).</div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 overflow-y-auto">
      <div className="max-w-xl">
        <div className="flex items-center gap-2 mb-1">
          <Stack size={18} className="text-indigo-400" />
          <h1 className="text-base font-semibold text-zinc-100">OpenCode Models</h1>
          {saved && <span className="text-[11px] text-emerald-400">saved</span>}
        </div>
        <p className="text-xs text-zinc-500 mb-4">Curated OpenCode model strings (e.g. <span className="font-mono text-zinc-400">openrouter/anthropic/claude-sonnet-4.5</span>). Selectable when a persona uses the OpenCode provider.</p>

        <div className="flex gap-2 mb-3">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') add(); }}
            placeholder="openrouter/anthropic/claude-sonnet-4.5"
            className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-indigo-500/50"
          />
          <button onClick={add} className="flex items-center gap-1 px-3 py-2 text-sm bg-indigo-500 text-white rounded hover:bg-indigo-600"><Plus size={14} /> Add</button>
        </div>

        <div className="space-y-1.5">
          {models.map(m => (
            <div key={m} className="flex items-center gap-3 bg-zinc-950 border border-zinc-800 rounded px-3 py-2">
              <span className="flex-1 text-sm font-mono text-zinc-200 truncate">{m}</span>
              <button onClick={() => remove(m)} title="Remove" className="text-zinc-600 hover:text-red-400"><Trash size={15} /></button>
            </div>
          ))}
          {models.length === 0 && <div className="text-xs text-zinc-600">No models yet — add one above.</div>}
        </div>
      </div>
    </div>
  );
}
