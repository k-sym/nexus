import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ArrowClockwise } from '@phosphor-icons/react';
import { fetchToolDecisions, type ToolDecisionEntry } from '../api';

/** Poll cadence while the view is open. Decisions accrue on human timescales. */
const POLL_MS = 5_000;

/** Colour the outcome — denied is the one to notice. */
const OUTCOME_CLASS: Record<string, string> = {
  allowed: 'text-emerald-400',
  denied: 'text-red-400',
};

/** A short, human phrase for how the decision was reached. */
function reachedBy(d: ToolDecisionEntry): string {
  if (d.answered_by === 'policy') return d.decision === 'deny' ? 'denied by policy' : 'allowed by policy';
  if (d.answered_by === 'timeout') return 'auto-denied (timed out)';
  if (d.answered_by === 'aborted') return 'aborted';
  return d.outcome === 'allowed' ? 'allowed by a human' : 'denied by a human';
}

/** Why the policy landed here — the rule, or the source layer. */
function becauseOf(d: ToolDecisionEntry): string {
  if (d.source === 'rule') return d.rule_when ? `rule (${d.rule_tool} · ${d.rule_when})` : `rule (${d.rule_tool})`;
  if (d.source === 'supervise') return 'Supervise';
  if (d.source === 'ungated') return 'always allowed';
  return d.source; // category | default
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

const shortCwd = (cwd: string) => cwd.split('/').filter(Boolean).pop() ?? '';

export default function ToolDecisionsView() {
  const [decisions, setDecisions] = useState<ToolDecisionEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDecisions(await fetchToolDecisions(200));
      setError(null);
    } catch {
      setDecisions([]);
      setError('Could not reach the backend.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-4xl mx-auto p-6 space-y-4">
        <div className="flex items-center gap-3">
          <ShieldCheck size={20} className="accent-text" />
          <h1 className="text-lg font-semibold text-zinc-100">Tool decisions</h1>
          <div className="flex-1" />
          <button onClick={() => { void load(); }} title="Refresh" className="text-zinc-500 hover:text-zinc-200 transition-colors">
            <ArrowClockwise size={16} />
          </button>
        </div>

        <p className="text-xs text-zinc-500 leading-relaxed">
          Every gated tool call the approval policy acted on — what was decided, why, and how it was answered.
          Routine reads that were simply allowed aren't listed.
        </p>

        {error && <div className="text-xs text-red-400 border-l-2 border-l-red-500 pl-2">{error}</div>}

        {!loaded ? (
          <div className="text-sm text-zinc-500 py-8 text-center">Loading…</div>
        ) : error ? null : decisions.length === 0 ? (
          <div className="text-sm text-zinc-500 py-8 text-center">No tool decisions recorded yet.</div>
        ) : (
          <div className="rounded-lg border border-zinc-800 divide-y divide-zinc-800/60">
            {decisions.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-xs">
                <span className={`shrink-0 font-medium ${OUTCOME_CLASS[d.outcome] ?? 'text-zinc-400'}`}>
                  {d.outcome === 'allowed' ? 'ran' : 'blocked'}
                </span>
                <span className="font-mono text-zinc-200 shrink-0">{d.tool_name}</span>
                <span className="text-zinc-400 font-mono truncate flex-1" title={d.input_summary}>{d.input_summary}</span>
                <span className="text-zinc-500 shrink-0 hidden sm:inline" title={`source: ${d.source}`}>{becauseOf(d)}</span>
                <span className="text-zinc-600 shrink-0">{reachedBy(d)}</span>
                {shortCwd(d.cwd) && <span className="text-zinc-600 shrink-0 hidden md:inline">{shortCwd(d.cwd)}</span>}
                <span className="text-zinc-600 shrink-0 w-14 text-right" title={d.created_at}>{timeAgo(d.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
