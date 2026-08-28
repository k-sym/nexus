import { useCallback, useEffect, useState } from 'react';
import {
  api,
  Night,
  NightDetail,
  NightOutcome,
  NightQueuePR,
  NightQueueResponse,
  NightRun,
  NightTests,
  QueuedIssue,
} from '../api';

// Night-queue board (baker-internal#111) — the read side of the overnight
// runner (#55). Read-only by design: the queue is filled by minting a
// `night-queue` label in daytime discussion, never from a dashboard.
//
// The card's job is auditability, so it is opinionated about two things:
//   * `tests` is what the RUNNER observed, not what the coder model claimed.
//     A PR row without a green run is an unvalidated draft and is coloured
//     like a warning, not like a success — the PR link must never be the
//     loudest thing on a row the runner could not prove.
//   * an empty night is calm. Most nights have nothing labelled; that reads
//     as "quiet", never as a failure.
const POLL_MS = 60_000;
const NIGHTS_COLLAPSED = 1;

const OUTCOME_LABEL: Record<NightOutcome, string> = {
  worked: 'WORKED',
  quiet: 'QUIET',
  running: 'RUNNING',
};

const OUTCOME_PILL: Record<NightOutcome, string> = {
  worked: 'bg-emerald-500/15 text-emerald-300',
  quiet: 'bg-zinc-700/40 text-zinc-400',
  running: 'bg-sky-500/15 text-sky-300',
};

const STATUS_DOT: Record<string, string> = {
  pr_opened: 'bg-emerald-400',
  parked: 'bg-zinc-500',
  no_changes: 'bg-zinc-500',
  timeout: 'bg-red-500',
  failed: 'bg-red-500',
};

const STOP_REASON_LABEL: Record<string, string> = {
  drained: 'queue drained',
  window_closed: 'window closed',
  token_budget: 'token budget',
  max_issues: 'issue cap',
  fatal: 'fatal error',
};

/** The single most important field on the board. Anything but `passed` means
 * the runner could not prove the change; `null` means the row predates the
 * column, which is unknown rather than either verdict. */
function testsBadge(tests: NightTests): { text: string; className: string } {
  switch (tests) {
    case 'passed':
      return { text: 'tests passed', className: 'text-emerald-400' };
    case 'failed':
      return { text: 'TESTS FAILED', className: 'text-red-400 font-semibold' };
    case 'not_run':
      return { text: 'TESTS NOT RUN', className: 'text-amber-400 font-semibold' };
    default:
      return { text: 'tests unknown', className: 'text-zinc-500' };
  }
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function relativeAgo(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return '';
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - epochSeconds));
  if (elapsed < 60) return 'just now';
  const minutes = Math.floor(elapsed / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function nightDate(night: Night): string {
  if (!night.started_ts) return night.id;
  return new Date(night.started_ts * 1000).toLocaleDateString([], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-wider text-faint font-medium mt-3 mb-1">{children}</div>;
}

function RunRow({ run }: { run: NightRun }) {
  const badge = testsBadge(run.tests);
  const shipped = run.status === 'pr_opened';
  return (
    <div className="flex items-start gap-2 py-1 pl-1">
      <span
        className={`inline-block h-2 w-2 rounded-full shrink-0 mt-1.5 ${STATUS_DOT[run.status ?? ''] ?? 'bg-zinc-600'}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <a
            href={run.issue_url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="text-zinc-200 hover:underline"
          >
            {run.repo}#{run.issue_number}
          </a>
          <span className="text-muted">{run.status ?? 'unknown'}</span>
          {run.verdict && <span className="text-muted">· {run.verdict.replace(/_/g, ' ')}</span>}
          {run.rounds > 0 && (
            <span className="text-faint">
              · {run.rounds} round{run.rounds === 1 ? '' : 's'}
            </span>
          )}
          <span className="text-faint">· {tokens(run.tokens_used)} tok</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-[11px] mt-0.5">
          {/* Deliberately beside the PR link, not below it: a PR the runner
              could not validate should never look finished. */}
          {shipped && <span className={badge.className}>{badge.text}</span>}
          {run.pr_url && (
            <a
              href={run.pr_url}
              target="_blank"
              rel="noreferrer"
              className="text-sky-400 hover:underline"
            >
              {run.pr_url.replace(/^https:\/\/github\.com\/[^/]+\//, '').replace('/pull/', ' #')}
            </a>
          )}
          {run.error && <span className="text-red-400">{run.error}</span>}
        </div>
        {run.summary && <div className="text-[11px] text-faint mt-0.5 line-clamp-2">{run.summary}</div>}
      </div>
    </div>
  );
}

function NightBlock({ night, expanded, onToggle }: { night: Night; expanded: boolean; onToggle: () => void }) {
  const [plan, setPlan] = useState<NightDetail | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);

  const toggle = async () => {
    onToggle();
    if (!expanded && !plan) {
      try {
        setPlan(await api.nightQueue.night(night.id));
      } catch (err: any) {
        setPlanError(err?.message || 'Failed to load the plan.');
      }
    }
  };

  const facts = [
    `${night.issues_attempted}/${night.issues_planned} attempted`,
    `${night.prs_opened} PR${night.prs_opened === 1 ? '' : 's'}`,
    `${tokens(night.tokens_used)} tok`,
    night.stop_reason ? STOP_REASON_LABEL[night.stop_reason] ?? night.stop_reason : 'no stop reason',
  ];

  return (
    <div className="border-b border-subtle last:border-b-0 py-1">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2 text-left hover:bg-[var(--surface-hover)] transition-colors rounded-sm px-1 py-1"
      >
        <span className={`text-[10px] font-bold tracking-wide px-1.5 py-0.5 rounded ${OUTCOME_PILL[night.outcome]}`}>
          {OUTCOME_LABEL[night.outcome]}
        </span>
        <span className="text-xs font-medium text-zinc-200">{nightDate(night)}</span>
        {night.outcome === 'quiet' ? (
          <span className="text-[11px] text-faint">nothing was labelled</span>
        ) : (
          <span className="text-[11px] text-muted truncate">{facts.join(' · ')}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {night.unvalidated > 0 && (
            <span className="text-[10px] font-semibold text-amber-400">
              {night.unvalidated} unvalidated
            </span>
          )}
          {night.failures > 0 && (
            <span className="text-[10px] font-semibold text-red-400">
              {night.failures} failed
            </span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="pl-1 pb-1">
          {night.runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
          {night.runs.length === 0 && (
            <div className="text-[11px] text-faint px-1 py-1">
              No issues were attempted — the queue was empty.
            </div>
          )}
          {planError && <div className="text-[11px] text-red-400 px-1">{planError}</div>}
          {plan && (plan.plan.parked.length > 0 || plan.plan.excluded.length > 0) && (
            <div className="text-[11px] text-faint px-1 mt-1 space-y-0.5">
              {plan.plan.parked.map((p) => (
                <div key={`p-${p.repo}-${p.number}`}>
                  parked {p.repo}#{p.number} — {p.reason}
                </div>
              ))}
              {plan.plan.excluded.map((e) => (
                <div key={`e-${e.repo}-${e.number}`}>
                  excluded by policy: {e.repo}#{e.number}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QueueRow({ issue }: { issue: QueuedIssue }) {
  return (
    <div className="py-1 px-1">
      <div className="flex items-center gap-2 text-xs">
        <a href={issue.url} target="_blank" rel="noreferrer" className="text-zinc-200 hover:underline">
          {issue.repo}#{issue.number}
        </a>
        <span className="text-muted truncate">{issue.title}</span>
        <span className="text-[11px] text-faint ml-auto shrink-0">{relativeAgo(issue.updated_ts)}</span>
      </div>
      {issue.excluded ? (
        // Standing policy (#55): a label here does nothing, so the row says so
        // rather than sitting in the list looking like tonight's work.
        <div className="text-[11px] text-amber-400/80">
          excluded by policy — the runner never touches its own runtime or this surface
        </div>
      ) : (
        issue.readiness && (
          <div className="text-[11px] text-faint line-clamp-2">
            {issue.readiness_source === 'body' ? 'body: ' : ''}
            {issue.readiness}
          </div>
        )
      )}
    </div>
  );
}

function PRRow({ pr }: { pr: NightQueuePR }) {
  return (
    <div className="flex items-center gap-2 py-1 px-1 text-xs">
      <a href={pr.url} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline shrink-0">
        {pr.repo}#{pr.number}
      </a>
      <span className="text-muted truncate">{pr.title}</span>
      {pr.is_draft && <span className="text-[10px] text-faint shrink-0">draft</span>}
      <span className="text-[11px] text-faint ml-auto shrink-0">opened {relativeAgo(pr.created_ts)}</span>
    </div>
  );
}

export default function NightQueueCard() {
  const [report, setReport] = useState<NightQueueResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.nightQueue.list();
      setReport(next);
      setLoadError(null);
      // Open the most recent night that actually did something, so the
      // question the board exists to answer is already answered on arrival.
      setExpanded((current) => current ?? next.nights.find((n) => n.runs.length > 0)?.id ?? null);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load the night queue.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const nights = report?.nights ?? [];
  const queue = report?.queue ?? [];
  const openPRs = report?.open_prs ?? [];
  const shown = showAll ? nights : nights.slice(0, NIGHTS_COLLAPSED);
  const readyQueue = queue.filter((q) => !q.excluded);

  return (
    <div className="surface-glass rounded-xl border border-subtle p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Night Queue</div>
        {openPRs.length > 0 && (
          <div className="text-[10px] text-sky-400">
            {openPRs.length} PR{openPRs.length === 1 ? '' : 's'} awaiting you
          </div>
        )}
      </div>

      {report == null && !loadError && <div className="text-xs text-faint">Loading the night queue…</div>}
      {loadError && <div className="text-xs text-red-400">{loadError}</div>}
      {report?.configured === false && (
        <div className="text-xs text-faint">Configure the assistant URL and key in Settings to see the night queue.</div>
      )}
      {report?.error && <div className="text-xs text-faint">Adapter unreachable · {report.error}</div>}

      {report && report.configured !== false && !report.error && (
        <>
          <SectionLabel>Recent nights</SectionLabel>
          {!report.available && (
            <div className="text-xs text-faint px-1">
              No nights recorded yet — the runner writes its ledger after its first night.
            </div>
          )}
          {shown.map((night) => (
            <NightBlock
              key={night.id}
              night={night}
              expanded={expanded === night.id}
              onToggle={() => setExpanded((current) => (current === night.id ? null : night.id))}
            />
          ))}
          {nights.length > NIGHTS_COLLAPSED && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="text-[11px] text-faint hover:text-muted mt-1 px-1"
            >
              {showAll ? 'Show fewer nights' : `Show ${nights.length - NIGHTS_COLLAPSED} earlier night${nights.length - NIGHTS_COLLAPSED === 1 ? '' : 's'}`}
            </button>
          )}

          <SectionLabel>Queued for tonight</SectionLabel>
          {report.queue_error && (
            <div className="text-[11px] text-amber-400/80 px-1">
              {report.queue_stale ? 'Showing the last known queue · ' : 'Could not read the queue · '}
              {report.queue_error}
            </div>
          )}
          {queue.length === 0 && !report.queue_error && (
            // The deliberate normal state, phrased as such.
            <div className="text-xs text-faint px-1">
              Nothing labelled — the queue is minted in daytime discussion.
            </div>
          )}
          {queue.map((issue) => (
            <QueueRow key={`${issue.repo}#${issue.number}`} issue={issue} />
          ))}
          {readyQueue.length > 0 && (
            <div className="text-[11px] text-faint px-1 mt-0.5">
              {readyQueue.length} issue{readyQueue.length === 1 ? '' : 's'} for tonight's 01:00 run.
            </div>
          )}

          <SectionLabel>PRs awaiting you</SectionLabel>
          {report.open_prs_error && (
            <div className="text-[11px] text-amber-400/80 px-1">
              {report.open_prs_stale ? 'Showing the last known list · ' : 'Could not read open PRs · '}
              {report.open_prs_error}
            </div>
          )}
          {openPRs.length === 0 && !report.open_prs_error && (
            <div className="text-xs text-faint px-1">Nothing open — every night-queue PR is resolved.</div>
          )}
          {openPRs.map((pr) => (
            <PRRow key={`${pr.repo}#${pr.number}`} pr={pr} />
          ))}
        </>
      )}
    </div>
  );
}
