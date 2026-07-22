import { useCallback, useEffect, useState } from 'react';
import { Task } from '@nexus/shared';
import type { MondayItemWithLinks } from '@nexus/shared';
import { fetchMondayItems } from '../api';
import { MondayBadge } from './MondayBadge';
import { MondayItemPicker } from './MondayItemPicker';

interface TaskModalProps {
  /** Label of the column being added to (create mode). */
  columnLabel?: string;
  /** When provided, the modal edits this task instead of creating a new one. */
  task?: Task;
  /** Owning project. Only used to power the "Monday initiative" section below,
   *  which only renders in edit mode — a task not yet created has no id to
   *  link. Optional so create-mode call sites (and any test that doesn't care
   *  about Monday) are unaffected. */
  projectId?: string;
  onClose: () => void;
  onSubmit: (data: { title: string; description: string; priority: string }) => void;
  /** Fired after a successful link/unlink so a parent holding independent
   *  Monday state (e.g. the Kanban board's card badges) can refresh itself. */
  onMondayLinkChanged?: () => void;
}

export default function TaskModal({ columnLabel, task, projectId, onClose, onSubmit, onMondayLinkChanged }: TaskModalProps) {
  const isEdit = Boolean(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [priority, setPriority] = useState(task?.priority ?? 'medium');
  const [mondayItem, setMondayItem] = useState<MondayItemWithLinks | null>(null);

  const taskId = task?.id;

  // Loaded once when the modal opens (edit mode only), not per render — this
  // mirrors KanbanBoard's own fetch-once-with-the-list pattern. A failure here
  // must never block editing the task itself: Monday unavailable just means
  // the section shows no current link, same tolerant contract as the badge.
  const loadCurrentLink = useCallback(async () => {
    if (!taskId || !projectId) return;
    try {
      const items = await fetchMondayItems(projectId);
      setMondayItem(items.find((item) => item.task_ids.includes(taskId)) ?? null);
    } catch {
      setMondayItem(null);
    }
  }, [taskId, projectId]);

  useEffect(() => {
    void loadCurrentLink();
  }, [loadCurrentLink]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), description: description.trim(), priority });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">{isEdit ? 'Edit Task' : 'New Task'}</h2>
        <p className="text-xs text-faint mb-4">
          {isEdit ? 'Update the task details' : `Adding to: ${columnLabel}`}
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-faint mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-hidden focus:border-strong"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-faint mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Details, context, requirements..."
              rows={3}
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-hidden focus:border-strong"
            />
          </div>
          <div>
            <label className="block text-xs text-faint mb-1">Priority</label>
            <div className="flex gap-2">
              {(['low', 'medium', 'high', 'urgent'] as const).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${priority === p ? 'border-strong surface-active text-primary' : 'border-subtle text-muted hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]'}`}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>
          {taskId && projectId ? (
            <div>
              <label className="block text-xs text-faint mb-1">Monday initiative</label>
              {mondayItem ? (
                <div className="mb-2">
                  <MondayBadge item={mondayItem} />
                </div>
              ) : null}
              <MondayItemPicker
                projectId={projectId}
                taskId={taskId}
                currentItemId={mondayItem?.item_id ?? null}
                onLinked={() => {
                  void loadCurrentLink();
                  onMondayLinkChanged?.();
                }}
              />
            </div>
          ) : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!title.trim()} className="px-4 py-2 text-sm accent-button rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {isEdit ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
