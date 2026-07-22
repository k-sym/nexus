import { useEffect, useState } from 'react';
import { ChatCircle } from '@phosphor-icons/react';
import { Task, TaskStatus } from '@nexus/shared';
import type { MondayItemWithLinks } from '@nexus/shared';
import { MondayBadge } from './MondayBadge';
import { fetchMondayItems } from '../api';

interface KanbanBoardProps {
  tasks: Task[];
  columns: TaskStatus[];
  columnLabels: Record<TaskStatus, string>;
  /** Owning project, used to load the task→Monday-item link map alongside the
   *  task list. Optional so isolated renders (e.g. component tests) can omit
   *  it — the board then simply shows no badges, matching the "Monday
   *  unavailable never blocks the board" contract. */
  projectId?: string;
  onMoveTask: (taskId: string, newStatus: TaskStatus) => void;
  onAddTask: (status: TaskStatus) => void;
  /** Click a card. Linked tasks reopen their chat; unlinked tasks edit. The
   *  parent decides based on `task.thread_id`. */
  onOpenTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onOpenDiffReview?: (task: Task) => void;
}

const PRIORITY_CLASSES: Record<string, string> = {
  low: 'kanban-priority-low',
  medium: 'kanban-priority-medium',
  high: 'kanban-priority-high',
  urgent: 'kanban-priority-urgent',
};

export default function KanbanBoard({ tasks, columns, columnLabels, projectId, onMoveTask, onAddTask, onOpenTask, onDeleteTask, onOpenDiffReview }: KanbanBoardProps) {
  // Loaded once with the task list, not per card — every card render needs
  // this, so a per-card fetch would be one request per card. A failure here
  // (e.g. an expired Monday token) must never block the board itself: cards
  // simply render without their badge.
  const [mondayItems, setMondayItems] = useState<Map<string, MondayItemWithLinks>>(new Map());

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchMondayItems(projectId);
        if (cancelled) return;
        const byTask = new Map<string, MondayItemWithLinks>();
        for (const item of items) {
          for (const taskId of item.task_ids) byTask.set(taskId, item);
        }
        setMondayItems(byTask);
      } catch {
        if (!cancelled) setMondayItems(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    if (taskId) onMoveTask(taskId, status);
  };

  return (
    <div className="flex gap-3 p-4 h-full overflow-x-auto">
      {columns.map(column => {
        const columnTasks = tasks.filter(t => t.status === column);
        return (
          <div
            key={column}
            className="flex flex-col w-64 shrink-0"
            onDragOver={handleDragOver}
            onDrop={(e) => handleDrop(e, column)}
          >
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-faint uppercase tracking-wider">
                  {columnLabels[column]}
                </span>
                <span className="surface-elevated text-faint text-[10px] px-1.5 py-0.5 rounded-full">
                  {columnTasks.length}
                </span>
              </div>
              <button
                onClick={() => onAddTask(column)}
                className="text-faint hover:text-[var(--text-primary)] text-lg leading-none transition-colors"
              >
                +
              </button>
            </div>

            <div
              data-kanban-lane
              className="flex-1 kanban-lane rounded-lg p-2 space-y-2 overflow-y-auto min-h-[100px] transition-colors"
            >
              {columnTasks.map(task => (
                <div
                  key={task.id}
                  data-kanban-card
                  data-priority={task.priority}
                  draggable
                  onDragStart={(e) => handleDragStart(e, task.id)}
                  onClick={() => onOpenTask(task)}
                  title={task.thread_id ? 'Open task chat' : 'Edit task'}
                  className={`kanban-card ${PRIORITY_CLASSES[task.priority] || PRIORITY_CLASSES.low} border rounded-lg p-3 pl-4 cursor-grab active:cursor-grabbing transition-colors group`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="text-sm font-medium leading-tight flex-1">{task.title}</h3>
                    {task.thread_id && (
                      <ChatCircle
                        className="w-3.5 h-3.5 text-faint shrink-0 mt-0.5"
                        weight="fill"
                        aria-label="Has a linked chat"
                      />
                    )}
                  </div>
                  {task.description && (
                    <p className="text-xs text-muted line-clamp-2 mb-2">{task.description}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1">
                      {task.assigned_agent && (
                        <span className="text-[10px] surface-elevated text-faint px-1.5 py-0.5 rounded-sm">
                          {task.assigned_agent}
                        </span>
                      )}
                      <MondayBadge item={mondayItems.get(task.id)} />
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {(['review', 'deploy'] as TaskStatus[]).includes(task.status) && onOpenDiffReview && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onOpenDiffReview(task); }}
                          className="text-[10px] text-faint hover:text-[var(--text-primary)] border border-subtle rounded-sm px-1.5 py-1 transition-colors"
                        >
                          Diff
                        </button>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
                        className="text-faint/40 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                </div>
              ))}

              {columnTasks.length === 0 && (
                <div className="text-center text-xs text-faint/70 py-4 border border-dashed border-[rgba(168,185,208,0.16)] rounded-lg">
                  Drop tasks here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
