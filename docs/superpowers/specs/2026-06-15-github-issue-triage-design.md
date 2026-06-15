# Design: Track git repo per project → auto-triage open GitHub issues

**Date:** 2026-06-15
**Status:** Approved (pending spec review)

## Summary

Each project tracks the GitHub repository of its local checkout. When the user
opens a project's Kanban board, the backend fetches the repo's **open** GitHub
issues and auto-creates **Triage** tasks for any issue it hasn't seen before.
The link between an issue and its task is permanent, so moving a task across
columns (Triage → To-Do → In Progress …) never causes the issue to be re-added
or reset. Sync's only job is to create a triage task for issues not yet tracked.

## Goals

- Persist the git repository identity on each project ("track the git repository").
- On Kanban navigation, surface open GitHub issues as Triage tasks automatically.
- Never duplicate an issue, and never disturb a task's column once it exists.

## Non-goals (YAGNI)

- GitLab / Bitbucket / self-hosted hosts (GitHub only).
- Label → priority mapping (all synced tasks default to `medium`).
- Auto-deleting or auto-moving tasks when an issue is closed on GitHub.
- A `github` config block — gated purely on a GitHub remote being present.
- Pull requests (explicitly filtered out of the issues feed).

## Decisions (from brainstorming)

| Decision | Choice |
| --- | --- |
| Host & repo identity | **GitHub, auto-detected** from the project's local `git remote origin`. |
| Issue → task flow | **Auto-create Triage tasks**, deduped by issue number stored on the task. |
| Sync trigger | **On Kanban navigation, throttled** (~3 min cache window per project). |
| Remote URL read | **Shell out** to `git -C <repo_path> remote get-url origin` via `execFile`. |
| Auth | `GITHUB_TOKEN` env var (mirrors `JIRA_TOKEN`); optional for public repos. |
| Deleted-task behavior | If a task is deleted and the issue is still open, the next sync recreates it in Triage (accepted tradeoff). |

## Dedup behavior (the core invariant)

The issue↔task link lives on the **task**, not on the column:

- A synced task is stamped with `external_source='github'` and `external_id='<issue number>'`.
- Sync creates a task for issue N **only if** no task in that project already has
  `external_source='github'` AND `external_id=N`, regardless of that task's `status`.
- Therefore: moving a task to any column, editing it, etc. never causes re-creation.
- An issue closed on GitHub drops out of the `state=open` fetch; existing tasks are left untouched.

## Data model changes

`src/backend/db.ts`, idempotent guarded `ALTER TABLE` migrations (same pattern as
the existing `config_json` / `sort_order` additions):

- `projects.git_remote TEXT DEFAULT ''` — detected origin URL (raw form, e.g.
  `git@github.com:owner/repo.git`). The stored "git repository" for the project.
- `tasks.external_source TEXT` — source system identifier (`'github'`).
- `tasks.external_id TEXT` — issue number as text.
- Index `idx_tasks_external` on `(project_id, external_source, external_id)` for dedup lookups.

`Task` and `Project` interfaces in `src/shared/index.ts` gain the corresponding
optional fields.

## Components

### Repo detection — `src/backend/github/repo.ts`
- `detectGitRemote(repoPath): Promise<string>` — runs
  `git -C <repoPath> remote get-url origin` via `execFileAsync`; returns `''` on
  any failure (non-fatal).
- `parseGitHubRepo(url): { owner, repo } | null` — handles SSH
  (`git@github.com:owner/repo.git`) and HTTPS
  (`https://github.com/owner/repo(.git)`) forms; returns `null` for non-`github.com`
  hosts or unparseable input.

Detection runs when a project is **created** or its **`repo_path` changes**
(`src/backend/routes/projects.ts` POST/PUT), writing the result to `git_remote`.
Detection failure never blocks the save.

### GitHub client — `src/backend/github/client.ts`
- `fetchOpenIssues({ owner, repo }, token?): Promise<GitHubIssue[]>`
  - `GET https://api.github.com/repos/{owner}/{repo}/issues?state=open&per_page=100`,
    paginated up to a sane cap.
  - Native `fetch`. Headers: `Accept: application/vnd.github+json`,
    `User-Agent: nexus` (GitHub requires UA), and `Authorization: Bearer <token>`
    when `GITHUB_TOKEN` is set.
  - **Filters out pull requests** (entries carrying a `pull_request` field).
  - Non-2xx → throws typed `GitHubError` (mirrors `JiraError`).

### Sync — `src/backend/github/sync.ts`
`syncGitHubIssues(db, project): Promise<{ created, total }>`:
1. **Throttle** — module-level `Map<projectId, lastSyncMs>`; return
   `{ created: 0, total: 0 }` early if within the window (constant ≈ 3 min).
2. Parse repo from `project.git_remote`; if no GitHub remote → no-op.
3. `fetchOpenIssues(...)` with `process.env.GITHUB_TOKEN`.
4. For each issue: skip if a task with matching `external_source`/`external_id`
   exists; else insert a `status='triage'`, `priority='medium'` task —
   `title: "[#<n>] <title>"`,
   `description: "From GitHub #<n> (<url>)\n\n<body excerpt>"`.
5. On `GitHubError`, insert a notification (like Jira) and return zero counts —
   never crash navigation.

### API & trigger
- New route **`POST /api/projects/:id/github/sync`** (`src/backend/routes/projects.ts`)
  → calls `syncGitHubIssues`, returns `{ created, total }`.
- `src/frontend/src/api.ts`: add `projects.githubSync(id)`.
- `src/frontend/src/App.tsx`: when the Kanban subview opens for a project, call
  `githubSync(id)` then reload tasks. Throttling lives in the backend, so calling
  on every navigation is cheap.

### UI — `src/frontend/src/components/ProjectModal.tsx`
In **edit** mode only, a read-only line: `Git repository: owner/repo` (or
"none detected"). No input field — detection is automatic.

## Error handling

- Missing/failed `git` remote → empty `git_remote`, project still saves.
- No GitHub remote on a project → sync is a silent no-op.
- Private repo without `GITHUB_TOKEN`, or rate-limited → `GitHubError` → a
  notification row; navigation and task loading proceed normally.

## Testing

- `parseGitHubRepo`: SSH form, HTTPS form, `.git` suffix, non-GitHub host,
  garbage input → `null`.
- `syncGitHubIssues` with a stubbed fetch: first run creates N tasks; second run
  creates 0 (dedup); PR entries excluded; closed/absent issues don't disturb
  existing tasks.

## Files touched

- `src/backend/db.ts` — migrations + index.
- `src/shared/index.ts` — `Project` / `Task` fields.
- `src/backend/github/repo.ts` — new (detect + parse).
- `src/backend/github/client.ts` — new (fetch).
- `src/backend/github/sync.ts` — new (throttle + dedup + insert).
- `src/backend/routes/projects.ts` — detection on create/update, sync route.
- `src/frontend/src/api.ts` — `githubSync`.
- `src/frontend/src/App.tsx` — sync on Kanban open.
- `src/frontend/src/components/ProjectModal.tsx` — read-only repo line.
- Tests for `repo.ts` and `sync.ts`.
