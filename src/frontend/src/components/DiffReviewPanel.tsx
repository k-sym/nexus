import { useEffect, useState } from 'react';
import { GitDiffState, ReviewAction, ReviewActionRequest, ReviewActionResult, Task } from '@nexus/shared';
import { api } from '../api';

const ACTIONS: Array<{ action: ReviewAction; label: string; caption: string }> = [
  { action: 'ask_reviewer', label: 'Ask reviewer', caption: 'Create a Review task for Codex-style review.' },
  { action: 'explain_change', label: 'Explain change', caption: 'Create a Review task to explain the hunk.' },
  { action: 'spawn_fix_task', label: 'Spawn fix task', caption: 'Create a To Do task for a fix pass.' },
  { action: 'assign_reviewer', label: 'Assign reviewer', caption: 'Assign the source task to the Reviewer persona.' },
  { action: 'attach_to_chat', label: 'Attach to chat', caption: 'Open a chat seeded with the hunk context.' },
];

interface DiffReviewPanelProps {
  projectId: string;
  task: Pick<Task, 'id' | 'title'> | null;
  onClose: () => void;
  onTaskCreated: (task: ReviewActionResult['task']) => void;
  onTaskAssigned: (task: ReviewActionResult['task']) => void;
  onChatSeed: (seed: NonNullable<ReviewActionResult['seed']>) => void;
}

function ActionButton({ action, disabled, onRun }: { action: (typeof ACTIONS)[number]; disabled: boolean; onRun: () => void }) {
  return (
    <button type="button" onClick={onRun} disabled={disabled} aria-label={action.label} className="text-left surface-glass border border-subtle rounded-lg p-3 hover:border-[var(--border-strong)] disabled:opacity-40 disabled:cursor-not-allowed">
      <div className="text-sm font-medium text-primary">{action.label}</div>
      <div className="text-[11px] text-muted mt-1">{action.caption}</div>
    </button>
  );
}

export default function DiffReviewPanel({ projectId, task, onClose, onTaskCreated, onTaskAssigned, onChatSeed }: DiffReviewPanelProps) {
  const [state, setState] = useState<GitDiffState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

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

  const runAction = async (action: ReviewActionRequest['action'], hunkId: string) => {
    if (!task) return;
    setRunning(`${action}:${hunkId}`);
    try {
      const result = await api.projects.reviewAction(projectId, { action, task_id: task.id, hunk_id: hunkId });
      if (result.task && action === 'assign_reviewer') onTaskAssigned(result.task);
      else if (result.task) onTaskCreated(result.task);
      if (result.seed) onChatSeed(result.seed);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-t-2xl sm:rounded-2xl w-full max-w-5xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-subtle">
          <div>
            <h2 className="text-lg font-semibold">Diff review</h2>
            <p className="text-xs text-faint">{task ? `Source task: ${task.title}` : 'Select a Review or Deploy task to attach actions.'}</p>
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
                      <span className="text-[10px] surface-elevated text-faint px-2 py-1 rounded">{hunk.id}</span>
                    </div>
                    <div className="p-4 space-y-4">
                      <pre className="bg-black/30 border border-subtle rounded-lg p-3 overflow-x-auto text-[11px] text-muted leading-relaxed">{hunk.diff}</pre>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
                        {ACTIONS.map((action) => (
                          <ActionButton
                            key={action.action}
                            action={action}
                            disabled={Boolean(running) || !task}
                            onRun={() => void runAction(action.action, hunk.id)}
                          />
                        ))}
                      </div>
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
