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
    <div className="surface-glass rounded-xl border border-subtle p-4">
      <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">{title}</div>
      {children}
    </div>
  );
}

type UsageWindow = { usedPercent: number; remainingPercent: number; resetLabel?: string; windowMinutes?: number };
type UsageStat = {
  ok: boolean;
  value: string;
  caption: string;
  windows?: Partial<Record<'session' | 'weekly', UsageWindow>>;
  source?: string;
  sampledAt?: string;
  error?: string;
};

function windowReserveText(window: UsageWindow) {
  if (window.usedPercent > 100) return `${window.usedPercent - 100}% in deficit`;
  return `${window.remainingPercent}% in reserve`;
}

function updatedLabel(sampledAt?: string) {
  if (!sampledAt) return null;
  const sampled = new Date(sampledAt).valueOf();
  if (!Number.isFinite(sampled)) return null;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - sampled) / 1000));
  if (elapsedSeconds < 60) return 'Updated just now';
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `Updated ${elapsedMinutes} min ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Updated ${elapsedHours} hr ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  return `Updated ${elapsedDays} day${elapsedDays === 1 ? '' : 's'} ago`;
}

function UsageWindowRow({ label, window }: { label: string; window: UsageWindow }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-zinc-200">{label}</span>
        {window.resetLabel && <span className="text-[11px] text-faint">Resets {window.resetLabel}</span>}
      </div>
      <div className="h-1.5 rounded-full bg-[var(--surface-hover)] overflow-hidden">
        <div className="h-full bg-cyan-500" style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
      </div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted">
        <span>{window.usedPercent}% used</span>
        <span>{windowReserveText(window)}</span>
      </div>
    </div>
  );
}

function UsageCard({ title, stat, fallback }: {
  title: string;
  stat?: UsageStat;
  fallback: string;
}) {
  const value = stat?.value ?? '—';
  const caption = stat?.caption ?? fallback;
  const source = stat?.source === 'history' || stat?.source === 'history-cache' || stat?.source === 'claude-statusline-cache'
    ? 'cached'
    : stat?.source;
  const windows = stat?.windows;
  const updated = updatedLabel(stat?.sampledAt);

  return (
    <Card title={title}>
      {windows?.session || windows?.weekly ? (
        <div className="space-y-3">
          {windows.session && <UsageWindowRow label="Session" window={windows.session} />}
          {windows.weekly && <UsageWindowRow label="Weekly" window={windows.weekly} />}
        </div>
      ) : (
        <>
          <div className={`text-2xl font-semibold ${stat?.ok ? 'text-primary' : 'text-faint'}`}>{value}</div>
          <div className="text-xs text-muted mt-1">{caption}</div>
        </>
      )}
      {updated && <div className="text-[10px] text-faint mt-2">{updated}</div>}
      {source && <div className="text-[10px] text-faint mt-1">{source}</div>}
      {!stat?.ok && stat?.error && <div className="text-[10px] text-faint mt-1 truncate" title={stat.error}>{stat.error}</div>}
    </Card>
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
      className="text-left surface-glass border border-subtle rounded-lg p-4 hover:border-[var(--border-strong)] transition-colors"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="flex items-center gap-2 font-medium text-zinc-200">
          <span className={`w-2 h-2 rounded-full ${m.configured ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
          {m.name}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-faint">
          {m.configured ? 'configured' : 'no auth'}
        </span>
      </div>
      <div className="text-xs text-muted truncate">
        {m.provider} · {m.id}
      </div>
      <div className="text-[11px] text-faint mt-1 truncate">
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
  const stats = status?.stats;

  return (
    <div className="flex-1 overflow-y-auto">
      <header className="surface-glass flex items-center justify-between px-6 py-4 border-b border-subtle">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2"><Gauge size={22} weight="fill" /> Mission Control</h1>
          <p className="text-xs text-faint">Status of every agent, every memory, every signal.</p>
        </div>
        <button
          onClick={onRefresh}
          className="px-3 py-1.5 text-sm text-muted hover:text-[var(--text-primary)] border border-subtle rounded-md hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] transition-colors"
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </header>

      {!status ? (
        <div className="p-6 text-sm text-faint">{loading ? 'Loading status…' : 'No status available.'}</div>
      ) : (
        <div className="p-6 space-y-6">
          {/* Status strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Card title="Memory">
              {mem?.ok ? (
                <>
                  <div className="text-2xl font-semibold text-primary">{mem.memories ?? 0}</div>
                  <div className="text-xs text-muted mt-1">
                    memories · {mem.jobs?.pending ?? 0} pending · {mem.jobs?.dead ?? 0} dead
                  </div>
                  {models && (
                    <div className="flex gap-3 mt-2 text-[11px] text-muted">
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
              <div className="text-2xl font-semibold text-primary">
                {configuredModels}/{totalModels}
              </div>
              <div className="text-xs text-muted mt-1">
                active models · available
              </div>
            </Card>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">Stats</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <UsageCard title="Claude Stats" stat={stats?.claude} fallback="codexbar session · 5h rolling" />
              <UsageCard title="Codex Stats" stat={stats?.codex} fallback="codexbar session · weekly" />
              <UsageCard title="OpenRouter Stats" stat={stats?.openrouter} fallback="codexbar credit balance" />
            </div>
          </div>

          {/* Agent roster — now a model list. Each row shows provider,
              id, and whether auth is configured. */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-2">Models</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {(status.models ?? []).map((m) => (
                <ModelCard key={`${m.provider}/${m.id}`} m={m} onClick={() => onSelectAgent(m.id)} />
              ))}
              {(status.models ?? []).length === 0 && <div className="text-sm text-faint">No models available.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
