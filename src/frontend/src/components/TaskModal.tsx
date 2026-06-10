import { useState } from 'react';

interface TaskModalProps {
  columnLabel: string;
  onClose: () => void;
  onSubmit: (data: { title: string; description: string; priority: string }) => void;
}

export default function TaskModal({ columnLabel, onClose, onSubmit }: TaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({ title: title.trim(), description: description.trim(), priority });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-1">New Task</h2>
        <p className="text-xs text-faint mb-4">Adding to: {columnLabel}</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-faint mb-1">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-strong"
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
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
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
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!title.trim()} className="px-4 py-2 text-sm accent-button rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Create Task
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
