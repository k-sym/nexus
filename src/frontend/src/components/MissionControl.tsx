import { Gauge } from '@phosphor-icons/react';
import { MissionStatus } from '../api';

interface MissionControlProps {
  status: MissionStatus | null;
  loading: boolean;
  onRefresh: () => void;
  onSelectAgent: (slug: string) => void;
}

function StatDot({ ok }: { ok: boolean }) {
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-zinc-600'}`} />;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-zinc-900 rounded-xl p-4">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500/70 font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

interface ModelRow {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  configured: boolean;
}

function ModelCard({ m, onClick }: { m: ModelRow; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-zinc-900 border border-zinc-800 rounded-lg p-4 hover:border-zinc-700 transition-colors"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-2 font-medium text-zinc-200">
          <span className={`w-2 h-2 rounded-full ${m.configured ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
          {m.name}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          {m.configured ? 'configured' : 'no auth'}
        </span>
      </div>
      <div className="text-xs text-zinc-500 truncate">
        {m.provider} · {m.id}
      </div>
      <div className="text-[11px] text-zinc-600 mt-1 truncate">
        {m.contextWindow ? `${m.contextWindow.toLocaleString()} ctx` : ''}
        {m.maxTokens ? ` · ${m.maxTokens.toLocaleString()} max` : ''}
      </div>
    </button>
  );
}

export default function MissionControl({ status, loading, onRefresh, onSelectAgent }: MissionControlProps) {
  const configuredModels = (status?.models ?? []).filter((m) => m.configured).length;
  const totalModels = (status?.models ?? []).length;
  const mem = status?.memory;
  const models = mem?.models;

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Gauge size={22} weight="fill" /> Mission Control</h1>
          <p className="text-xs text-zinc-500">Status of every agent, every memory, every signal.</p>
        </div>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </header>

      {!status ? (
        <div className="p-6 text-sm text-zinc-500">{loading ? 'Loading status…' : 'No status available.'}</div>
      ) : (
        <div className="p-6 space-y-6">
          {/* Status strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card title="Memory">
              {mem?.ok ? (
                <>
                  <div className="text-2xl font-semibold text-zinc-100">{mem.memories ?? 0}</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    memories · {mem.jobs?.pending ?? 0} pending · {mem.jobs?.dead ?? 0} dead
                  </div>
                  {models && (
                    <div className="flex gap-3 mt-2 text-[11px] text-zinc-500">
                      <span className="flex items-center gap-1"><StatDot ok={models.gen} /> gen</span>
                      <span className="flex items-center gap-1"><StatDot ok={models.embed} /> embed</span>
                      <span className="flex items-center gap-1"><StatDot ok={models.rerank} /> rerank</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-red-400">daemon down{mem?.error ? ` · ${mem.error}` : ''}</div>
              )}
            </Card>

            <Card title="Models">
              <div className="text-2xl font-semibold text-zinc-100">
                {configuredModels}/{totalModels}
              </div>
              <div className="text-xs text-zinc-500 mt-1">
                pi runtime models · auth-configured
              </div>
            </Card>
          </div>

          {/* Agent roster — now a model list. Each row shows provider,
              id, and whether auth is configured. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-2">Models</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(status.models ?? []).map((m) => (
                <ModelCard key={`${m.provider}/${m.id}`} m={m} onClick={() => onSelectAgent(m.id)} />
              ))}
              {(status.models ?? []).length === 0 && <div className="text-sm text-zinc-600">No models available.</div>}
            </div>
          </div>

          {/* Recent activity */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-2">Recent activity</div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg divide-y divide-zinc-800">
              {status.activity.running.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="flex items-center gap-2 text-zinc-300 truncate">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    {r.task_title}
                  </span>
                  <span className="text-xs text-zinc-500 shrink-0">{r.provider} · running</span>
                </div>
              ))}
              {status.activity.recent.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-zinc-400 truncate">{r.task_title}</span>
                  <span className="text-xs text-zinc-600 shrink-0">
                    {r.provider} · {r.status}
                    {r.total_tokens ? ` · ${r.total_tokens} tok` : ''}
                  </span>
                </div>
              ))}
              {status.activity.running.length === 0 && status.activity.recent.length === 0 && (
                <div className="px-4 py-6 text-sm text-zinc-600 text-center">No agent activity yet.</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
