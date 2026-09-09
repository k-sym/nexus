/**
 * Diff review as a session action (#439 D12). Opens from an Idle or Running
 * card and offers one thing per hunk: attach the hunk to the card's own session,
 * which seeds that thread with the hunk prompt. The task-creating actions went
 * with the task board.
 */
import { useEffect, useState } from 'react';
import { GitDiffState, ReviewActionResult } from '@nexus/shared';
import { api } from '../api';

interface DiffReviewPanelProps {
  projectId: string;
  /** The session the hunks attach to. Null renders the diff read-only. */
  thread: { id: string; title: string } | null;
  onClose: () => void;
  onChatSeed: (seed: NonNullable<ReviewActionResult['seed']>) => void;
}

export default function DiffReviewPanel({ projectId, thread, onClose, onChatSeed }: DiffReviewPanelProps) {
  const [state, setState] = useState<GitDiffState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await api.projects.gitDiff(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const attach = async (hunkId: string) => {
    if (!thread) return;
    setRunning(hunkId);
    try {
      const note = notes[hunkId]?.trim() || undefined;
      const result = await api.projects.reviewAction(projectId, { action: 'attach_to_chat', thread_id: thread.id, hunk_id: hunkId, note });
      if (result.seed) onChatSeed(result.seed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-t-2xl sm:rounded-2xl w-full max-w-5xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-subtle">
          <div>
            <h2 className="text-lg font-semibold">Diff review</h2>
            <p className="text-xs text-faint">{thread ? `Session: ${thread.title}` : 'Open from an Idle or Running card to attach hunks to its session.'}</p>
          </div>
          <button type="button" onClick={onClose} className="text-faint hover:text-[var(--text-primary)]">Close</button>
        </header>

        <div className="p-5 overflow-y-auto space-y-4">
          {loading && <div className="text-sm text-faint">Loading git diff…</div>}
          {error && <div className="border border-red-400/30 bg-red-950/20 text-red-100 rounded-lg p-3 text-sm">Git diff unavailable: {error}</div>}
          {state?.ok && !state.has_changes && <div className="border border-subtle rounded-lg p-4 text-sm text-faint">No current tracked diff changes.</div>}
          {state?.ok === false && <div className="border border-subtle rounded-lg p-4 text-sm text-faint">Git diff unavailable: {state.message}</div>}
          {state?.ok && state.has_changes && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-muted">
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-primary">{state.summary.files}</div><div>files</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-primary">{state.summary.hunks}</div><div>hunks</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-emerald-300">+{state.summary.added}</div><div>added</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-red-300">-{state.summary.deleted}</div><div>deleted</div></div>
              </div>
              <div className="space-y-3">
                {state.hunks.map((hunk) => (
                  <section key={hunk.id} className="surface-panel border border-subtle rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-subtle flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-primary">{hunk.file}</div>
                        <div className="text-[11px] text-faint mt-0.5">{hunk.header} · {hunk.staged ? 'staged' : 'unstaged'}</div>
                      </div>
                      <span className="text-[10px] surface-elevated text-faint px-2 py-1 rounded-sm">{hunk.id}</span>
                    </div>
                    <div className="p-4 space-y-4">
                      <pre className="bg-black/30 border border-subtle rounded-lg p-3 overflow-x-auto text-[11px] text-muted leading-relaxed">{hunk.diff}</pre>
                      <textarea
                        value={notes[hunk.id] ?? ''}
                        onChange={(e) => setNotes((current) => ({ ...current, [hunk.id]: e.target.value }))}
                        placeholder="Optional note for the session (e.g. what to focus on)…"
                        rows={2}
                        aria-label={`Note for ${hunk.file}`}
                        className="w-full surface-glass border border-subtle rounded-lg p-2 text-[11px] text-primary placeholder:text-faint resize-y"
                      />
                      <button
                        type="button"
                        onClick={() => void attach(hunk.id)}
                        disabled={Boolean(running) || !thread}
                        aria-label="Attach to this session"
                        className="text-left surface-glass border border-subtle rounded-lg p-3 hover:border-[var(--border-strong)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <div className="text-sm font-medium text-primary">{running === hunk.id ? 'Attaching…' : 'Attach to this session'}</div>
                        <div className="text-[11px] text-muted mt-1">Seed the session with this hunk and your note.</div>
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
