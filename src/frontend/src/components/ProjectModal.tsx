import { useState } from 'react';
import type { Project } from '@nexus/shared';

interface ProjectModalProps {
  onClose: () => void;
  onSubmit: (data: { name: string; description: string; repo_path: string }) => void;
  project?: Project;
}

export default function ProjectModal({ onClose, onSubmit, project }: ProjectModalProps) {
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [repoPath, setRepoPath] = useState(project?.repo_path ?? '');
  const isEditing = Boolean(project);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim(), repo_path: repoPath.trim() });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">{isEditing ? 'Edit Project' : 'New Project'}</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-faint mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-strong"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-faint mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={2}
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint resize-none focus:outline-none focus:border-strong"
            />
          </div>
          <div>
            <label className="block text-xs text-faint mb-1">Repository Path</label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="~/Projects/my-app"
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-none focus:border-strong"
            />
            <p className="text-[10px] text-faint mt-1">Path to an existing local directory</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted hover:text-[var(--text-primary)] transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || !repoPath.trim()} className="px-4 py-2 text-sm accent-button rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              {isEditing ? 'Save Project' : 'Create Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
