import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

interface UsagePageProps {
  /** Optional: scope usage to one project. Omitted from the top bar → aggregates across all projects. */
  projectId?: string;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (!ms) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const PROVIDER_LABELS: Record<string, string> = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  openrouter: 'OpenRouter',
  local: 'Local (omlx)',
  ollama: 'Local (legacy)',
};

export default function UsagePage({ projectId }: UsagePageProps) {
  const [usage, setUsage] = useState<any>(null);
  const [recent, setRecent] = useState<any[]>([]);

  const load = useCallback(async () => {
    try {
      const [u, status] = await Promise.all([
        api.agents.usage(projectId),
        api.agents.status(),
      ]);
      setUsage(u);
      setRecent(status.recent || []);
    } catch (err) {
      console.error('Failed to load usage:', err);
    }
  }, [projectId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 8000);
    return () => clearInterval(interval);
  }, [load]);

  const totals = usage?.totals || { runs: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, duration_ms: 0 };

  return (
    <div className="p-6 max-w-3xl mx-auto overflow-y-auto h-full">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Token Usage</h1>
        <p className="text-xs text-zinc-500 mt-0.5">
          Estimated for CLI agents; exact for API providers. {projectId ? 'Project-scoped.' : 'Across all projects.'}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        <StatCard label="Agent Runs" value={String(totals.runs)} />
        <StatCard label="Total Tokens" value={fmtTokens(totals.total_tokens)} />
        <StatCard label="Prompt / Completion" value={`${fmtTokens(totals.prompt_tokens)} / ${fmtTokens(totals.completion_tokens)}`} />
        <StatCard label="Compute Time" value={fmtDuration(totals.duration_ms)} />
      </div>

      {/* By provider */}
      {usage?.byProvider?.length > 0 && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 mb-6">
          <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">By Provider</h2>
          <div className="space-y-2">
            {usage.byProvider.map((p: any) => {
              const pct = totals.total_tokens > 0 ? (p.total_tokens / totals.total_tokens) * 100 : 0;
              return (
                <div key={p.provider}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-300">{PROVIDER_LABELS[p.provider] || p.provider}</span>
                    <span className="text-zinc-500">{fmtTokens(p.total_tokens)} · {p.runs} runs</span>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Recent runs */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Recent Runs (all projects)</h2>
        {recent.length === 0 ? (
          <p className="text-xs text-zinc-600">No agent runs yet.</p>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-[10px] uppercase tracking-wider text-zinc-600 pb-1 border-b border-zinc-800">
              <span>Task</span>
              <span className="text-right">Provider</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Time</span>
            </div>
            {recent.map((r: any) => (
              <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-3 text-xs py-1.5 items-center">
                <span className="truncate flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${r.status === 'completed' ? 'bg-green-500' : r.status === 'failed' ? 'bg-red-500' : 'bg-yellow-500'}`} />
                  <span className="text-zinc-300 truncate">{r.task_title}</span>
                </span>
                <span className="text-right text-zinc-500">{PROVIDER_LABELS[r.provider] || r.provider || '—'}</span>
                <span className="text-right text-zinc-400 font-mono">{fmtTokens(r.total_tokens || 0)}</span>
                <span className="text-right text-zinc-500">{fmtDuration(r.duration_ms || 0)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">{label}</div>
      <div className="text-lg font-semibold text-zinc-100">{value}</div>
    </div>
  );
}
