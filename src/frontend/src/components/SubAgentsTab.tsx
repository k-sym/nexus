import { useCallback, useEffect, useState } from 'react';
import { ArrowsClockwise, CaretDown, CaretRight } from '@phosphor-icons/react';
import type { RoleChildRunRecord } from '@nexus/shared';
import { api } from '../api';
import { keepIfSameJson } from '../lib/stable';
import { ChildWork, loadRoleChildWork, type RoleChildResponse } from './RoleChildBlock';

/** Poll cadence while the session or one of its children is running, and otherwise. */
const LIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 15_000;

interface SubAgentsTabProps {
  threadId: string | null;
  /** Whether the session's own run is live: children can start at any moment then. */
  running: boolean;
}

/** Every role child run of the open session, newest first, with the ledger
 *  detail the chat's inline role block leaves out: ids, timestamps and the
 *  reason a child stopped early. Reads `GET /api/threads/:id/runs`; a row's
 *  work comes from the same `GET /api/runs/:id/events` the chat block uses. */
export default function SubAgentsTab({ threadId, running }: SubAgentsTabProps) {
  const [runs, setRuns] = useState<RoleChildRunRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => { setRuns(null); setError(null); setExpandedId(null); }, [threadId]);

  const load = useCallback(async () => {
    if (!threadId) return;
    try {
      const { runs: next } = await api.roles.runs(threadId);
      setRuns((current) => keepIfSameJson(current, next));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load sub-agents.');
    }
  }, [threadId]);

  const live = running || (runs?.some((run) => run.status === 'running') ?? false);
  useEffect(() => {
    if (!threadId) return;
    void load();
    const timer = setInterval(() => void load(), live ? LIVE_POLL_MS : IDLE_POLL_MS);
    return () => clearInterval(timer);
  }, [threadId, load, live]);

  if (!threadId) return <Empty>Open a session to see its sub-agents.</Empty>;
  if (!runs) {
    return error
      ? <div role="alert" className="surface-panel rounded-md border border-subtle p-3 text-xs text-amber-200">{error} <button type="button" onClick={() => void load()} className="underline">Retry</button></div>
      : <Empty>Loading sub-agents…</Empty>;
  }
  if (runs.length === 0) return <Empty>No sub-agents have run in this session yet.</Empty>;

  const runningCount = runs.filter((run) => run.status === 'running').length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between px-1 text-[10px] text-faint">
        <span>{runs.length} {runs.length === 1 ? 'run' : 'runs'}{runningCount > 0 ? ` · ${runningCount} running` : ''}</span>
        <button type="button" onClick={() => void load()} title="Refresh sub-agents" className="flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors">
          <ArrowsClockwise size={12} /> Refresh
        </button>
      </div>
      {error && <div role="alert" className="surface-panel rounded-md border border-subtle p-2 text-[10px] text-amber-200">{error}</div>}
      {runs.map((run) => (
        <SubAgentRow
          key={run.childRunId}
          run={run}
          expanded={expandedId === run.childRunId}
          onToggle={() => setExpandedId((current) => current === run.childRunId ? null : run.childRunId)}
        />
      ))}
    </div>
  );
}

function Empty({ children }: { children: string }) {
  return <div className="py-6 text-center text-xs text-faint">{children}</div>;
}

const STATUS_CLASS: Record<RoleChildRunRecord['status'], string> = {
  running: 'text-indigo-300 border-indigo-500/40',
  completed: 'text-emerald-300 border-emerald-500/40',
  incomplete: 'text-amber-200 border-amber-500/40',
  interrupted: 'text-zinc-400 border-zinc-500/40',
};

/** Duration for a finished child; elapsed since start while it runs (the ledger only writes duration at the end). */
function elapsedMs(run: RoleChildRunRecord, now: number): number {
  if (run.status !== 'running') return run.durationMs;
  const started = Date.parse(run.startedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function stamp(value: string | null): string {
  return value ? value.replace('T', ' ').slice(0, 19) : '—';
}

/** The runner prefixes a report that stopped early with "INCOMPLETE: <reason>". */
export function splitReport(report: string | undefined): { reason: string | null; body: string } {
  const text = report ?? '';
  const match = /^INCOMPLETE: ([^\n]*)\n*/.exec(text);
  return match ? { reason: match[1], body: text.slice(match[0].length) } : { reason: null, body: text };
}

function SubAgentRow({ run, expanded, onToggle }: { run: RoleChildRunRecord; expanded: boolean; onToggle: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.status]);
  const { reason, body } = splitReport(run.report);
  const label = run.role[0].toUpperCase() + run.role.slice(1);

  return (
    <div className={`surface-panel rounded-md border transition-colors ${expanded ? 'border-strong' : 'border-subtle'}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="w-full text-left px-2.5 py-2">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-primary">{label}</span>
              <span className={`rounded border px-1 text-[10px] ${STATUS_CLASS[run.status]}`}>{run.status}</span>
            </div>
            <div className="mt-0.5 truncate text-[10px] text-faint" title={run.model}>{run.model}</div>
            <div className="mt-0.5 text-[10px] text-muted">
              {run.status === 'running' ? '… tokens' : `${run.tokens.toLocaleString()} tokens`} · {seconds(elapsedMs(run, now))} · {stamp(run.startedAt)}
            </div>
          </div>
          <span className="shrink-0 mt-0.5 text-faint" aria-hidden="true">
            {expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
          </span>
        </div>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-subtle px-2.5 py-2 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
            <dt className="text-faint">Started</dt><dd className="text-muted">{stamp(run.startedAt)}</dd>
            <dt className="text-faint">Finished</dt><dd className="text-muted">{stamp(run.completedAt)}</dd>
            <dt className="text-faint">Child run</dt><dd className="break-all font-mono text-muted">{run.childRunId}</dd>
            <dt className="text-faint">Parent run</dt><dd className="break-all font-mono text-muted">{run.parentRunId}</dd>
            <dt className="text-faint">Tool call</dt><dd className="break-all font-mono text-muted">{run.parentToolCallId}</dd>
          </dl>
          {reason && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200">Stopped early: {reason}</div>
          )}
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wider text-faint">Report</div>
            {body
              ? <div className="whitespace-pre-wrap break-words text-muted">{body}</div>
              : <div className="text-faint">{run.status === 'running' ? 'No report yet.' : 'No report.'}</div>}
          </div>
          <SubAgentWork childRunId={run.childRunId} status={run.status} />
        </div>
      )}
    </div>
  );
}

/** The child's retained tool timeline, fetched when the row opens and again on
 *  the live cadence while the child runs, so a delegation can be watched. */
function SubAgentWork({ childRunId, status }: { childRunId: string; status: RoleChildRunRecord['status'] }) {
  const [data, setData] = useState<RoleChildResponse>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    loadRoleChildWork(childRunId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setData(value); })
      .catch((err) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not load child work.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [childRunId, status, version]);

  useEffect(() => {
    if (status !== 'running') return;
    const timer = setInterval(() => setVersion((current) => current + 1), LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [status]);

  const toolCalls = data?.messages.flatMap((message) => message.tool_calls ?? []) ?? [];
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-faint">Work</span>
        {status === 'running' && <span className="text-[10px] text-indigo-300">live</span>}
      </div>
      {loading && !data && <p role="status" className="text-faint">Loading child work…</p>}
      {error && (
        <p role="alert" className="text-amber-200">{error} <button type="button" onClick={() => setVersion((current) => current + 1)} className="underline">Retry</button></p>
      )}
      {data && (
        !data.transcriptAvailable
          ? <p className="text-faint">Child transcript unavailable.</p>
          : toolCalls.length === 0
            ? <p className="text-faint">No tool calls recorded.</p>
            : <ChildWork toolCalls={toolCalls} />
      )}
    </div>
  );
}
