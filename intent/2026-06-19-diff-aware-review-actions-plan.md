# Diff-aware review actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add in-app git diff inspection and hunk-level review actions for Nexus Review/Deploy tasks without replacing existing git tooling.

**Architecture:** Add a backend git-diff service that reads the project repository, parses staged/unstaged tracked diffs into hunks, and exposes review-action endpoints. Add a frontend diff panel wired into Review/Deploy Kanban cards, with hunk actions that create provenance-rich follow-up tasks or chat seeds.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, Testing Library/Vitest, Node child_process.

## Global Constraints

- Use project `repo_path` from the `projects` row for git commands.
- Return clean failure states for no git repo, no changes, and git command failures.
- Do not replace existing git tooling; only read diff state and orchestrate Nexus tasks/chat.
- Preserve task provenance in generated review comments/tasks: file path, hunk/context, source task, suggested persona/provider.
- First version uses auto-split hunks from `git diff --unified=80`; no exact line-range selection.
- Do not synthesize hunks for untracked files; list them only in status summary.
- Existing modified files `src/backend/routes/chat.ts` and `src/backend/test/routes-chat.test.ts` are unrelated and should not be touched unless a test run proves otherwise.

---

## File map

- Modify `src/shared/index.ts`
  - Add shared TypeScript types for `GitDiffState`, `GitDiffFile`, `GitDiffHunk`, `GitDiffSummary`, `ReviewActionRequest`, and `ReviewActionResult`.
- Create `src/backend/git/diff.ts`
  - Own git command execution, diff parsing, and review-action prompt/provenance helpers.
- Modify `src/backend/routes/projects.ts`
  - Import and call git diff helpers.
  - Add `GET /api/projects/:id/git/diff`.
  - Add `POST /api/projects/:id/review-actions`.
- Create `src/backend/test/git-diff.test.ts`
  - Test parser and route behavior using temporary git repos.
- Modify `src/frontend/src/api.ts`
  - Add `projects.gitDiff` and `projects.reviewAction`.
- Create `src/frontend/src/components/DiffReviewPanel.tsx`
  - Render diff state, errors, empty state, hunk list, and hunk actions.
- Create `src/frontend/src/components/DiffReviewPanel.test.tsx`
  - Test no-changes/error/action behavior.
- Modify `src/frontend/src/components/KanbanBoard.tsx`
  - Add `onOpenDiffReview` prop and a **Diff** button on Review/Deploy cards.
- Modify `src/frontend/src/components/KanbanBoard.test.tsx`
  - Test Review/Deploy Diff button and non-review card behavior.
- Modify `src/frontend/src/App.tsx`
  - Track selected diff task, load diff panel state, call review actions, reload tasks, and select chat threads for `attach_to_chat`.

---

### Task 1: Shared diff/action types

**Files:**
- Modify: `src/shared/index.ts:1-199`

**Interfaces:**
- Consumes: existing `Project`, `Task`, `TaskStatus`.
- Produces: `GitDiffState`, `GitDiffFile`, `GitDiffHunk`, `GitDiffSummary`, `ReviewActionRequest`, `ReviewActionResult`.

- [ ] **Step 1: Write a type-only compile check**

Add these exports to `src/shared/index.ts` after `Task` and before `Ticket`:

```ts
export interface GitDiffSummary {
  files: number;
  hunks: number;
  added: number;
  deleted: number;
  staged_files: string[];
  unstaged_files: string[];
  untracked_files: string[];
}

export interface GitDiffFile {
  path: string;
  old_path: string | null;
  new_path: string | null;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'unknown';
  added: number;
  deleted: number;
  staged: boolean;
  hunks: GitDiffHunk[];
}

export interface GitDiffHunk {
  id: string;
  file: string;
  header: string;
  diff: string;
  prompt: string;
  staged: boolean;
  old_start: number | null;
  new_start: number | null;
  old_lines: number | null;
  new_lines: number | null;
}

export type GitDiffState =
  | {
      ok: true;
      repo_path: string;
      git_remote: string;
      has_changes: boolean;
      summary: GitDiffSummary;
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

export type ReviewAction = 'ask_reviewer' | 'explain_change' | 'spawn_fix_task' | 'assign_reviewer' | 'attach_to_chat';

export interface ReviewActionRequest {
  task_id?: string;
  action: ReviewAction;
  hunk_id?: string;
  note?: string;
}

export interface ReviewActionResult {
  ok: true;
  action: ReviewAction;
  task?: {
    id: string;
    project_id: string;
    title: string;
    status: TaskStatus;
    assigned_agent: string | null;
    model_key: string | null;
  };
  thread?: {
    id: string;
    project_id: string;
    title: string;
  };
  seed?: {
    threadId: string;
    prompt: string;
    modelKey: string | null;
  };
}
```

- [ ] **Step 2: Run backend/frontend typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS, because only type exports changed.

---

### Task 2: Backend git diff parser and helpers

**Files:**
- Create: `src/backend/git/diff.ts`
- Test: `src/backend/test/git-diff.test.ts`

**Interfaces:**
- Consumes: `Project`, `Task`, `GitDiffState`, `GitDiffHunk`, `ReviewActionRequest`.
- Produces: `getProjectGitDiff(project)`, `parseGitDiff(output, staged)`, `buildReviewActionPrompt(project, task, action, hunk, note)`, `reviewActionPlan(action)`.

- [ ] **Step 1: Write failing parser tests**

Create `src/backend/test/git-diff.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, execFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseGitDiff, getProjectGitDiff } from '../git/diff';

function runGit(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

test('parseGitDiff splits staged and unstaged hunks with stable ids', () => {
  const staged = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;
  const unstaged = `diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,1 +10,2 @@
-old
+new
+extra
`;
  const parsed = [...parseGitDiff(staged, true), ...parseGitDiff(unstaged, false)];
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'staged:0:src/a.ts:-1:+1');
  assert.equal(parsed[0].file, 'src/a.ts');
  assert.equal(parsed[0].diff.includes('+const b = 2;'), true);
  assert.equal(parsed[1].id, 'unstaged:0:src/b.ts:-10:+10');
});

test('getProjectGitDiff returns structured staged and unstaged tracked diffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-git-diff-'));
  try {
    runGit(dir, ['init']);
    runGit(dir, ['config', 'user.email', 'a@example.com']);
    runGit(dir, ['config', 'user.name', 'A Person']);
    writeFileSync(join(dir, 'src/a.ts'), 'const a = 1;\nconst c = 3;\n');
    mkdirSync(join(dir, 'src'), { recursive: true });
    runGit(dir, ['add', 'src/a.ts']);
    runGit(dir, ['commit', '-m', 'initial']);

    writeFileSync(join(dir, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    runGit(dir, ['add', 'src/a.ts']);
    writeFileSync(join(dir, 'src/b.ts'), 'old\n');
    writeFileSync(join(dir, 'src/b.ts'), 'new\nextra\n');
    writeFileSync(join(dir, 'untracked.txt'), 'skip me\n');

    const state = getProjectGitDiff({ id: 'p', repo_path: dir, git_remote: '' } as any);
    assert.equal(state.ok, true);
    if (!state.ok) throw new Error('expected ok diff state');
    assert.equal(state.has_changes, true);
    assert.equal(state.summary.untracked_files[0], 'untracked.txt');
    assert.equal(state.hunks.length, 2);
    assert.equal(state.hunks.some((h) => h.file === 'src/a.ts' && h.staged), true);
    assert.equal(state.hunks.some((h) => h.file === 'src/b.ts' && !h.staged), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getProjectGitDiff returns not_git_repo for non-git paths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-not-git-'));
  try {
    const state = getProjectGitDiff({ id: 'p', repo_path: dir, git_remote: '' } as any);
    assert.deepEqual(state, {
      ok: false,
      reason: 'not_git_repo',
      message: 'Not a git repository',
      repo_path: dir,
      git_remote: '',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run parser tests to verify they fail**

Run:

```bash
npm --prefix src/backend test test/git-diff.test.ts
```

Expected: FAIL because `src/backend/git/diff.ts` does not exist.

- [ ] **Step 3: Implement git diff helper module**

Create `src/backend/git/diff.ts`:

```ts
import { execFileSync } from 'node:child_process';
import type { GitDiffFile, GitDiffHunk, GitDiffState, GitDiffSummary, Project, ReviewAction, ReviewActionResult, Task } from '@nexus/shared';

type ParsedDiff = { files: GitDiffFile[]; hunks: GitDiffHunk[]; added: number; deleted: number };

interface GitCommandResult {
  ok: true;
  stdout: string;
  stderr: string;
}

function runGit(cwd: string, args: string[]): GitCommandResult {
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (err: any) {
    const raw = String(err?.stderr || err?.message || '').trim();
    const stderr = raw.includes('not a git repository') ? 'Not a git repository' : raw || 'git command failed';
    return { ok: false, stdout: '', stderr };
  }
}

function cleanStatusPath(raw: string): string {
  return raw.replace(/^"|"$/g, '').replace(/\\/g, '/');
}

function parseStatus(stdout: string) {
  const staged_files: string[] = [];
  const unstaged_files: string[] = [];
  const untracked_files: string[] = [];
  const parts = stdout.split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    const xy = entry.slice(0, 2);
    const path = cleanStatusPath(entry.slice(3));
    if (xy.startsWith('??')) untracked_files.push(path);
    else if (xy[0] !== ' ' && xy[0] !== '?') staged_files.push(path);
    else if (xy[1] !== ' ' && xy[1] !== '?') unstaged_files.push(path);
  }
  return { staged_files: [...new Set(staged_files)].sort(), unstaged_files: [...new Set(unstaged_files)].sort(), untracked_files: [...new Set(untracked_files)].sort() };
}

function parseHunkHeader(header: string) {
  const match = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return { old_start: null, new_start: null, old_lines: null, new_lines: null };
  return {
    old_start: Number(match[1]),
    new_start: Number(match[3]),
    old_lines: match[2] ? Number(match[2]) : null,
    new_lines: match[4] ? Number(match[4]) : null,
  };
}

function statusFromPaths(oldPath: string | null, newPath: string | null): GitDiffFile['status'] {
  if (oldPath && !newPath) return 'deleted';
  if (!oldPath && newPath) return 'added';
  if (oldPath && newPath && oldPath !== newPath) return 'renamed';
  return 'modified';
}

function parseOneDiff(output: string, staged: boolean): ParsedDiff {
  const files: GitDiffFile[] = [];
  const hunks: GitDiffHunk[] = [];
  let current: GitDiffFile | null = null;
  let currentHunk: string[] = [];
  let currentHeader = '';
  let added = 0;
  let deleted = 0;

  const flushHunk = () => {
    if (!current || currentHunk.length === 0) return;
    const header = currentHeader || '@@ @@';
    const numbers = parseHunkHeader(header);
    const diff = currentHunk.join('\n');
    const hunkIndex = current.hunks.length;
    const hunk: GitDiffHunk = {
      id: `${staged ? 'staged' : 'unstaged'}:${hunkIndex}:${current.path}:${numbers.old_start ?? ''}:${numbers.new_start ?? ''}`,
      file: current.path,
      header,
      diff,
      prompt: `Review this change in ${current.path}${header !== '@@ @@' ? ` (${header})` : ''}:\n\n\`\`\`diff\n${diff}\n\`\`\``,
      staged,
      ...numbers,
    };
    current.hunks.push(hunk);
    hunks.push(hunk);
    currentHunk = [];
    currentHeader = '';
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushHunk();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const oldPath = match ? match[1] : null;
      const newPath = match ? match[2] : null;
      const path = newPath || oldPath || 'unknown';
      current = { path, old_path: oldPath, new_path: newPath, status: statusFromPaths(oldPath, newPath), added: 0, deleted: 0, staged, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('--- ')) {
      current.old_path = line.slice(4) !== '/dev/null' ? line.slice(4).replace(/^a\//, '') : current.old_path;
      current.status = statusFromPaths(current.old_path, current.new_path);
      continue;
    }
    if (line.startsWith('+++ ')) {
      current.new_path = line.slice(4) !== '/dev/null' ? line.slice(4).replace(/^b\//, '') : current.new_path;
      current.path = current.new_path || current.old_path || current.path;
      current.status = statusFromPaths(current.old_path, current.new_path);
      continue;
    }
    if (line.startsWith('@@ ')) {
      flushHunk();
      currentHeader = line;
      currentHunk.push(line);
      continue;
    }
    if (currentHunk.length > 0) {
      currentHunk.push(line);
      if (line.startsWith('+')) added += 1;
      if (line.startsWith('-')) deleted += 1;
      current.added += line.startsWith('+') ? 1 : 0;
      current.deleted += line.startsWith('-') ? 1 : 0;
    }
  }
  flushHunk();
  return { files, hunks, added, deleted };
}

export function parseGitDiff(output: string, staged: boolean): GitDiffHunk[] {
  return parseOneDiff(output, staged).hunks;
}

export function getProjectGitDiff(project: Pick<Project, 'id' | 'repo_path' | 'git_remote'>): GitDiffState {
  const repoPath = project.repo_path;
  if (!repoPath) {
    return { ok: false, reason: 'not_git_repo', message: 'Project repo_path is empty', repo_path: repoPath, git_remote: project.git_remote };
  }
  const repoCheck = runGit(repoPath, ['rev-parse', '--is-inside-work-tree']);
  if (!repoCheck.ok) {
    return { ok: false, reason: 'not_git_repo', message: repoCheck.stderr || 'Not a git repository', repo_path: repoPath, git_remote: project.git_remote };
  }

  const status = parseStatus(runGit(repoPath, ['status', '--porcelain=v1', '-z']).stdout);
  const stagedDiff = runGit(repoPath, ['diff', '--cached', '--no-ext-diff', '--unified=80']);
  const unstagedDiff = runGit(repoPath, ['diff', '--no-ext-diff', '--unified=80']);
  if (!stagedDiff.ok || !unstagedDiff.ok) {
    const failed = !stagedDiff.ok ? stagedDiff : unstagedDiff;
    return { ok: false, reason: 'git_error', message: failed.stderr, repo_path: repoPath, git_remote: project.git_remote };
  }

  const staged = parseOneDiff(stagedDiff.stdout, true);
  const unstaged = parseOneDiff(unstagedDiff.stdout, false);
  const files = [...staged.files, ...unstaged.files];
  const hunks = [...staged.hunks, ...unstaged.hunks];
  const summary: GitDiffSummary = {
    files: new Set(files.map((f) => f.path)).size,
    hunks: hunks.length,
    added: staged.added + unstaged.added,
    deleted: staged.deleted + unstaged.deleted,
    ...status,
  };

  return {
    ok: true,
    repo_path: repoPath,
    git_remote: project.git_remote,
    has_changes: summary.files > 0 || summary.untracked_files.length > 0,
    summary,
    files,
    hunks,
  };
}

function actionTitle(action: ReviewAction, hunk: GitDiffHunk) {
  if (action === 'ask_reviewer') return `Review hunk in ${hunk.file}`;
  if (action === 'explain_change') return `Explain hunk in ${hunk.file}`;
  if (action === 'spawn_fix_task') return `Fix hunk in ${hunk.file}`;
  if (action === 'assign_reviewer') return `Assign reviewer for ${hunk.file}`;
  return `Discuss hunk in ${hunk.file}`;
}

function actionDescription(project: Project, task: Task | null, action: ReviewAction, hunk: GitDiffHunk, note?: string) {
  const parts = [
    `Suggested persona/provider: ${action === 'spawn_fix_task' ? 'Developer / Claude Code' : 'Reviewer / Codex'}`,
    `Source task: ${task ? `${task.title} (${task.id})` : 'none'}`,
    `Project: ${project.name} (${project.id})`,
    `File: ${hunk.file}`,
    `Hunk: ${hunk.header}`,
    '',
    hunk.prompt,
  ];
  if (note?.trim()) parts.push('', `User note: ${note.trim()}`);
  return parts.join('\n');
}

export function buildReviewActionPrompt(project: Project, task: Task | null, action: ReviewAction, hunk: GitDiffHunk, note?: string) {
  return actionDescription(project, task, action, hunk, note);
}

export function reviewActionPlan(action: ReviewAction): { status: Task['status']; assigned_agent: string | null; model_key: string | null; createsTask: boolean } {
  if (action === 'spawn_fix_task') return { status: 'todo', assigned_agent: 'Developer', model_key: null, createsTask: true };
  if (action === 'assign_reviewer') return { status: 'review', assigned_agent: 'Reviewer', model_key: null, createsTask: false };
  return { status: 'review', assigned_agent: 'Reviewer', model_key: null, createsTask: true };
}
```

- [ ] **Step 4: Run parser tests to verify they pass**

Run:

```bash
npm --prefix src/backend test test/git-diff.test.ts
```

Expected: PASS.

---

### Task 3: Backend review-action route

**Files:**
- Modify: `src/backend/routes/projects.ts:1-307`
- Test: `src/backend/test/git-diff.test.ts`

**Interfaces:**
- Consumes: `getProjectGitDiff`, `buildReviewActionPrompt`, `reviewActionPlan`, `uuid`.
- Produces: `GET /api/projects/:id/git/diff` and `POST /api/projects/:id/review-actions`.

- [ ] **Step 1: Add failing route tests**

Append to `src/backend/test/git-diff.test.ts`:

```ts
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { registerProjectRoutes } from '../routes/projects';

function makeRouteApp(repoPath: string) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-project-diff-route-'));
  const db = new Database(join(dir, 'test.db'));
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      due_date TEXT,
      external_source TEXT,
      external_id TEXT,
      model_key TEXT,
      thread_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New Session',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL,
      seen_at TEXT
    );
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('project-a', 'alpha', 'Alpha', repoPath, 0, now, now);
  db.prepare('INSERT INTO tasks (id, project_id, title, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('task-a', 'project-a', 'Review ambient diff', 'review', 'medium', now, now);
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerProjectRoutes);
  return { app, db, dir };
}

test('GET /api/projects/:id/git/diff returns not_git_repo for project paths outside git', async () => {
  const nonGit = mkdtempSync(join(tmpdir(), 'nexus-route-not-git-'));
  const { app, db, dir } = makeRouteApp(nonGit);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: false, reason: 'not_git_repo', repo_path: nonGit, git_remote: '', message: 'Not a git repository' });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions creates a provenance-rich review task', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-git-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src/a.ts'), 'const a = 1;\nconst c = 3;\n');
    runGit(repo, ['add', 'src/a.ts']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    runGit(repo, ['add', 'src/a.ts']);

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'ask_reviewer', hunk_id: hunkId, note: 'check edge cases' },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.task.status, 'review');
      assert.equal(body.task.assigned_agent, 'Reviewer');
      const task = db.prepare('SELECT title, description, status, assigned_agent FROM tasks WHERE id = ?').get(body.task.id) as any;
      assert.equal(task.status, 'review');
      assert.equal(task.assigned_agent, 'Reviewer');
      assert.match(task.description, /Source task: Review ambient diff \(task-a\)/);
      assert.match(task.description, /File: src\/a\.ts/);
      assert.match(task.description, /User note: check edge cases/);
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions assigns reviewer to source task', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-assign-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    writeFileSync(join(repo, 'a.txt'), 'old\n');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'a.txt'), 'new\n');

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'assign_reviewer', hunk_id: hunkId },
      });
      assert.equal(res.statusCode, 200);
      assert.equal((res.json() as any).task.assigned_agent, 'Reviewer');
      const task = db.prepare('SELECT status, assigned_agent FROM tasks WHERE id = ?').get('task-a') as any;
      assert.equal(task.status, 'review');
      assert.equal(task.assigned_agent, 'Reviewer');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /api/projects/:id/review-actions creates a chat seed for attach_to_chat', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'nexus-route-chat-'));
  try {
    runGit(repo, ['init']);
    runGit(repo, ['config', 'user.email', 'a@example.com']);
    runGit(repo, ['config', 'user.name', 'A Person']);
    writeFileSync(join(repo, 'a.txt'), 'old\n');
    runGit(repo, ['add', 'a.txt']);
    runGit(repo, ['commit', '-m', 'initial']);
    writeFileSync(join(repo, 'a.txt'), 'new\n');

    const { app, db, dir } = makeRouteApp(repo);
    try {
      const diff = await app.inject({ method: 'GET', url: '/api/projects/project-a/git/diff' });
      const hunkId = (diff.json() as any).hunks[0].id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects/project-a/review-actions',
        payload: { task_id: 'task-a', action: 'attach_to_chat', hunk_id: hunkId },
      });
      assert.equal(res.statusCode, 200);
      const body = res.json() as any;
      assert.equal(body.ok, true);
      assert.equal(body.thread.project_id, 'project-a');
      assert.equal(body.seed.threadId, body.thread.id);
      assert.match(body.seed.prompt, /Source task: Review ambient diff \(task-a\)/);
      const thread = db.prepare('SELECT id, project_id, title FROM chat_threads WHERE id = ?').get(body.thread.id) as any;
      assert.equal(thread.project_id, 'project-a');
    } finally {
      await app.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run route tests to verify they fail**

Run:

```bash
npm --prefix src/backend test test/git-diff.test.ts
```

Expected: FAIL with missing route/import errors.

- [ ] **Step 3: Add route imports**

Modify imports in `src/backend/routes/projects.ts`:

```ts
import { getProjectGitDiff, buildReviewActionPrompt, reviewActionPlan } from '../git/diff.js';
import { ReviewActionRequest, ReviewActionResult } from '@nexus/shared';
```

- [ ] **Step 4: Add diff route**

Add after `GET /api/projects/:id`:

```ts
fastify.get('/api/projects/:id/git/diff', async (request) => {
  const { id } = request.params as { id: string };
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  if (!row) {
    const err = new Error('Project not found') as any;
    err.statusCode = 404;
    throw err;
  }
  return getProjectGitDiff(row);
});
```

- [ ] **Step 5: Add review-action route**

Add after task update/delete routes or before `fastify.delete('/api/tasks/:id')`:

```ts
fastify.post('/api/projects/:id/review-actions', async (request) => {
  const { id: projectId } = request.params as { id: string };
  const body = request.body as ReviewActionRequest;
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) {
    const err = new Error('Project not found') as any;
    err.statusCode = 404;
    throw err;
  }

  const diff = getProjectGitDiff(project);
  if (!diff.ok) return diff;

  const sourceTask = body.task_id ? (db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(body.task_id, projectId) as Task | undefined) : null;
  if (body.task_id && !sourceTask) {
    const err = new Error('Task not found') as any;
    err.statusCode = 404;
    throw err;
  }

  const hunk = body.hunk_id ? diff.hunks.find((h) => h.id === body.hunk_id) : null;
  if (body.hunk_id && !hunk) {
    const err = new Error('Hunk not found in current diff') as any;
    err.statusCode = 404;
    throw err;
  }

  const plan = reviewActionPlan(body.action);
  const now = new Date().toISOString();

  if (body.action === 'assign_reviewer') {
    if (!sourceTask) {
      const err = new Error('task_id is required for assign_reviewer') as any;
      err.statusCode = 400;
      throw err;
    }
    if (!hunk) {
      const err = new Error('hunk_id is required for assign_reviewer') as any;
      err.statusCode = 400;
      throw err;
    }
    db.prepare('UPDATE tasks SET assigned_agent = ?, status = ?, updated_at = ? WHERE id = ?').run(plan.assigned_agent, sourceTask.status, now, sourceTask.id);
    const updated = db.prepare('SELECT id, project_id, title, status, assigned_agent, model_key FROM tasks WHERE id = ?').get(sourceTask.id) as ReviewActionResult['task'];
    return { ok: true, action: body.action, task: updated };
  }

  if (body.action === 'attach_to_chat') {
    if (!sourceTask) {
      const err = new Error('task_id is required for attach_to_chat') as any;
      err.statusCode = 400;
      throw err;
    }
    if (!hunk) {
      const err = new Error('hunk_id is required for attach_to_chat') as any;
      err.statusCode = 400;
      throw err;
    }
    const thread = {
      id: uuid(),
      project_id: projectId,
      title: `Diff review: ${hunk.file}`,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)').run(thread.id, thread.project_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at);
    return {
      ok: true,
      action: body.action,
      thread,
      seed: {
        threadId: thread.id,
        prompt: buildReviewActionPrompt(project, sourceTask, body.action, hunk, body.note),
        modelKey: sourceTask.model_key ?? null,
      },
    };
  }

  if (!hunk) {
    const err = new Error('hunk_id is required') as any;
    err.statusCode = 400;
    throw err;
  }

  const title = `${body.action === 'spawn_fix_task' ? 'Fix' : body.action === 'explain_change' ? 'Explain' : 'Review'} hunk in ${hunk.file}`;
  const description = buildReviewActionPrompt(project, sourceTask, body.action, hunk, body.note);
  const task = {
    id: uuid(),
    project_id: projectId,
    title,
    description,
    status: plan.status,
    priority: sourceTask?.priority ?? 'medium',
    assigned_agent: plan.assigned_agent,
    due_date: null,
    created_at: now,
    updated_at: now,
  };

  db.prepare('INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_agent, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(task.id, task.project_id, task.title, task.description, task.status, task.priority, task.assigned_agent, task.due_date, task.created_at, task.updated_at);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);

  const saved = db.prepare('SELECT id, project_id, title, status, assigned_agent, model_key FROM tasks WHERE id = ?').get(task.id) as ReviewActionResult['task'];
  return { ok: true, action: body.action, task: saved };
});
```

- [ ] **Step 6: Run route tests to verify they pass**

Run:

```bash
npm --prefix src/backend test test/git-diff.test.ts
```

Expected: PASS.

---

### Task 4: Frontend API client

**Files:**
- Modify: `src/frontend/src/api.ts:1-199`

**Interfaces:**
- Consumes: shared `GitDiffState`, `ReviewActionRequest`, `ReviewActionResult`.
- Produces: `api.projects.gitDiff(id)` and `api.projects.reviewAction(id, data)`.

- [ ] **Step 1: Write failing API test**

Add to `src/frontend/src/api.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ReviewActionRequest } from '@nexus/shared';
import { api } from './api';

describe('api.projects diff review', () => {
  it('exposes gitDiff and reviewAction endpoints', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    try {
      await api.projects.gitDiff('project-1');
      const payload: ReviewActionRequest = { action: 'ask_reviewer', task_id: 'task-1', hunk_id: 'hunk-1' };
      await api.projects.reviewAction('project-1', payload);
      expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects/project-1/git/diff', expect.any(Object));
      expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/project-1/review-actions', expect.objectContaining({ method: 'POST' }));
    } finally {
      fetchMock.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run frontend test to verify it fails**

Run:

```bash
npm --prefix src/frontend test src/api.test.ts
```

Expected: FAIL because `api.projects.gitDiff` and `api.projects.reviewAction` do not exist.

- [ ] **Step 3: Update API imports and methods**

Modify the import at the top of `src/frontend/src/api.ts`:

```ts
import { Project, Task, ChatThread, Ticket, TicketDescription, BraindumpIdea, GitDiffState, ReviewActionRequest, ReviewActionResult } from '@nexus/shared';
```

Add to `api.projects`:

```ts
gitDiff: (id: string) => fetchJson<GitDiffState>(`/api/projects/${id}/git/diff`),
reviewAction: (id: string, data: ReviewActionRequest) =>
  fetchJson<ReviewActionResult>(`/api/projects/${id}/review-actions`, {
    method: 'POST',
    body: JSON.stringify(data),
  }),
```

- [ ] **Step 4: Run frontend test to verify it passes**

Run:

```bash
npm --prefix src/frontend test src/api.test.ts
```

Expected: PASS.

---

### Task 5: Diff review panel component

**Files:**
- Create: `src/frontend/src/components/DiffReviewPanel.tsx`
- Create: `src/frontend/src/components/DiffReviewPanel.test.tsx`

**Interfaces:**
- Consumes: `api.projects.gitDiff`, `api.projects.reviewAction`, shared `GitDiffState`, `ReviewAction`.
- Produces: callbacks `onTaskCreated`, `onTaskAssigned`, `onChatSeed`.

- [ ] **Step 1: Write failing component tests**

Create `src/frontend/src/components/DiffReviewPanel.test.tsx`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiffReviewPanel from './DiffReviewPanel';
import { api } from '../api';

const diffState = {
  ok: true,
  repo_path: '/repo',
  git_remote: 'git@github.com:k-sym/nexus.git',
  has_changes: true,
  summary: { files: 1, hunks: 1, added: 1, deleted: 0, staged_files: ['src/a.ts'], unstaged_files: [], untracked_files: [] },
  files: [{ path: 'src/a.ts', old_path: 'src/a.ts', new_path: 'src/a.ts', status: 'modified', added: 1, deleted: 0, staged: true, hunks: [] }],
  hunks: [{ id: 'hunk-1', file: 'src/a.ts', header: '@@ -1,2 +1,3 @@', diff: '+const b = 2;', prompt: 'Review this change', staged: true, old_start: 1, new_start: 1, old_lines: 2, new_lines: 3 }],
};

describe('DiffReviewPanel', () => {
  it('renders no-changes state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: true, repo_path: '/repo', git_remote: '', has_changes: false, summary: { files: 0, hunks: 0, added: 0, deleted: 0, staged_files: [], unstaged_files: [], untracked_files: [] }, files: [], hunks: [] });
    render(<DiffReviewPanel projectId="project-1" task={null} onClose={vi.fn()} onTaskCreated={vi.fn()} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText('No current tracked diff changes.')).toBeInTheDocument();
  });

  it('renders hunk actions and calls reviewAction for ask_reviewer', async () => {
    const gitDiff = vi.spyOn(api.projects, 'gitDiff').mockResolvedValue(diffState);
    const reviewAction = vi.spyOn(api.projects, 'reviewAction').mockResolvedValue({ ok: true, action: 'ask_reviewer', task: { id: 'task-new', project_id: 'project-1', title: 'Review hunk', status: 'review', assigned_agent: 'Reviewer', model_key: null } });
    const onTaskCreated = vi.fn();
    render(<DiffReviewPanel projectId="project-1" task={{ id: 'task-1', title: 'Source' } as any} onClose={vi.fn()} onTaskCreated={onTaskCreated} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask reviewer' }));
    expect(reviewAction).toHaveBeenCalledWith('project-1', { action: 'ask_reviewer', task_id: 'task-1', hunk_id: 'hunk-1' });
    expect(onTaskCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-new' }));
    gitDiff.mockRestore();
    reviewAction.mockRestore();
  });

  it('renders git error state', async () => {
    vi.spyOn(api.projects, 'gitDiff').mockResolvedValue({ ok: false, reason: 'not_git_repo', message: 'Not a git repository', repo_path: '/repo', git_remote: '' });
    render(<DiffReviewPanel projectId="project-1" task={null} onClose={vi.fn()} onTaskCreated={vi.fn()} onTaskAssigned={vi.fn()} onChatSeed={vi.fn()} />);
    expect(await screen.findByText('Git diff unavailable')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run component test to verify it fails**

Run:

```bash
npm --prefix src/frontend test src/components/DiffReviewPanel.test.tsx
```

Expected: FAIL because component does not exist.

- [ ] **Step 3: Implement DiffReviewPanel**

Create `src/frontend/src/components/DiffReviewPanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { GitDiffState, ReviewAction, ReviewActionRequest, ReviewActionResult, Task } from '@nexus/shared';
import { api } from '../api';

const ACTIONS: Array<{ action: ReviewActionRequest['action']; label: string; caption: string }> = [
  { action: 'ask_reviewer', label: 'Ask reviewer', caption: 'Create a Review task for Codex-style review.' },
  { action: 'explain_change', label: 'Explain change', caption: 'Create a Review task to explain the hunk.' },
  { action: 'spawn_fix_task', label: 'Spawn fix task', caption: 'Create a To Do task for a fix pass.' },
  { action: 'assign_reviewer', label: 'Assign reviewer', caption: 'Assign the source task to the Reviewer persona.' },
  { action: 'attach_to_chat', label: 'Attach to chat', caption: 'Open a chat seeded with the hunk context.' },
];

interface DiffReviewPanelProps {
  projectId: string;
  task: Pick<Task, 'id' | 'title'> | null;
  onClose: () => void;
  onTaskCreated: (task: ReviewActionResult['task']) => void;
  onTaskAssigned: (task: ReviewActionResult['task']) => void;
  onChatSeed: (seed: NonNullable<ReviewActionResult['seed']>) => void;
}

function ActionButton({ action, disabled, onRun }: { action: (typeof ACTIONS)[number]; disabled: boolean; onRun: () => void }) {
  return (
    <button onClick={onRun} disabled={disabled} className="text-left surface-glass border border-subtle rounded-lg p-3 hover:border-[var(--border-strong)] disabled:opacity-40 disabled:cursor-not-allowed">
      <div className="text-sm font-medium text-primary">{action.label}</div>
      <div className="text-[11px] text-muted mt-1">{action.caption}</div>
    </button>
  );
}

export default function DiffReviewPanel({ projectId, task, onClose, onTaskCreated, onTaskAssigned, onChatSeed }: DiffReviewPanelProps) {
  const [state, setState] = useState<GitDiffState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await api.projects.gitDiff(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [projectId]);

  const runAction = async (action: ReviewActionRequest['action'], hunkId: string) => {
    if (!task) return;
    setRunning(`${action}:${hunkId}`);
    try {
      const result = await api.projects.reviewAction(projectId, { action, task_id: task.id, hunk_id: hunkId });
      if (result.task && action === 'assign_reviewer') onTaskAssigned(result.task);
      else if (result.task) onTaskCreated(result.task);
      if (result.seed) onChatSeed(result.seed);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50" onClick={onClose}>
      <div className="surface-glass border border-subtle rounded-t-2xl sm:rounded-2xl w-full max-w-5xl max-h-[88vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between gap-4 px-5 py-4 border-b border-subtle">
          <div>
            <h2 className="text-lg font-semibold">Diff review</h2>
            <p className="text-xs text-faint">{task ? `Source task: ${task.title}` : 'Select a Review or Deploy task to attach actions.'}</p>
          </div>
          <button onClick={onClose} className="text-faint hover:text-[var(--text-primary)]">Close</button>
        </header>

        <div className="p-5 overflow-y-auto space-y-4">
          {loading && <div className="text-sm text-faint">Loading git diff…</div>}
          {error && <div className="border border-red-400/30 bg-red-950/20 text-red-100 rounded-lg p-3 text-sm">Git diff unavailable: {error}</div>}
          {state?.ok && !state.has_changes && <div className="border border-subtle rounded-lg p-4 text-sm text-faint">No current tracked diff changes.</div>}
          {state?.ok === false && <div className="border border-subtle rounded-lg p-4 text-sm text-faint">Git diff unavailable: {state.message}</div>}
          {state?.ok && state.has_changes && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs text-muted">
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-primary">{state.summary.files}</div><div>files</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-primary">{state.summary.hunks}</div><div>hunks</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-emerald-300">+{state.summary.added}</div><div>added</div></div>
                <div className="surface-panel rounded-lg p-3"><div className="text-lg text-red-300">-{state.summary.deleted}</div><div>deleted</div></div>
              </div>
              <div className="space-y-3">
                {state.hunks.map((hunk) => (
                  <section key={hunk.id} className="surface-panel border border-subtle rounded-xl overflow-hidden">
                    <div className="px-4 py-3 border-b border-subtle flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-primary">{hunk.file}</div>
                        <div className="text-[11px] text-faint mt-0.5">{hunk.header} · {hunk.staged ? 'staged' : 'unstaged'}</div>
                      </div>
                      <span className="text-[10px] surface-elevated text-faint px-2 py-1 rounded">{hunk.id}</span>
                    </div>
                    <div className="p-4 space-y-4">
                      <pre className="bg-black/30 border border-subtle rounded-lg p-3 overflow-x-auto text-[11px] text-muted leading-relaxed">{hunk.diff}</pre>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
                        {ACTIONS.map((action) => (
                          <ActionButton
                            key={action.action}
                            action={action}
                            disabled={Boolean(running) || !task}
                            onRun={() => void runAction(action.action, hunk.id)}
                          />
                        ))}
                      </div>
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run component test to verify it passes**

Run:

```bash
npm --prefix src/frontend test src/components/DiffReviewPanel.test.tsx
```

Expected: PASS.

---

### Task 6: Kanban Diff button

**Files:**
- Modify: `src/frontend/src/components/KanbanBoard.tsx:1-125`
- Modify: `src/frontend/src/components/KanbanBoard.test.tsx:1-104`

**Interfaces:**
- Consumes: `TaskStatus`, `Task`.
- Produces: `onOpenDiffReview(task)` callback from Review/Deploy cards.

- [ ] **Step 1: Write failing Kanban tests**

Append to `src/frontend/src/components/KanbanBoard.test.tsx`:

```ts
it('shows a Diff button for Review and Deploy tasks', () => {
  const review: Task = { ...task, id: 'review-task', status: 'review', title: 'Review me' };
  const deploy: Task = { ...task, id: 'deploy-task', status: 'deploy', title: 'Deploy me' };
  const onOpenDiffReview = vi.fn();
  const { rerender } = render(
    <KanbanBoard tasks={[review]} columns={['review']} columnLabels={{ review: 'Review' } as Record<string, string>} onMoveTask={vi.fn()} onAddTask={vi.fn()} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} onOpenDiffReview={onOpenDiffReview} />,
  );
  expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument();
  rerender(
    <KanbanBoard tasks={[deploy]} columns={['deploy']} columnLabels={{ deploy: 'Deploy' } as Record<string, string>} onMoveTask={vi.fn()} onAddTask={vi.fn()} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} onOpenDiffReview={onOpenDiffReview} />,
  );
  expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument();
});

it('does not show a Diff button outside Review and Deploy', () => {
  render(
    <KanbanBoard tasks={[task]} columns={['triage']} columnLabels={{ triage: 'Triage' } as Record<string, string>} onMoveTask={vi.fn()} onAddTask={vi.fn()} onOpenTask={vi.fn()} onDeleteTask={vi.fn()} onOpenDiffReview={vi.fn()} />,
  );
  expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull();
});
```

- [ ] **Step 2: Run Kanban tests to verify they fail**

Run:

```bash
npm --prefix src/frontend test src/components/KanbanBoard.test.tsx
```

Expected: FAIL because prop/callback/button do not exist.

- [ ] **Step 3: Update Kanban props and render Diff button**

Modify `KanbanBoardProps`:

```ts
onOpenDiffReview?: (task: Task) => void;
```

Modify destructuring:

```ts
export default function KanbanBoard({ tasks, columns, columnLabels, onMoveTask, onAddTask, onOpenTask, onDeleteTask, onOpenDiffReview }: KanbanBoardProps) {
```

Add inside the card actions row, before delete button:

```tsx
{(['review', 'deploy'] as TaskStatus[]).includes(task.status) && onOpenDiffReview && (
  <button
    onClick={(e) => { e.stopPropagation(); onOpenDiffReview(task); }}
    className="text-[10px] text-faint hover:text-[var(--text-primary)] border border-subtle rounded px-1.5 py-1 transition-colors"
  >
    Diff
  </button>
)}
```

- [ ] **Step 4: Run Kanban tests to verify they pass**

Run:

```bash
npm --prefix src/frontend test src/components/KanbanBoard.test.tsx
```

Expected: PASS.

---

### Task 7: Wire DiffReviewPanel into App

**Files:**
- Modify: `src/frontend/src/App.tsx:1-658`

**Interfaces:**
- Consumes: `DiffReviewPanel`, `api.projects.reviewAction`, existing `loadTasks`, `selectThread`.
- Produces: in-app diff review flow for Review/Deploy tasks.

- [ ] **Step 1: Write failing App integration test**

Append to an existing App test file or create `src/frontend/src/App.diff-review.test.tsx` with a minimal render that checks the Diff panel is wired. If App tests are too heavy, keep this as a typecheck/integration gate and verify manually through component tests plus Kanban tests.

- [ ] **Step 2: Import DiffReviewPanel**

At the imports in `App.tsx`, add:

```tsx
import DiffReviewPanel from './components/DiffReviewPanel';
import { ReviewActionResult } from './api';
```

- [ ] **Step 3: Add diff panel state**

After `editingTask` state:

```tsx
const [diffReviewTask, setDiffReviewTask] = useState<Task | null>(null);
```

- [ ] **Step 4: Add handlers**

After `handleOpenTask`:

```tsx
const handleOpenDiffReview = (task: Task) => {
  setDiffReviewTask(task);
};

const handleDiffTaskCreated = async (created: ReviewActionResult['task']) => {
  if (created && activeProjectId) await loadTasks(activeProjectId);
};

const handleDiffTaskAssigned = async (updated: ReviewActionResult['task']) => {
  if (!updated || !activeProjectId) return;
  setTasks((current) => current.map((task) => (task.id === updated.id ? { ...task, assigned_agent: updated.assigned_agent } : task)));
};

const handleDiffChatSeed = (seed: NonNullable<ReviewActionResult['seed']>) => {
  if (!activeProjectId || !seed.threadId) return;
  setTaskSeed({ threadId: seed.threadId, prompt: seed.prompt, modelKey: seed.modelKey ?? '' });
  selectThread(activeProjectId, seed.threadId);
};
```

- [ ] **Step 5: Render DiffReviewPanel**

Add before `taskModalColumn` modal block:

```tsx
{diffReviewTask && activeProjectId && (
  <DiffReviewPanel
    projectId={activeProjectId}
    task={{ id: diffReviewTask.id, title: diffReviewTask.title }}
    onClose={() => setDiffReviewTask(null)}
    onTaskCreated={(created) => void handleDiffTaskCreated(created)}
    onTaskAssigned={(updated) => void handleDiffTaskAssigned(updated)}
    onChatSeed={handleDiffChatSeed}
  />
)}
```

- [ ] **Step 6: Wire KanbanBoard prop**

Modify the `KanbanBoard` render props:

```tsx
onOpenDiffReview={handleOpenDiffReview}
```

- [ ] **Step 7: Run typecheck and targeted frontend tests**

Run:

```bash
npm --prefix src/frontend run typecheck
npm --prefix src/frontend test src/components/DiffReviewPanel.test.tsx src/components/KanbanBoard.test.tsx
```

Expected: PASS.

---

### Task 8: Full verification and cleanup

**Files:**
- No new files unless test fixes require them.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: verified feature implementation.

- [ ] **Step 1: Run backend tests**

Run:

```bash
npm --prefix src/backend test
```

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run:

```bash
npm --prefix src/frontend test
```

Expected: PASS.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git status --short
git diff --stat
```

Expected: Only intended files are modified/created:
- `src/shared/index.ts`
- `src/backend/git/diff.ts`
- `src/backend/routes/projects.ts`
- `src/backend/test/git-diff.test.ts`
- `src/frontend/src/api.ts`
- `src/frontend/src/components/DiffReviewPanel.tsx`
- `src/frontend/src/components/DiffReviewPanel.test.tsx`
- `src/frontend/src/components/KanbanBoard.tsx`
- `src/frontend/src/components/KanbanBoard.test.tsx`
- `src/frontend/src/App.tsx`
- `docs/superpowers/specs/2026-06-19-diff-aware-review-actions-design.md`
- `docs/superpowers/plans/2026-06-19-diff-aware-review-actions.md`

- [ ] **Step 5: Commit only if explicitly requested**

If the user asks to commit, run:

```bash
git add src/shared/index.ts src/backend/git/diff.ts src/backend/routes/projects.ts src/backend/test/git-diff.test.ts src/frontend/src/api.ts src/frontend/src/components/DiffReviewPanel.tsx src/frontend/src/components/DiffReviewPanel.test.tsx src/frontend/src/components/KanbanBoard.tsx src/frontend/src/components/KanbanBoard.test.tsx src/frontend/src/App.tsx docs/superpowers/specs/2026-06-19-diff-aware-review-actions-design.md docs/superpowers/plans/2026-06-19-diff-aware-review-actions.md
git commit -m "feat: add diff-aware review actions"
```

## Spec coverage self-review

- Backend diff API: Task 2 + Task 3.
- Clean failure states: Task 2 tests cover not-git; Task 3 tests cover route-level not-git; no-change state is covered by frontend and parser summary logic.
- Hunk actions: Task 3 covers task-producing, assign-reviewer, and attach-to-chat actions; Task 5/7 cover attach-to-chat UI flow.
- Provenance: Task 3 test asserts source task, file, and note in description.
- Frontend Review/Deploy affordance: Task 6 + Task 7.
- No git replacement: all backend helpers only run read-only `git diff/status/rev-parse` plus SQLite task/thread writes.

## Placeholder scan

No TBD/TODO placeholders remain.

## Type consistency

- `GitDiffHunk` includes `staged: boolean`, matching `DiffReviewPanel` usage.
- `ReviewActionResult['task']` includes `model_key`; test DB schemas include `model_key` and `thread_id` to match production migrations.
- `GitDiffFile.hunks` type references `GitDiffHunk` before declaration; TypeScript allows interface forward references.
