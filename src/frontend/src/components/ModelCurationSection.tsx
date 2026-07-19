import { useMemo, useState } from 'react';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { modelKey, useModels } from '../hooks/useModels';

function providerLabel(provider: string): string {
  return provider
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function ModelCurationSection() {
  const { allModels, enabledModelKeys, customized, saveCuration, loading } = useModels();
  const [query, setQuery] = useState('');
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [bulkSaving, setBulkSaving] = useState(false);
  const enabledSet = useMemo(() => new Set(enabledModelKeys), [enabledModelKeys]);
  const configuredModels = useMemo(() => allModels.filter((model) => model.configured !== false), [allModels]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return configuredModels;
    return configuredModels.filter((model) =>
      [model.name, model.id, model.provider].some((value) => value.toLowerCase().includes(q)),
    );
  }, [configuredModels, query]);

  const toggle = async (key: string) => {
    setSavingKey(key);
    try {
      const next = enabledSet.has(key)
        ? enabledModelKeys.filter((item) => item !== key)
        : [...enabledModelKeys, key];
      await saveCuration(next);
    } finally {
      setSavingKey(null);
    }
  };

  const saveAll = async (keys: string[]) => {
    setBulkSaving(true);
    try {
      await saveCuration(keys);
    } finally {
      setBulkSaving(false);
    }
  };

  if (loading) return <div className="text-xs text-zinc-500">Loading models…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          {enabledModelKeys.length} enabled · {configuredModels.length} configured · {allModels.length} total
          {!customized ? ' · using configured models until customized' : ''}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void saveAll([])}
            disabled={bulkSaving || enabledModelKeys.length === 0}
            className="rounded-sm border border-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
          >
            Deselect all
          </button>
          <button
            type="button"
            onClick={() => void saveAll(configuredModels.map((model) => modelKey(model.provider, model.id)))}
            disabled={bulkSaving || enabledModelKeys.length === configuredModels.length}
            className="rounded-sm border border-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 disabled:opacity-40"
          >
            Select all
          </button>
          <div className="relative w-56">
            <MagnifyingGlass className="absolute left-2 top-2 w-3 h-3 text-zinc-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models…"
              className="w-full rounded-sm bg-zinc-950 border border-zinc-800 pl-7 pr-2 py-1.5 text-xs text-zinc-200 focus:outline-hidden focus:border-indigo-500/50"
            />
          </div>
        </div>
      </div>
      <div className="max-h-96 overflow-y-auto rounded-sm border border-zinc-800 divide-y divide-zinc-800">
        {filtered.map((model) => {
          const key = modelKey(model.provider, model.id);
          const enabled = enabledSet.has(key);
          return (
            <label key={key} className="flex items-center gap-3 px-3 py-2 hover:bg-zinc-950/70">
              <input
                type="checkbox"
                role="switch"
                aria-label={`${model.name} ${model.provider}`}
                checked={enabled}
                disabled={savingKey === key}
                onChange={() => void toggle(key)}
                className="h-4 w-4 accent-indigo-500"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-zinc-200 truncate">{model.name}</span>
                <span className="block text-[10px] text-zinc-500 truncate">
                  {providerLabel(model.provider)} · {model.id}
                  {model.configured === false ? ' · no auth' : ''}
                </span>
              </span>
            </label>
          );
        })}
        {filtered.length === 0 && <div className="p-4 text-center text-xs text-zinc-500">No models match.</div>}
      </div>
    </div>
  );
}
