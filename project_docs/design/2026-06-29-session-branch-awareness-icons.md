# Session Branch Awareness Icons

## Goal

Show Git branch awareness in the compact session list so users can see which project checkout a session is tied to before opening it.

## Design

Each project session row uses the existing row icon slot to show a Phosphor `GitBranch` icon. The icon title reports `Branch: <name>` when the backend can detect the current branch and `Branch unavailable` when the project path is not a Git repo, is detached, or Git detection fails.

The backend computes the branch from the active project's `repo_path` with `git -C <repo_path> branch --show-current`. Detection is best-effort and returns an empty string on errors, matching the existing Git remote detection style.

## Implementation Notes

- `ChatThread` now accepts an optional `git_branch` display field.
- `GET /api/projects/:projectId/threads` attaches the current project branch to each returned thread.
- `POST /api/projects/:projectId/threads` also returns the current branch so newly created sessions render consistently before the next list refresh.
- The branch is project-scoped, not thread-scoped. Nexus does not currently persist a separate worktree or branch per session, so every listed session reflects the current checkout branch for that project.

## Testing Notes

Testing should verify:

- Session rows display a branch icon with `Branch: <name>` when branch detection succeeds.
- Session rows display a muted icon with `Branch unavailable` when no branch is available.
- The backend thread list includes `git_branch` and calls branch detection once per project thread listing.
- Git branch detection trims output and safely returns an empty string on Git errors.
