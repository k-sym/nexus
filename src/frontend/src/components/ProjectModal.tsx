import { useState } from 'react';
import { PROJECT_BADGE_MAX_LENGTH, deriveProjectBadge, normalizeProjectBadge, type Project } from '@nexus/shared';

/** Reduce a github remote URL to "owner/repo" for display; null if not GitHub. */
function parseRepoLabel(remote?: string): string | null {
  if (!remote) return null;
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

interface ProjectModalProps {
  onClose: () => void;
  onSubmit: (data: { name: string; badge: string; repo_path: string }) => void;
  project?: Project;
}

export default function ProjectModal({ onClose, onSubmit, project }: ProjectModalProps) {
  const [name, setName] = useState(project?.name ?? '');
  // `null` means "still tracking the name". Once the user edits the badge it
  // holds its own value, so typing in Name stops overwriting a deliberate
  // choice. An empty string is a valid override — it means the user cleared the
  // field to retype it, and must NOT snap back to the derived value mid-edit.
  const [badgeOverride, setBadgeOverride] = useState<string | null>(project?.badge || null);
  const [repoPath, setRepoPath] = useState(project?.repo_path ?? '');
  const isEditing = Boolean(project);

  // Blank until there is a name to derive from, so an untouched form doesn't
  // greet you with the '?' fallback.
  const badge = badgeOverride ?? (name.trim() ? deriveProjectBadge(name) : '');
  // What actually gets saved: an emptied field falls back to the derived badge.
  const effectiveBadge = name.trim() ? normalizeProjectBadge(badge, name) : '';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    onSubmit({
      name: name.trim(),
      badge: normalizeProjectBadge(badge, name.trim()),
      repo_path: repoPath.trim(),
    });
  };

  /** Clean without falling back, so clearing the field leaves it empty. */
  const handleBadgeChange = (value: string) => {
    setBadgeOverride(value.replace(/[^a-z0-9]/gi, '').slice(0, PROJECT_BADGE_MAX_LENGTH).toUpperCase());
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center z-50" onClick={onClose}>
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
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-hidden focus:border-strong"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs text-faint mb-1" htmlFor="project-badge">Rail Badge</label>
            <div className="flex items-center gap-3">
              <input
                id="project-badge"
                type="text"
                value={badge}
                onChange={(e) => handleBadgeChange(e.target.value)}
                maxLength={PROJECT_BADGE_MAX_LENGTH}
                placeholder="ABC"
                className="w-20 surface-panel border border-subtle rounded-lg px-3 py-2 text-sm text-center font-semibold tracking-wide text-primary placeholder:text-faint uppercase focus:outline-hidden focus:border-strong"
              />
              <span aria-hidden className="compact-project-avatar h-10 w-10 grid place-items-center text-xs tracking-tight">
                {effectiveBadge}
              </span>
              <p className="text-[10px] text-faint flex-1">
                Up to {PROJECT_BADGE_MAX_LENGTH} letters, shown in the project rail. Follows the
                name until you change it.
              </p>
            </div>
          </div>
          <div>
            <label className="block text-xs text-faint mb-1">Repository Path</label>
            <input
              type="text"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="~/Projects/my-app"
              className="w-full surface-panel border border-subtle rounded-lg px-3 py-2 text-sm font-mono text-primary placeholder:text-faint focus:outline-hidden focus:border-strong"
            />
            <p className="text-[10px] text-faint mt-1">Path to an existing local directory</p>
          </div>
          {isEditing && (
            <div>
              <label className="block text-xs text-faint mb-1">Git repository</label>
              <p className="text-sm font-mono text-muted">
                {parseRepoLabel(project?.git_remote) ?? 'none detected'}
              </p>
              <p className="text-[10px] text-faint mt-1">Detected from the repository's git remote. Open issues sync into Triage.</p>
            </div>
          )}
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
