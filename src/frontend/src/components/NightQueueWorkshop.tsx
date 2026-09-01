import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { armGate } from './nightQueueArmGate';
// useIdeaThread is generic over the session id despite its name — it was
// written for #352's idea dialogue but speaks only the per-session assistant
// endpoints, so a workshop conversation is the same shape. Renaming it would
// churn IdeasView for no functional gain; flagged as a follow-up instead.
import { useIdeaThread } from '../hooks/useIdeaThread';
import {
  api,
  AssessmentResponse,
  NightQueueCandidate,
  NightQueueCandidatesResponse,
  ReadinessResponse,
} from '../api';

// The night queue's front door (baker-internal#111). Until this existed, an
// issue entered the queue by Keith minting a label after a conversation held
// in a chat window, judged against a bar written inside a prompt nobody could
// read — and the verdict arrived at 07:05 the next morning as "parked, below
// the readiness bar".
//
// Three things this view is careful about:
//
//   * Blocked candidates are SHOWN, greyed, with the reason. A list that
//     silently omits an issue teaches you it does not exist; one that says
//     "PR #212 already implements this" teaches you where the work went.
//   * `unblocked` never reads as "ready". Nothing in the list has been judged
//     until you open it — the bar costs a model call per issue.
//   * Arm stays disabled while the draft still contains a `<TODO:`. The
//     adapter refuses those anyway; the button mirrors the refusal so you
//     find out before the round trip, not after.

const UNRESOLVED = '<TODO';

const BLOCKED_LABEL: Record<string, string> = {
  excluded: 'policy',
  queued: 'queued',
  open_pr: 'PR open',
};

const STATUS_STYLE: Record<string, string> = {
  met: 'text-emerald-400',
  missing: 'text-amber-400',
  na: 'text-zinc-500',
};

function relativeAgo(ts: number | null | undefined): string {
  if (!ts) return '';
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function CandidateRow({
  c, active, onSelect,
}: { c: NightQueueCandidate; active: boolean; onSelect: () => void }) {
  const blocked = c.blocked !== null;
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 border-b border-subtle transition-colors ${
        active ? 'bg-[var(--surface-hover)]' : 'hover:bg-[var(--surface-hover)]'
      } ${blocked ? 'opacity-55' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-zinc-200 truncate">
          {c.repo}#{c.number}
        </span>
        {c.blocked && (
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400 shrink-0">
            {BLOCKED_LABEL[c.blocked] ?? c.blocked}
          </span>
        )}
        <span className="text-[11px] text-faint ml-auto shrink-0">{relativeAgo(c.updated_ts)}</span>
      </div>
      <div className="text-[11px] text-muted truncate">{c.title}</div>
      {c.blocked === 'open_pr' && c.open_pr && (
        <div className="text-[11px] text-faint">
          PR #{c.open_pr.number} already implements this
        </div>
      )}
      {c.blocked === 'excluded' && (
        <div className="text-[11px] text-faint">never runs unattended by standing policy</div>
      )}
    </button>
  );
}

/**
 * The conversation before arming. An ordinary Partner session, seeded
 * server-side (baker-internal#131) with the readiness bar and the issue's own
 * prose inside its fence — the client never builds that fence, because a
 * second spelling of it would be an injection path into the arming decision.
 *
 * The Partner drafts and argues; it cannot arm. Its seed says so, there is no
 * act-tool for it, and the Arm button below is unaffected by anything said
 * here except through the draft the two of you agree on.
 */
function Dialogue({
  candidate, draft, onApplyDraft,
}: {
  candidate: NightQueueCandidate;
  draft: string;
  onApplyDraft: (next: string) => void;
}) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const thread = useIdeaThread(sessionId);

  // A different issue is a different conversation. Dropping the session id
  // here is what stops the pane showing issue A's discussion under issue B.
  useEffect(() => {
    setSessionId(null);
    setError(null);
    setInput('');
  }, [candidate.repo, candidate.number]);

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      // The working draft travels, so the Partner argues about the text on
      // screen rather than the assessor's first attempt.
      const got = await api.nightQueue.discuss(candidate.repo, candidate.number, draft);
      // `discuss` returns an ADAPTER session id, and the per-session chat
      // endpoints are keyed by NEXUS ids — adoption is the bridge, the same
      // one iOS uses via AssistantAdoptingView. Driving the raw adapter id
      // through them 404s, which is exactly what it did before this line.
      const adopted = await api.assistant.importRemote(got.session_id);
      setSessionId(adopted.session.id);
    } catch (err: any) {
      setError(err?.message || 'Could not open the conversation.');
    } finally {
      setOpening(false);
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || thread.isRunning) return;
    setInput('');
    await thread.send(text);
  };

  if (!sessionId) {
    return (
      <div>
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-1">
          Talk it over
        </div>
        <button
          onClick={open}
          disabled={opening}
          className="px-3 py-1.5 text-sm rounded-md border border-subtle hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
        >
          {opening ? 'Opening…' : 'Discuss with the Partner'}
        </button>
        {error && <div className="text-xs text-red-400 mt-1">{error}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-1">
        Talk it over — the Partner can draft, but only you can arm
      </div>
      <div className="rounded-md border border-subtle max-h-72 overflow-y-auto p-2 space-y-2">
        {thread.messages.length === 0 && !thread.loading && (
          <div className="text-[11px] text-faint">
            It has the issue, the readiness bar and your current draft. Ask what is missing.
          </div>
        )}
        {thread.messages.map((m: any, i: number) => (
          <div key={m.id ?? i} className="text-xs">
            <span className={m.role === 'user' ? 'text-zinc-400' : 'text-emerald-400'}>
              {m.role === 'user' ? 'you' : 'partner'}
            </span>
            <div className="text-zinc-200 whitespace-pre-wrap">{m.content}</div>
            {m.role === 'assistant' && typeof m.content === 'string' && m.content.includes('**Goal:**') && (
              // The conversation's product is the readiness comment, so lift a
              // proposed one straight into the draft rather than making Keith
              // copy it across and risk transcribing it wrong.
              <button
                onClick={() => onApplyDraft(m.content)}
                className="mt-1 text-[11px] text-sky-400 hover:underline"
              >
                Use this as the readiness comment
              </button>
            )}
          </div>
        ))}
        {thread.isRunning && <div className="text-[11px] text-faint">thinking…</div>}
        {thread.error && <div className="text-[11px] text-red-400">{thread.error}</div>}
      </div>
      <div className="flex gap-2 mt-2">
        <input
          aria-label="Message the Partner"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="What is missing from this spec?"
          className="flex-1 text-xs px-2 py-1.5 rounded-md bg-[var(--surface-sunken,rgba(0,0,0,0.25))] border border-subtle text-zinc-200"
        />
        <button
          onClick={() => void send()}
          disabled={!input.trim() || thread.isRunning}
          className="px-3 py-1.5 text-xs rounded-md border border-subtle hover:bg-[var(--surface-hover)] disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function Workshop({
  candidate, readiness, onArmed,
}: {
  candidate: NightQueueCandidate;
  readiness: ReadinessResponse | null;
  onArmed: () => void;
}) {
  const [assessment, setAssessment] = useState<AssessmentResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'assess' | 'arm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);

  const key = `${candidate.repo}#${candidate.number}`;
  // Which candidate the panel is CURRENTLY showing. An assessment takes tens
  // of seconds, so the user can easily switch issues while one is in flight;
  // the closure that started it still holds the old candidate, so the answer
  // has to be checked against this rather than against itself.
  const showing = useRef(key);

  // A new candidate must never inherit the previous one's verdict or draft.
  useEffect(() => {
    showing.current = key;
    setAssessment(null);
    setDraft('');
    setError(null);
    setArmed(null);
    // Also clear `busy`: an assessment abandoned mid-flight would otherwise
    // leave the next issue's panel stuck on a disabled "Assessing…".
    setBusy(null);
  }, [key]);

  const assess = async () => {
    const requestedFor = key;
    setBusy('assess');
    setError(null);
    try {
      const got = await api.nightQueue.assess(candidate.repo, candidate.number);
      // Drop a verdict the user has moved on from. Without this the panel
      // shows issue A's criteria and draft under issue B's heading — and Arm
      // takes the repo from B and the comment from A, which would post A's
      // spec onto B and label it.
      if (showing.current !== requestedFor) return;
      setAssessment(got);
      setDraft(got.draft_comment ?? '');
    } catch (err: any) {
      if (showing.current !== requestedFor) return;
      setError(err?.message || 'Assessment failed.');
    } finally {
      if (showing.current === requestedFor) setBusy(null);
    }
  };

  const unresolved = draft.includes(UNRESOLVED);
  // Every refusal rule lives in armGate, tested without a DOM — all three bugs
  // found while driving this view lived in this decision when it was an inline
  // boolean. iOS has the same logic as NexusCore's ArmGate (nexus#403).
  const gate = armGate(candidate, assessment, draft);

  const arm = async () => {
    setBusy('arm');
    setError(null);
    try {
      const got = await api.nightQueue.arm(candidate.repo, candidate.number, draft);
      setArmed(got.url);
      onArmed();
    } catch (err: any) {
      setError(err?.message || 'Arming failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-5 space-y-4 overflow-y-auto">
      <div>
        <div className="flex items-center gap-2">
          <a href={candidate.url} target="_blank" rel="noreferrer"
             className="text-sm font-semibold text-zinc-100 hover:underline">
            {candidate.repo}#{candidate.number}
          </a>
          {candidate.blocked && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400">
              {BLOCKED_LABEL[candidate.blocked] ?? candidate.blocked}
            </span>
          )}
        </div>
        <div className="text-sm text-muted">{candidate.title}</div>
      </div>

      {candidate.blocked === 'open_pr' && candidate.open_pr && (
        <div className="text-xs px-3 py-2 rounded-md bg-amber-500/10 text-amber-300">
          <a href={candidate.open_pr.url} target="_blank" rel="noreferrer" className="underline">
            PR #{candidate.open_pr.number}
          </a>{' '}
          already implements this ({candidate.open_pr.reason.replace('_', ' ')}). Arming would
          duplicate work already awaiting review.
        </div>
      )}
      {candidate.blocked === 'excluded' && (
        <div className="text-xs px-3 py-2 rounded-md bg-zinc-700/30 text-zinc-400">
          Standing policy: the unattended agent never modifies its own runtime or the approval
          surface it reports through. Work this in a daytime session.
        </div>
      )}
      {candidate.blocked === 'queued' && (
        <div className="text-xs px-3 py-2 rounded-md bg-emerald-500/10 text-emerald-300">
          Already labelled — this is in tonight's queue.
        </div>
      )}

      {!assessment && (
        <div className="space-y-2">
          {readiness?.criteria?.length ? (
            <div className="text-xs text-muted space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-faint font-medium">
                What the 01:00 planner will require
              </div>
              {readiness.criteria.map((c) => (
                <div key={c.id}>
                  <span className="text-zinc-300">{c.label}</span>
                  {c.conditional && <span className="text-faint"> · {c.conditional}</span>}
                  <div className="text-faint">{c.requirement}</div>
                </div>
              ))}
            </div>
          ) : null}
          <button
            onClick={assess}
            disabled={busy !== null}
            className="px-3 py-1.5 text-sm rounded-md border border-subtle hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] disabled:opacity-50"
          >
            {busy === 'assess' ? 'Assessing…' : 'Assess against the bar'}
          </button>
        </div>
      )}

      {assessment && (
        <>
          <div
            className={`text-xs px-3 py-2 rounded-md ${
              assessment.ready ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300'
            }`}
          >
            <span className="font-semibold">{assessment.ready ? 'Meets the bar' : 'Below the bar'}</span>
            {assessment.summary ? ` — ${assessment.summary}` : ''}
          </div>

          <div className="space-y-1">
            {assessment.criteria.map((c) => (
              <div key={c.id} className="text-xs">
                <span className={`font-semibold ${STATUS_STYLE[c.status] ?? 'text-zinc-400'}`}>
                  {c.status === 'na' ? 'n/a' : c.status}
                </span>{' '}
                <span className="text-zinc-300">{c.label}</span>
                <div className="text-faint pl-1">{c.note}</div>
              </div>
            ))}
          </div>

          <Dialogue candidate={candidate} draft={draft} onApplyDraft={setDraft} />

          <div>
            <div className="text-[10px] uppercase tracking-wider text-faint font-medium mb-1">
              Readiness comment — posted to the issue when you arm
            </div>
            <textarea
              aria-label="Readiness comment"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="w-full h-64 text-xs font-mono p-3 rounded-md bg-[var(--surface-sunken,rgba(0,0,0,0.25))] border border-subtle text-zinc-200"
            />
            {unresolved && (
              <div className="text-[11px] text-amber-400 mt-1">
                This draft still contains a <code>&lt;TODO:&gt;</code>. Decide it before arming —
                an unattended agent reading a TODO will either guess or park.
              </div>
            )}
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}
          {armed && (
            <div className="text-xs text-emerald-300">
              Armed. The readiness comment is posted and the label minted —{' '}
              <a href={armed} target="_blank" rel="noreferrer" className="underline">
                see the issue
              </a>
              . It is in tonight's 01:00 run.
            </div>
          )}

          {!armed && (
            <button
              onClick={arm}
              disabled={!gate.canArm || busy !== null}
              title={gate.reason ?? undefined}
              className="px-3 py-1.5 text-sm rounded-md bg-emerald-600/80 hover:bg-emerald-600 text-white disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy === 'arm' ? 'Arming…' : 'Post comment and arm for tonight'}
            </button>
          )}
        </>
      )}

      {error && !assessment && <div className="text-xs text-red-400">{error}</div>}
    </div>
  );
}

export default function NightQueueWorkshop() {
  const [report, setReport] = useState<NightQueueCandidatesResponse | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [cands, bar] = await Promise.all([
        api.nightQueue.candidates(),
        api.nightQueue.readiness(),
      ]);
      setReport(cands);
      setReadiness(bar);
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load candidates.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = report?.candidates ?? [];
  const active = useMemo(
    () => candidates.find((c) => `${c.repo}#${c.number}` === selected) ?? null,
    [candidates, selected],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="surface-glass flex items-center justify-between px-6 py-4 border-b border-subtle">
        <div>
          <h1 className="text-xl font-semibold">Night Queue</h1>
          <p className="text-xs text-faint">
            Work an issue up to the readiness bar, then arm it for tonight&apos;s 01:00 run.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="px-3 py-1.5 text-sm text-muted hover:text-[var(--text-primary)] border border-subtle rounded-md hover:border-[var(--border-strong)] transition-colors"
        >
          ↻ Refresh
        </button>
      </header>

      {error && <div className="px-6 py-3 text-sm text-red-400">{error}</div>}
      {report?.configured === false && (
        <div className="px-6 py-3 text-sm text-faint">
          Configure the assistant URL and key in Settings to use the workshop.
        </div>
      )}
      {report?.error && (
        <div className="px-6 py-3 text-sm text-amber-400/90">
          {report.stale ? 'Showing the last known list · ' : ''}
          {report.error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="w-80 border-r border-subtle overflow-y-auto shrink-0">
          <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-faint font-medium">
            {report ? `${report.unblocked ?? 0} unblocked · ${candidates.length} open` : 'Loading…'}
          </div>
          {candidates.map((c) => (
            <CandidateRow
              key={`${c.repo}#${c.number}`}
              c={c}
              active={selected === `${c.repo}#${c.number}`}
              onSelect={() => setSelected(`${c.repo}#${c.number}`)}
            />
          ))}
          {report && candidates.length === 0 && !report.error && (
            <div className="px-3 py-3 text-xs text-faint">No open issues found.</div>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          {active ? (
            <Workshop candidate={active} readiness={readiness} onArmed={() => void load()} />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-faint px-6 text-center">
              Pick an issue to judge it against the bar the 01:00 planner enforces.
              <br />
              Nothing is written until you arm it.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
