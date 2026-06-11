import { Task, TaskStatus } from '@nexus/shared';

interface KanbanBoardProps {
  tasks: Task[];
  columns: TaskStatus[];
  columnLabels: Record<TaskStatus, string>;
  onMoveTask: (taskId: string, newStatus: TaskStatus) => void;
  onAddTask: (status: TaskStatus) => void;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: 'bg-gray-500',
  medium: 'bg-blue-500',
  high: 'bg-orange-500',
  urgent: 'bg-red-500',
};

export default function KanbanBoard({ tasks, columns, columnLabels, onMoveTask, onAddTask, onEditTask, onDeleteTask }: KanbanBoardProps) {
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

            <div className="flex-1 surface-glass border border-subtle rounded-lg p-2 space-y-2 overflow-y-auto min-h-[100px]">
              {columnTasks.map(task => (
                <div
                  key={task.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, task.id)}
                  onClick={() => onEditTask(task)}
                  className="surface-panel border border-subtle rounded-lg p-3 cursor-grab active:cursor-grabbing hover:border-[var(--border-strong)] transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="text-sm font-medium leading-tight flex-1">{task.title}</h3>
                    <span className={`w-2 h-2 rounded-full shrink-0 mt-1 ${PRIORITY_COLORS[task.priority] || 'bg-gray-500'}`} />
                  </div>
                  {task.description && (
                    <p className="text-xs text-muted line-clamp-2 mb-2">{task.description}</p>
                  )}
                  <div className="flex items-center justify-between">
                    <div className="flex gap-1">
                      {task.assigned_agent && (
                        <span className="text-[10px] surface-elevated text-faint px-1.5 py-0.5 rounded">
                          {task.assigned_agent}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onDeleteTask(task.id); }}
                      className="text-faint/40 hover:text-red-400 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}

              {columnTasks.length === 0 && (
                <div className="text-center text-xs text-faint/70 py-4">
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
