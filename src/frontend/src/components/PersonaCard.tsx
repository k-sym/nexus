import { Persona, PersonaConfig, Provider } from '@nexus/shared';
import { useState, useEffect } from 'react';
import { PencilSimple, Trash, CaretDown, CaretUp } from '@phosphor-icons/react';
import { api } from '../api';

interface PersonaCardProps {
  persona: Persona;
  onDelete: (slug: string) => void;
  onEdit: (slug: string) => void;
  onRefresh: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  openrouter: 'OpenRouter',
  local: 'Local (omlx)',
  ollama: 'Local (legacy)',
};

export default function PersonaCard({ persona, onDelete, onEdit, onRefresh }: PersonaCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [config, setConfig] = useState<PersonaConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => { api.providers.list().then(setProviders).catch(() => {}); }, []);

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.personas.get(persona.slug);
      setConfig(data);
      setExpanded(true);
    } catch (err) {
      console.error('Failed to load persona:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden">
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer hover:bg-zinc-900/50 transition-colors"
        onClick={handleExpand}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-2 h-2 rounded-full bg-indigo-500 shrink-0" />
          <span className="text-sm font-medium truncate">{persona.name}</span>
          <span className="text-[10px] bg-zinc-800/50 text-zinc-500 px-2 py-0.5 rounded shrink-0">{persona.slug}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {loading && <span className="text-xs text-zinc-500">Loading...</span>}
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(persona.slug); }}
            className="flex items-center gap-1 text-xs text-zinc-300 hover:text-white border border-zinc-700 hover:border-zinc-600 rounded px-2 py-1 transition-colors"
          >
            <PencilSimple size={13} /> Edit
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(persona.slug); }}
            title="Remove agent"
            className="text-zinc-600 hover:text-red-400 transition-colors"
          >
            <Trash size={15} />
          </button>
          <span className="text-zinc-500">{expanded ? <CaretUp size={14} /> : <CaretDown size={14} />}</span>
        </div>
      </div>

      {expanded && config && (
        <div className="px-4 py-3 border-t border-zinc-800 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {(() => {
              const rec = config.provider_id ? providers.find(p => p.id === config.provider_id) : undefined;
              const providerLabel = rec ? rec.name : (PROVIDER_LABELS[config.provider] || config.provider);
              const effectiveModel = config.model || rec?.default_model || '';
              return (
                <>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500">Provider</label>
                    <div className="text-xs mt-0.5">{providerLabel}</div>
                  </div>
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-zinc-500">Model</label>
                    <div className="text-xs mt-0.5 font-mono">{effectiveModel || <span className="text-zinc-600">provider default</span>}</div>
                  </div>
                </>
              );
            })()}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Token Budget</label>
              <div className="text-xs mt-0.5">{config.token_budget}</div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Tools</label>
              <div className="flex flex-wrap gap-1 mt-0.5">
                {config.tools.map(tool => (
                  <span key={tool} className="text-[10px] bg-zinc-800/50 text-zinc-500 px-1.5 py-0.5 rounded">{tool}</span>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">System Prompt</label>
            <pre className="text-xs bg-zinc-900 p-2 rounded mt-0.5 whitespace-pre-wrap max-h-32 overflow-y-auto font-mono text-zinc-500">
              {config.system_prompt}
            </pre>
          </div>

          {config.startup_scripts.length > 0 && (
            <div>
              <label className="text-[10px] uppercase tracking-wider text-zinc-500">Startup Scripts</label>
              <div className="space-y-1 mt-0.5">
                {config.startup_scripts.map((script, i) => (
                  <div key={i} className="text-xs bg-zinc-900 px-2 py-1 rounded font-mono text-zinc-500">{script}</div>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-[10px] uppercase tracking-wider text-zinc-500">Workspace</label>
            <div className="text-xs font-mono mt-0.5 text-zinc-500">{config.workspace}</div>
          </div>
        </div>
      )}
    </div>
  );
}
