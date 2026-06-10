/**
 * ModelSelector — a compact `provider/id` picker.
 *
 * Opens a small portal-mounted dropdown above (or below, depending on
 * viewport position) the trigger button. The list is filtered by a
 * free-text search; selection calls back with `(provider, id)`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretUp, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { modelKey, type ModelInfo, parseModelKey } from '../hooks/useModels';

interface ModelSelectorProps {
  models: ModelInfo[];
  currentModelId?: string;
  onSelect: (provider: string, modelId: string) => void;
  /** Optional: mark unavailable (e.g. for picking a model on dispatch). */
  disabled?: boolean;
}

function providerShort(provider: string): string {
  return provider.replace(/-(api|ai|platform|provider)$/i, '').split('-')[0];
}

export function ModelSelector({ models, currentModelId, onSelect, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<'above' | 'below'>('above');

  const current = useMemo(() => {
    if (!currentModelId) return undefined;
    return models.find((m) => modelKey(m.provider, m.id) === currentModelId);
  }, [models, currentModelId]);

  const recalcPlacement = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const above = rect.top > 320;
    setPlacement(above ? 'above' : 'below');
  }, []);

  useEffect(() => {
    if (!open) return;
    recalcPlacement();
    function close(e: MouseEvent) {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        !(e.target as HTMLElement).closest('[data-model-dropdown]')
      ) {
        setOpen(false);
      }
    }
    function onScroll() {
      recalcPlacement();
    }
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, recalcPlacement]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [models, query]);

  const label = current?.name ?? 'Pick a model';

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((p) => !p)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
      >
        <span className="max-w-[180px] truncate">{label}</span>
        {current && (
          <span className="text-[10px] text-zinc-500">{providerShort(current.provider)}</span>
        )}
        <CaretUp className={`w-3 h-3 transition-transform ${open ? '' : 'rotate-180'}`} />
      </button>
      {open && (
        <div
          data-model-dropdown
          className={`fixed z-50 w-72 rounded-md border border-zinc-700 bg-zinc-950 shadow-lg ${
            placement === 'above' ? 'mb-1' : 'mt-1'
          }`}
          style={
            placement === 'above'
              ? (() => {
                  const rect = triggerRef.current?.getBoundingClientRect();
                  return rect
                    ? {
                        left: Math.min(rect.left, window.innerWidth - 296),
                        bottom: window.innerHeight - rect.top + 4,
                        width: 288,
                      }
                    : {};
                })()
              : (() => {
                  const rect = triggerRef.current?.getBoundingClientRect();
                  return rect
                    ? {
                        left: Math.min(rect.left, window.innerWidth - 296),
                        top: rect.bottom + 4,
                        width: 288,
                      }
                    : {};
                })()
          }
        >
          <div className="border-b border-zinc-800 p-2">
            <div className="relative">
              <MagnifyingGlass className="absolute left-2 top-1.5 w-3 h-3 text-zinc-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full rounded-sm bg-zinc-900 border border-zinc-800 pl-7 pr-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600"
              />
            </div>
          </div>
          <div data-testid="model-dropdown-list" className="max-h-72 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="p-3 text-center text-xs text-zinc-500">
                {models.length === 0
                  ? 'No curated models enabled. Open Settings to enable models.'
                  : 'No models match.'}
              </div>
            ) : (
              filtered.map((m) => {
                const key = modelKey(m.provider, m.id);
                const isCurrent = key === currentModelId;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      onSelect(m.provider, m.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-900"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{m.name}</span>
                      <span className="block text-[10px] text-zinc-500 truncate">
                        {providerShort(m.provider)} · {m.id}
                        {m.configured === false ? ' · no auth' : ''}
                      </span>
                    </span>
                    {isCurrent && <Check className="w-3 h-3 text-indigo-400" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { parseModelKey };
