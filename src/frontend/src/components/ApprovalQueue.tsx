/**
 * In-app tool approvals.
 *
 * A supervised thread parks each tool call until a human answers. Before this
 * the only place to answer was the G2 glasses, so on a laptop every gate sat
 * there until it auto-denied. This renders the same queue, resolving through
 * the same broker — whichever surface answers first wins.
 *
 * Phase 2 of #266.
 */
import { useApprovals, type PendingApproval, type ToolCategory } from '../hooks/useApprovals';

/** Accent per category, so a shell command doesn't look like a file read. */
const ACCENT: Record<ToolCategory, string> = {
  exec: 'border-l-red-500',
  services: 'border-l-red-500',
  network: 'border-l-amber-500',
  write: 'border-l-amber-500',
  unknown: 'border-l-amber-500',
  read: 'border-l-sky-500',
  interactive: 'border-l-sky-500',
};

const CATEGORY_LABEL: Record<ToolCategory, string> = {
  exec: 'Runs a command',
  services: 'Starts a service',
  network: 'Reaches the network',
  write: 'Modifies files',
  unknown: 'Unclassified',
  read: 'Reads',
  interactive: 'Asks you',
};

/**
 * One-line summary of what the tool was asked to do. Tool inputs are arbitrary
 * JSON, so this stays defensive: pull the field that carries the intent when we
 * recognise the shape, and fall back to compact JSON otherwise. Never throw —
 * an unrenderable gate would be an unanswerable one.
 */
export function summarizeInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  for (const field of ['command', 'file_path', 'path', 'url', 'pattern', 'query']) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** Trailing path segment — the full cwd is usually too long to be useful. */
export function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

interface ApprovalCardProps {
  approval: PendingApproval;
  onDecide: (toolCallId: string, action: 'allow' | 'deny') => void;
}

function ApprovalCard({ approval, onDecide }: ApprovalCardProps) {
  const summary = summarizeInput(approval.input);
  const project = shortCwd(approval.cwd);
  return (
    <div
      role="alertdialog"
      aria-label={`Approve ${approval.toolName}`}
      className={`bg-zinc-900 border border-zinc-800 border-l-2 ${ACCENT[approval.category] ?? ACCENT.unknown} rounded-md shadow-lg px-3 py-2`}
    >
      <div className="text-[10px] uppercase tracking-wider text-zinc-500/70">
        {CATEGORY_LABEL[approval.category] ?? CATEGORY_LABEL.unknown}
        {project ? ` · ${project}` : ''}
      </div>
      <div className="text-sm text-zinc-200 font-mono leading-snug mt-0.5">{approval.toolName}</div>
      {summary && (
        <div className="text-xs text-zinc-400 font-mono leading-snug mt-1 break-all line-clamp-3">
          {summary}
        </div>
      )}
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => onDecide(approval.toolCallId, 'allow')}
          className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100 transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onDecide(approval.toolCallId, 'deny')}
          className="flex-1 text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-red-900/60 text-zinc-300 transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export default function ApprovalQueue() {
  const { approvals, decide } = useApprovals();
  if (approvals.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {/* Oldest first: the gate that has been waiting longest is closest to
          timing out, so it should be the one under the cursor. */}
      {[...approvals]
        .sort((a, b) => a.requestedAt - b.requestedAt)
        .map((approval) => (
          <ApprovalCard
            key={approval.toolCallId}
            approval={approval}
            onDecide={(id, action) => { void decide(id, action); }}
          />
        ))}
    </div>
  );
}
