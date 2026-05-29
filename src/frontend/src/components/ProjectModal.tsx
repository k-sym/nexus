import { useState } from 'react';

interface ProjectModalProps {
  onClose: () => void;
  onSubmit: (data: { name: string; description: string; repo_path: string }) => void;
}

export default function ProjectModal({ onClose, onSubmit }: ProjectModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoPath, setRepoPath] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    onSubmit({ name: name.trim(), description: description.trim(), repo_path: repoPath.trim() });
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-md p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold mb-4">New Project</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Project Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              rows={2}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600/40 resize-none focus:outline-none focus:border-indigo-500/50"
            />
          </div>
          <div>
            <label className="block text-xs text-zinc-500 mb-1">Repository Path</label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="~/Projects/my-app"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-600/40 focus:outline-none focus:border-indigo-500/50"
            />
            <p className="text-[10px] text-zinc-500 mt-1">Path to an existing local directory</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-500 hover:text-zinc-200 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!name.trim() || !repoPath.trim()} className="px-4 py-2 text-sm bg-indigo-500 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              Create Project
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
