import { useEffect, useRef, useState } from 'react';
import { parseRoleChildRun, type RoleChildRun } from '@nexus/shared';
import { apiFetch } from '../api-base';
import { approvalLabel, isQuestionTool, ToolCallTimeline, type ToolCallInfo } from './ToolCallTimeline';
import { QuestionCard } from './QuestionCard';
import { normalizeQuestionRequest, parseQuestionResult } from '../lib/questions';
import { registerApprovalSlot } from '../hooks/approval-slots';

export interface RoleChildResponse {
  child: RoleChildRun;
  transcriptAvailable: boolean;
  messages: Array<{ id: string; role: string; content?: string; tool_calls?: ToolCallInfo[] }>;
}

export function RoleChildBlock({ child, toolCall }: { child: RoleChildRun; toolCall: ToolCallInfo }) {
  const [expanded, setExpanded] = useState(child.role === 'refuter');
  const [workOpen, setWorkOpen] = useState(false);
  const [data, setData] = useState<RoleChildResponse>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const slot = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => registerApprovalSlot(child.childRunId, slot.current!), [child.childRunId]);
  useEffect(() => () => abort.current?.abort(), []);
  // A snapshot fetched while running must not become a permanent partial history.
  useEffect(() => { abort.current?.abort(); setLoading(false); setData(undefined); setWorkOpen(false); }, [child.childRunId, child.status]);
  const load = async () => {
    setWorkOpen(true);
    if (data || loading) return;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true); setError('');
    try {
      const response = await apiFetch(`/api/runs/${encodeURIComponent(child.childRunId)}/events`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not load child work (${response.status}).`);
      const value = await response.json() as RoleChildResponse;
      if (!parseRoleChildRun(value.child) || !Array.isArray(value.messages)) throw new Error('Invalid child transcript.');
      if (!controller.signal.aborted) setData(value);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load child work.');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  };
  // Older role results appended a metadata JSON line for the model. Strip only a
  // validated matching suffix, never arbitrary JSON in the child's actual report.
  let report = child.report ?? toolCall.result ?? '';
  if (child.report === undefined) {
    const split = report.lastIndexOf('\n\n');
    if (split >= 0) {
      try { if (parseRoleChildRun(JSON.parse(report.slice(split + 2)))?.childRunId === child.childRunId) report = report.slice(0, split); } catch { /* ordinary report text */ }
    }
  }
  const current = data?.child ?? child;
  return <section className="border-l-2 border-indigo-500/40 bg-zinc-900/40 rounded-r p-2 text-xs" aria-label={`${child.role} child run`}>
    <button type="button" aria-label={`${child.role} ${child.model} ${current.status}, ${current.tokens} tokens, ${(current.durationMs / 1000).toFixed(1)} seconds`} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="w-full text-left flex flex-wrap gap-2 text-zinc-300">
      <strong className="capitalize">{child.role}</strong><span>{child.model}</span>
      <span>{current.status}</span><span>{current.tokens.toLocaleString()} tokens</span>
      <span>{(current.durationMs / 1000).toFixed(1)}s</span>
    </button>
    <div ref={slot} />
    {toolCall.childApproval && <p>Child tool: {approvalLabel(toolCall.childApproval)}</p>}
    {expanded && <div className="mt-2 space-y-2">
      {report && <div className="whitespace-pre-wrap break-words text-zinc-300">{report}</div>}
      <button type="button" aria-expanded={workOpen} onClick={() => workOpen ? setWorkOpen(false) : void load()} className="text-indigo-300">{workOpen ? 'Hide work' : 'Show work'}</button>
      {workOpen && <div>
        {loading && <p role="status">Loading child work…</p>}
        {error && <p role="alert">{error} <button onClick={() => void load()}>Retry</button></p>}
        {data && (!data.transcriptAvailable ? <p>Child transcript unavailable. The saved report is shown above.</p> : <>
          {data.messages.flatMap(m => m.tool_calls ?? []).length === 0 && <p>No tool calls recorded.</p>}
          <ChildWork toolCalls={data.messages.flatMap(m => m.tool_calls ?? [])} />
        </>)}
      </div>}
    </div>}
  </section>;
}

/** The child's tool calls in order. ToolCallTimeline drops question calls (the
 *  parent bubble renders them as QuestionCards), so they are interleaved here
 *  read-only: the child's questions were answered in the parent thread. */
function ChildWork({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const runs: ToolCallInfo[][] = [];
  for (const tc of toolCalls) {
    const last = runs[runs.length - 1];
    if (last && !isQuestionTool(tc) && !isQuestionTool(last[0])) last.push(tc);
    else runs.push([tc]);
  }
  return <>{runs.map(run => {
    const tc = run[0];
    if (!isQuestionTool(tc)) return <ToolCallTimeline key={tc.id} toolCalls={run} />;
    const result = parseQuestionResult(tc.details) ?? parseQuestionResult(tc.result);
    return <QuestionCard key={tc.id} request={normalizeQuestionRequest(tc.args)!} answeredResult={result ?? undefined} unavailable={!result} onSubmit={() => Promise.resolve()} />;
  })}</>;
}
