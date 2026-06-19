# Diff-aware review actions for task and session workflows

## Goal

Give Nexus enough git diff awareness to inspect changed hunks from a project task and turn a hunk into focused review, explanation, fix, persona assignment, or chat context without leaving the app.

## Scope

- Add backend APIs that read diff state from the project repository stored on the project row.
- Parse staged and unstaged tracked diffs into files and hunks.
- Add in-app Review/Deploy diff affordances on Kanban task cards.
- Let hunk actions create provenance-rich follow-up tasks or chat seeds.
- Preserve existing git tooling; Nexus only reads git state and orchestrates follow-up work.

## Backend design

### `GET /api/projects/:id/git/diff`

Returns a structured diff state for the project repository.

Response shape:

```ts
type GitDiffState =
  | {
      ok: true;
      repo_path: string;
      git_remote: string;
      has_changes: boolean;
      summary: {
        files: number;
        hunks: number;
        added: number;
        deleted: number;
        staged_files: string[];
        unstaged_files: string[];
        untracked_files: string[];
      };
      files: GitDiffFile[];
      hunks: GitDiffHunk[];
    }
  | {
      ok: false;
      reason: 'not_git_repo' | 'git_error';
      message: string;
      repo_path?: string;
      git_remote?: string;
    };
```

Behavior:

- If the project row does not exist, return `404`.
- If `repo_path` is missing or `git rev-parse --is-inside-work-tree` fails, return `ok: false, reason: 'not_git_repo'`.
- If git commands fail, return `ok: false, reason: 'git_error'` with the git stderr message.
- If there are no staged or unstaged tracked changes, return `ok: true, has_changes: false`.
- Include untracked files in `summary.untracked_files` but do not synthesize hunks for them.

Diff commands:

- Staged tracked changes: `git diff --cached --no-ext-diff --unified=80`
- Unstaged tracked changes: `git diff --no-ext-diff --unified=80`
- File status: `git status --porcelain=v1 -z`

Hunks are split from combined staged then unstaged diff output. Each hunk includes:

- stable id
- file path
- hunk header
- diff text
- a focused prompt context string

### `POST /api/projects/:id/review-actions`

Creates a follow-up task or chat seed for a selected hunk.

Request shape:

```ts
{
  task_id?: string;
  action: 'ask_reviewer' | 'explain_change' | 'spawn_fix_task' | 'assign_reviewer' | 'attach_to_chat';
  hunk_id?: string;
  note?: string;
}
```

Behavior:

- Validates the project and task exist when `task_id` is provided.
- Validates the hunk exists in the current diff when `hunk_id` is provided.
- Builds a prompt with project path, source task, file path, hunk header, hunk diff, and optional user note.
- Creates a follow-up task for task-producing actions.
- Updates the source task persona for `assign_reviewer`.
- Creates a new chat thread and returns a seed prompt for `attach_to_chat`.

Action mapping:

| Action | Result | Status | Suggested persona/provider |
|---|---|---|---|
| `ask_reviewer` | follow-up task | `review` | Reviewer / Codex |
| `explain_change` | follow-up task | `review` | Reviewer / OpenRouter |
| `spawn_fix_task` | follow-up task | `todo` | Developer / Claude Code |
| `assign_reviewer` | update source task | source task status unchanged | Reviewer / Codex |
| `attach_to_chat` | chat thread seed | no status change | active project session |

Follow-up task descriptions include provenance:

- source task title/id
- project name/id
- file path
- hunk header
- hunk diff
- suggested persona/provider
- user note, if supplied

## Frontend design

- Add a `DiffReviewPanel` component.
- Add a **Diff** button to Review and Deploy Kanban cards.
- The panel loads `GET /api/projects/:id/git/diff` for the active project.
- The panel displays:
  - repo path and remote
  - empty/no-changes state
  - error state
  - file/hunk list with copyable diff text
  - action buttons per hunk
- Hunk actions call `POST /api/projects/:id/review-actions` and then:
  - reload tasks for task-producing actions
  - select the new chat thread for `attach_to_chat`
  - refresh the diff panel

## Error handling

- No project: show project missing state.
- Not a git repo: show a clear message and hide hunk actions.
- Git command failure: show the git error without crashing the app.
- No changes: show a friendly empty state.
- API action failure: show the returned error in the panel.

## Out of scope

- Exact click-to-select line ranges inside a hunk.
- Directly spawning Claude Code, Codex, or OpenCode subprocesses.
- Persisting review comments as a separate table.
- Including untracked file contents as synthetic hunks.

## Tests

Backend:

- Parser returns files and hunks from staged and unstaged tracked diffs.
- Route returns `not_git_repo` for a non-git project path.
- Route returns `has_changes: false` for a clean git repo.
- Route returns a `git_error` for a failing git command path.
- Review action creates follow-up tasks with provenance.
- Review action updates source task persona for `assign_reviewer`.
- Review action creates chat seed for `attach_to_chat`.

Frontend:

- Diff panel renders no-changes and error states.
- Diff panel renders hunk action buttons.
- Hunk actions call the API and reload tasks or select a chat thread as appropriate.

## Acceptance coverage

- Review task can inspect current diffs without leaving Nexus.
- Hunk can seed a focused agent prompt without manually copying diff text.
- Spawned follow-up tasks include file path, hunk/context, source task, and suggested persona/provider.
- Feature does not replace existing git tooling; it only reads diff state and creates Nexus orchestration artifacts.
