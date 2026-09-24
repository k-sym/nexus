# GitHub Issue Auto-Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track each project's GitHub repository (detected from its local `git remote origin`) and, when the user opens a project's Kanban board, auto-create Triage tasks for the repo's open GitHub issues — deduped by issue number so navigating never duplicates or resets a task.

**Architecture:** A new `src/backend/github/` module mirrors the existing `src/backend/jira/` pattern: `repo.ts` (detect + parse the remote), `client.ts` (fetch open issues via the GitHub REST API), `sync.ts` (throttle + dedup + insert triage tasks). Detection runs when a project is created or its `repo_path` changes; sync runs via a navigation-triggered `POST /api/projects/:id/github/sync` route. The issue↔task link is stored on the task (`external_source`/`external_id`), so dedup is status-independent.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, native `fetch`, `node:child_process` (`execFile`), `node:test` + `tsx` for tests, React frontend.

---

## Conventions (read once)

- **Backend tests** run with `npm run --workspace=src/backend test` (which is `tsx --test test/*.test.ts test/integration/*.test.ts`). To run a single file: `npm run --workspace=src/backend test -- test/<file>.test.ts` is NOT supported by the script; instead run `cd src/backend && npx tsx --test test/<file>.test.ts`.
- **Imports in test files** drop the `.js` extension and import from `../<path>` (see existing `test/jira-client.test.ts`).
- **Backend source imports** between modules use the `.js` extension (ESM/NodeNext), e.g. `import { parseGitHubRepo } from './repo.js';`.
- Network and shell are **injected** for testability (a `fetchImpl`/`run`/`now` parameter defaulting to the real implementation), exactly like `fetchJiraTickets(cfg, token, fetchImpl = fetch)`.
- After each task: `git add` the listed files and commit with the given message.

---

## File Structure

- **Create** `src/backend/github/repo.ts` — `detectGitRemote(repoPath, run?)` + `parseGitHubRepo(url)`.
- **Create** `src/backend/github/client.ts` — `GitHubError`, `GitHubIssue`, `fetchOpenIssues(repo, token?, fetchImpl?)`.
- **Create** `src/backend/github/sync.ts` — `syncGitHubIssues(db, project, opts?)`, throttle map, dedup, insert.
- **Create** `src/backend/test/github-repo.test.ts`, `src/backend/test/github-client.test.ts`, `src/backend/test/github-sync.test.ts`.
- **Modify** `src/backend/db.ts` — migrations + index (Task 1).
- **Modify** `src/shared/index.ts` — `Project.git_remote`, `Task.external_source`, `Task.external_id` (Task 2).
- **Modify** `src/backend/routes/projects.ts` — detection on create/update + sync route (Task 6).
- **Modify** `src/frontend/src/api.ts` — `projects.githubSync` (Task 7).
- **Modify** `src/frontend/src/App.tsx` — sync-on-Kanban-open effect (Task 7).
- **Modify** `src/frontend/src/components/ProjectModal.tsx` — read-only repo line (Task 8).

---

## Task 1: Database migrations + index

**Files:**
- Modify: `src/backend/db.ts` (CREATE TABLE blocks at lines 27-51, index block ending ~line 152, projects migration block at lines 171-185)
- Test: `src/backend/test/github-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/github-schema.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getDb } from '../db';

function freshDb(tag: string) {
  const base = join(tmpdir(), `nexus-ghschema-${tag}-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('projects has a git_remote column', () => {
  const { db, cleanup } = freshDb('proj');
  const cols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  cleanup();
  assert.ok(cols.includes('git_remote'), 'git_remote column present on projects');
});

test('tasks has external_source and external_id columns', () => {
  const { db, cleanup } = freshDb('task');
  const cols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  cleanup();
  assert.ok(cols.includes('external_source'), 'external_source column present on tasks');
  assert.ok(cols.includes('external_id'), 'external_id column present on tasks');
});

test('migrates a pre-existing projects table missing git_remote', () => {
  const base = join(tmpdir(), `nexus-ghschema-old-${process.pid}-${Date.now()}.db`);
  const old = new Database(base);
  old.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      description TEXT DEFAULT '', repo_path TEXT NOT NULL, config_json TEXT DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_agent TEXT, due_date TEXT,
      thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  old.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('p1', 'p1', 'P1', '/tmp', 'now', 'now');
  old.close();

  const db = getDb(base);
  const projCols = (db.pragma('table_info(projects)') as { name: string }[]).map((c) => c.name);
  const taskCols = (db.pragma('table_info(tasks)') as { name: string }[]).map((c) => c.name);
  const row = db.prepare('SELECT git_remote FROM projects WHERE id = ?').get('p1') as { git_remote: string };
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });

  assert.ok(projCols.includes('git_remote'), 'git_remote added to existing projects table');
  assert.ok(taskCols.includes('external_source') && taskCols.includes('external_id'), 'external cols added to existing tasks table');
  assert.equal(row.git_remote, '', 'existing project rows default git_remote to empty string');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/github-schema.test.ts`
Expected: FAIL — `git_remote column present` assertion fails (column does not exist yet).

- [ ] **Step 3: Add columns to the CREATE TABLE blocks**

In `src/backend/db.ts`, in the `projects` CREATE TABLE (lines 27-37), add `git_remote` before `created_at`:

```sql
    CREATE TABLE IF NOT EXISTS projects (
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
```

In the `tasks` CREATE TABLE (lines 39-51), add the two external columns before `created_at`:

```sql
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_agent TEXT,
      due_date TEXT,
      thread_id TEXT,
      external_source TEXT,
      external_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

- [ ] **Step 4: Add the dedup index**

In `src/backend/db.ts`, in the index block (the `CREATE INDEX IF NOT EXISTS …` group ending around line 152), add a line alongside the existing task indexes:

```sql
    CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(project_id, external_source, external_id);
```

- [ ] **Step 5: Add guarded ALTER TABLE migrations for existing DBs**

In `src/backend/db.ts`, immediately after the `db.exec('CREATE INDEX IF NOT EXISTS idx_projects_sort_order ON projects(sort_order)');` line (line 185), add:

```typescript
  // GitHub issue triage: track the repo on the project, and stamp synced tasks
  // with their source issue so re-syncs dedup regardless of column.
  const projCols2 = db.pragma('table_info(projects)') as { name: string }[];
  if (!projCols2.some((c) => c.name === 'git_remote')) {
    db.exec("ALTER TABLE projects ADD COLUMN git_remote TEXT NOT NULL DEFAULT ''");
  }
  const taskCols = db.pragma('table_info(tasks)') as { name: string }[];
  if (!taskCols.some((c) => c.name === 'external_source')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_source TEXT');
  }
  if (!taskCols.some((c) => c.name === 'external_id')) {
    db.exec('ALTER TABLE tasks ADD COLUMN external_id TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_external ON tasks(project_id, external_source, external_id)');
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/github-schema.test.ts`
Expected: PASS — all three tests green.

- [ ] **Step 7: Commit**

```bash
git add src/backend/db.ts src/backend/test/github-schema.test.ts
git commit -m "feat(db): track git_remote on projects and external source/id on tasks"
```

---

## Task 2: Shared types

**Files:**
- Modify: `src/shared/index.ts` (Project interface lines 12-23, Task interface lines 25-45)

- [ ] **Step 1: Add `git_remote` to the `Project` interface**

In `src/shared/index.ts`, add to `Project` (after `config_json`):

```typescript
export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string;
  repo_path: string;
  config_json: string;
  /** Detected `git remote origin` URL of repo_path; '' when none/not a git repo. */
  git_remote: string;
  task_count?: number;
  chat_session_count?: number;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Add external fields to the `Task` interface**

In `src/shared/index.ts`, add to `Task` (after `thread_id`):

```typescript
  /** Source system for an auto-triaged task, e.g. 'github'. Null for manual tasks. */
  external_source: string | null;
  /** Identifier within the source system, e.g. the GitHub issue number as text.
   *  Paired with external_source to dedup re-syncs. Null for manual tasks. */
  external_id: string | null;
```

- [ ] **Step 3: Build shared to verify types compile**

Run: `npm run --workspace=src/shared build`
Expected: PASS — no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add git_remote and external source/id to types"
```

---

## Task 3: Repo detection + parsing (`github/repo.ts`)

**Files:**
- Create: `src/backend/github/repo.ts`
- Test: `src/backend/test/github-repo.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/github-repo.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubRepo, detectGitRemote } from '../github/repo';

test('parseGitHubRepo handles SSH form', () => {
  assert.deepEqual(parseGitHubRepo('git@github.com:k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
});

test('parseGitHubRepo handles HTTPS form with and without .git', () => {
  assert.deepEqual(parseGitHubRepo('https://github.com/k-sym/nexus.git'), { owner: 'k-sym', repo: 'nexus' });
  assert.deepEqual(parseGitHubRepo('https://github.com/k-sym/nexus'), { owner: 'k-sym', repo: 'nexus' });
});

test('parseGitHubRepo returns null for non-GitHub hosts', () => {
  assert.equal(parseGitHubRepo('git@gitlab.com:k-sym/nexus.git'), null);
  assert.equal(parseGitHubRepo('https://bitbucket.org/k-sym/nexus.git'), null);
});

test('parseGitHubRepo returns null for empty or garbage input', () => {
  assert.equal(parseGitHubRepo(''), null);
  assert.equal(parseGitHubRepo('not a url'), null);
});

test('detectGitRemote returns the trimmed remote url from the runner', async () => {
  const run = async () => ({ stdout: 'git@github.com:k-sym/nexus.git\n', stderr: '' });
  assert.equal(await detectGitRemote('/some/path', run), 'git@github.com:k-sym/nexus.git');
});

test('detectGitRemote returns empty string when the runner throws (no remote / not a repo)', async () => {
  const run = async () => { throw new Error('fatal: No such remote'); };
  assert.equal(await detectGitRemote('/some/path', run), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/github-repo.test.ts`
Expected: FAIL — cannot find module `../github/repo`.

- [ ] **Step 3: Implement `github/repo.ts`**

Create `src/backend/github/repo.ts`:

```typescript
/**
 * Detect and parse the GitHub repository behind a project's local checkout.
 * Detection shells out to `git remote get-url origin` (the codebase already
 * uses execFile elsewhere); parsing tolerates SSH and HTTPS remote forms and
 * only recognises github.com.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Injectable runner so tests don't shell out. Mirrors execFileAsync's shape. */
export type GitRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultRun: GitRunner = (file, args) => execFileAsync(file, args, { timeout: 5_000 });

/**
 * Return the origin remote URL for a local repo, or '' if the path isn't a git
 * repo, has no origin, or git fails for any reason. Never throws.
 */
export async function detectGitRemote(repoPath: string, run: GitRunner = defaultRun): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Parse `owner`/`repo` out of a GitHub remote URL. Returns null for non-GitHub
 * hosts or unparseable input.
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo(.git)
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  if (!url) return null;
  const trimmed = url.trim();
  // SSH: git@github.com:owner/repo(.git)
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  // HTTPS (or git+https / ssh://...): host must be github.com
  const https = /^(?:https?|git|ssh):\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/github-repo.test.ts`
Expected: PASS — all six tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backend/github/repo.ts src/backend/test/github-repo.test.ts
git commit -m "feat(github): detect and parse the GitHub remote of a repo"
```

---

## Task 4: GitHub issues client (`github/client.ts`)

**Files:**
- Create: `src/backend/github/client.ts`
- Test: `src/backend/test/github-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/github-client.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenIssues, GitHubError } from '../github/client';

const ISSUE = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: `Body ${n}`,
  html_url: `https://github.com/o/r/issues/${n}`,
  ...extra,
});

test('fetchOpenIssues requests open issues with the required headers', async () => {
  let calledUrl = '';
  let headers: Record<string, string> = {};
  const fakeFetch = async (url: string, init?: any) => {
    calledUrl = String(url);
    headers = init?.headers ?? {};
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await fetchOpenIssues({ owner: 'o', repo: 'r' }, 'tok', fakeFetch as any);
  assert.match(calledUrl, /^https:\/\/api\.github\.com\/repos\/o\/r\/issues\?/);
  assert.match(calledUrl, /state=open/);
  assert.match(calledUrl, /per_page=100/);
  assert.equal(headers['accept'], 'application/vnd.github+json');
  assert.ok(headers['user-agent'], 'sends a User-Agent');
  assert.equal(headers['authorization'], 'Bearer tok');
});

test('fetchOpenIssues omits Authorization when no token is given', async () => {
  let headers: Record<string, string> = {};
  const fakeFetch = async (_url: string, init?: any) => {
    headers = init?.headers ?? {};
    return new Response('[]', { status: 200 });
  };
  await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.equal(headers['authorization'], undefined);
});

test('fetchOpenIssues filters out pull requests', async () => {
  const payload = [ISSUE(1), ISSUE(2, { pull_request: { url: 'x' } }), ISSUE(3)];
  const fakeFetch = async () => new Response(JSON.stringify(payload), { status: 200 });
  const issues = await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.deepEqual(issues.map((i) => i.number), [1, 3]);
});

test('fetchOpenIssues stops after one page when fewer than per_page results', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return new Response(JSON.stringify([ISSUE(1)]), { status: 200 }); };
  const issues = await fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any);
  assert.equal(calls, 1);
  assert.equal(issues.length, 1);
});

test('fetchOpenIssues throws GitHubError with status on non-2xx', async () => {
  const fakeFetch = async () => new Response('Not Found', { status: 404 });
  await assert.rejects(
    () => fetchOpenIssues({ owner: 'o', repo: 'r' }, undefined, fakeFetch as any),
    (err: unknown) => {
      assert.ok(err instanceof GitHubError);
      assert.equal((err as GitHubError).status, 404);
      assert.match((err as GitHubError).message, /404/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/github-client.test.ts`
Expected: FAIL — cannot find module `../github/client`.

- [ ] **Step 3: Implement `github/client.ts`**

Create `src/backend/github/client.ts`:

```typescript
/**
 * Minimal GitHub REST client for fetching a repo's open issues. Auth is an
 * optional bearer token from GITHUB_TOKEN (public repos work without one).
 * Mirrors the shape of the Jira client (typed error, injectable fetch).
 */
export class GitHubError extends Error {
  constructor(message: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/** The subset of an issue we use. PRs are excluded before this is returned. */
export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
}

interface RawIssue extends GitHubIssue {
  /** Present only on pull requests in the issues feed. */
  pull_request?: unknown;
}

const PER_PAGE = 100;
const MAX_PAGES = 5; // cap: up to 500 open issues per project sync

/**
 * Fetch a repo's open issues (PRs excluded), following pagination up to a cap.
 * `fetchImpl` is injectable for tests; defaults to global fetch.
 */
export async function fetchOpenIssues(
  ref: GitHubRepoRef,
  token?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GitHubIssue[]> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'nexus',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const all: GitHubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues?state=open&per_page=${PER_PAGE}&page=${page}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      throw new GitHubError(`GitHub request failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
      throw new GitHubError(`GitHub ${ref.owner}/${ref.repo} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
    }
    const batch = (await res.json()) as RawIssue[];
    for (const raw of batch) {
      if (raw.pull_request) continue; // the issues feed includes PRs; drop them
      all.push({ number: raw.number, title: raw.title, body: raw.body ?? null, html_url: raw.html_url });
    }
    if (batch.length < PER_PAGE) break; // last page reached
  }
  return all;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/github-client.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backend/github/client.ts src/backend/test/github-client.test.ts
git commit -m "feat(github): fetch open issues, excluding PRs"
```

---

## Task 5: Sync — throttle, dedup, insert (`github/sync.ts`)

**Files:**
- Create: `src/backend/github/sync.ts`
- Test: `src/backend/test/github-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/github-sync.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { syncGitHubIssues, __resetThrottle } from '../github/sync';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, slug TEXT, name TEXT, description TEXT DEFAULT '',
      repo_path TEXT, config_json TEXT DEFAULT '{}', sort_order INTEGER DEFAULT 0,
      git_remote TEXT NOT NULL DEFAULT '', created_at TEXT, updated_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'triage',
      priority TEXT NOT NULL DEFAULT 'medium', assigned_agent TEXT, due_date TEXT,
      thread_id TEXT, external_source TEXT, external_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('p1', 'p1', 'P1', '/tmp', 'git@github.com:o/r.git', 'now', 'now');
  return db;
}

const project = (db: Database.Database) => db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as any;

function fetchReturning(issues: Array<{ number: number; title: string }>) {
  return async () => new Response(
    JSON.stringify(issues.map((i) => ({ ...i, body: 'b', html_url: `https://github.com/o/r/issues/${i.number}` }))),
    { status: 200 },
  );
}

test('first sync creates a triage task per open issue, stamped with external id', async () => {
  const db = makeDb();
  __resetThrottle();
  const res = await syncGitHubIssues(db, project(db), {
    fetchImpl: fetchReturning([{ number: 1, title: 'One' }, { number: 2, title: 'Two' }]) as any,
    now: () => 1000,
  });
  assert.deepEqual(res, { created: 2, total: 2, skippedThrottle: false });
  const rows = db.prepare("SELECT title, status, external_source, external_id FROM tasks ORDER BY external_id").all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'triage');
  assert.equal(rows[0].external_source, 'github');
  assert.equal(rows[0].external_id, '1');
  assert.equal(rows[0].title, '[#1] One');
});

test('re-sync after the throttle window dedups: same issues create nothing new', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 10_000_000 });
  assert.deepEqual(res, { created: 0, total: 1, skippedThrottle: false });
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as any).c, 1);
});

test('a second call within the throttle window is a no-op', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }, { number: 2, title: 'Two' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 1000 });
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 2000 });
  assert.deepEqual(res, { created: 0, total: 0, skippedThrottle: true });
});

test('a moved task is not recreated (dedup is status-independent)', async () => {
  const db = makeDb();
  __resetThrottle();
  const fetchImpl = fetchReturning([{ number: 1, title: 'One' }]) as any;
  await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE external_id = '1'").run();
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 10_000_000 });
  assert.equal(res.created, 0);
  const row = db.prepare("SELECT status FROM tasks WHERE external_id = '1'").get() as any;
  assert.equal(row.status, 'in_progress', 'sync left the moved task untouched');
});

test('a project with no GitHub remote is a no-op', async () => {
  const db = makeDb();
  __resetThrottle();
  db.prepare("UPDATE projects SET git_remote = '' WHERE id = 'p1'").run();
  let called = false;
  const fetchImpl = (async () => { called = true; return new Response('[]'); }) as any;
  const res = await syncGitHubIssues(db, project(db), { fetchImpl, now: () => 0 });
  assert.deepEqual(res, { created: 0, total: 0, skippedThrottle: false });
  assert.equal(called, false, 'never hits the network without a GitHub remote');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/github-sync.test.ts`
Expected: FAIL — cannot find module `../github/sync`.

- [ ] **Step 3: Implement `github/sync.ts`**

Create `src/backend/github/sync.ts`:

```typescript
/**
 * Sync a project's open GitHub issues into Triage tasks. Throttled per project
 * so it's cheap to call on every Kanban navigation, and deduped by
 * (external_source, external_id) so re-syncs never duplicate or disturb a task
 * once it exists — regardless of which column it has been moved to.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Project } from '@nexus/shared';
import { parseGitHubRepo } from './repo.js';
import { fetchOpenIssues } from './client.js';

const THROTTLE_MS = 3 * 60 * 1000; // at most one network sync per project per 3 min
const lastSyncAt = new Map<string, number>();

/** Test helper: clear the in-memory throttle between cases. */
export function __resetThrottle(): void {
  lastSyncAt.clear();
}

export interface SyncResult {
  created: number;
  total: number;
  /** True when the call returned early because of the throttle window. */
  skippedThrottle: boolean;
}

export interface SyncOptions {
  token?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Build a task body that records the source issue and a short excerpt. */
function issueBody(number: number, url: string, body: string | null): string {
  const excerpt = (body ?? '').trim().slice(0, 500);
  return `From GitHub #${number} (${url})${excerpt ? `\n\n${excerpt}` : ''}`;
}

export async function syncGitHubIssues(
  db: Database.Database,
  project: Project,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? fetch;

  const ref = parseGitHubRepo(project.git_remote || '');
  if (!ref) return { created: 0, total: 0, skippedThrottle: false };

  const last = lastSyncAt.get(project.id);
  if (last !== undefined && now() - last < THROTTLE_MS) {
    return { created: 0, total: 0, skippedThrottle: true };
  }
  lastSyncAt.set(project.id, now());

  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const issues = await fetchOpenIssues(ref, token, fetchImpl);

  const existing = db.prepare(
    "SELECT 1 FROM tasks WHERE project_id = ? AND external_source = 'github' AND external_id = ?",
  );
  const insert = db.prepare(
    'INSERT INTO tasks (id, project_id, title, description, status, priority, external_source, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  let created = 0;
  const insertNew = db.transaction((list: typeof issues) => {
    for (const issue of list) {
      const externalId = String(issue.number);
      if (existing.get(project.id, externalId)) continue;
      const ts = new Date().toISOString();
      insert.run(
        uuid(), project.id,
        `[#${issue.number}] ${issue.title}`,
        issueBody(issue.number, issue.html_url, issue.body),
        'triage', 'medium', 'github', externalId, ts, ts,
      );
      created++;
    }
  });
  insertNew(issues);

  return { created, total: issues.length, skippedThrottle: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/github-sync.test.ts`
Expected: PASS — all five tests green.

- [ ] **Step 5: Commit**

```bash
git add src/backend/github/sync.ts src/backend/test/github-sync.test.ts
git commit -m "feat(github): throttled, deduped sync of open issues into triage tasks"
```

---

## Task 6: Wire detection + sync route into project routes

**Files:**
- Modify: `src/backend/routes/projects.ts` (imports top of file; POST handler lines 95-134; PUT handler lines 136-159; add new route)
- Test: `src/backend/test/routes-projects.test.ts` (extend) — note this test file's inline schema must gain the new columns.

- [ ] **Step 1: Update the test harness schema and add a sync-route test**

In `src/backend/test/routes-projects.test.ts`, update the inline `projects` CREATE TABLE (lines 14-24) to include `git_remote`, and the `tasks` CREATE TABLE (lines 25-36) to include the external columns:

```typescript
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

Then append a new test at the end of the file:

```typescript
test('POST /api/projects/:id/github/sync creates triage tasks from open issues', async () => {
  const { app, db, dir } = makeApp();
  try {
    // Point project-a at a GitHub remote and stub the network via the route's fetch.
    db.prepare("UPDATE projects SET git_remote = 'git@github.com:o/r.git' WHERE id = 'project-a'").run();
    const { __resetThrottle } = await import('../github/sync');
    __resetThrottle();

    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => new Response(
      JSON.stringify([{ number: 7, title: 'Bug', body: 'b', html_url: 'https://github.com/o/r/issues/7' }]),
      { status: 200 },
    );
    try {
      const res = await app.inject({ method: 'POST', url: '/api/projects/project-a/github/sync' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { created: 1, total: 1 });
    } finally {
      (globalThis as any).fetch = realFetch;
    }

    const row = db.prepare("SELECT title, status, external_id FROM tasks WHERE project_id = 'project-a'").get() as any;
    assert.equal(row.title, '[#7] Bug');
    assert.equal(row.status, 'triage');
    assert.equal(row.external_id, '7');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/routes-projects.test.ts`
Expected: FAIL — `POST /api/projects/project-a/github/sync` returns 404 (route not registered).

- [ ] **Step 3: Add imports to `routes/projects.ts`**

At the top of `src/backend/routes/projects.ts`, after the existing imports (line 8), add:

```typescript
import { detectGitRemote } from '../github/repo.js';
import { syncGitHubIssues } from '../github/sync.js';
import { GitHubError } from '../github/client.js';
```

- [ ] **Step 4: Detect the remote on project create**

In the POST `/api/projects` handler, the project object is built at lines 110-120 and inserted at lines 122-123. Replace the insert so `git_remote` is detected and stored. Change the `project` object to include `git_remote`, detect before the INSERT, and widen the INSERT:

```typescript
    const gitRemote = await detectGitRemote(repoPath);

    const project = {
      id: uuid(),
      slug,
      name: body.name,
      description: body.description || '',
      repo_path: repoPath,
      config_json: '{}',
      sort_order: nextSortOrder,
      git_remote: gitRemote,
      created_at: now,
      updated_at: now,
    };

    db.prepare('INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.slug, project.name, project.description, project.repo_path, project.config_json, project.sort_order, project.git_remote, project.created_at, project.updated_at);
```

- [ ] **Step 5: Re-detect on repo_path change in PUT**

In the PUT `/api/projects/:id` handler, after the repo-path validation (after line 152) and before the `now`/UPDATE at lines 154-156, add detection when the path changed, then include `git_remote` in the UPDATE:

```typescript
    const gitRemote = repoPath !== undefined ? await detectGitRemote(repoPath) : undefined;

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), repo_path = COALESCE(?, repo_path), config_json = COALESCE(?, config_json), git_remote = COALESCE(?, git_remote), updated_at = ? WHERE id = ?')
      .run(body.name ?? null, body.description ?? null, repoPath ?? null, body.config_json ?? null, gitRemote ?? null, now, id);
```

- [ ] **Step 6: Add the sync route**

In `src/backend/routes/projects.ts`, after the GET `/api/projects/:id/tasks` route (after line 171), add:

```typescript
  fastify.post('/api/projects/:id/github/sync', async (request) => {
    const { id } = request.params as { id: string };
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!project) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }
    try {
      const { created, total } = await syncGitHubIssues(db, project);
      return { created, total };
    } catch (err) {
      if (err instanceof GitHubError) {
        insertNotification(db, {
          level: 'error',
          title: 'GitHub sync failed',
          message: `${project.name}: ${err.message}`,
        });
        return { created: 0, total: 0 };
      }
      throw err;
    }
  });
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd src/backend && npx tsx --test test/routes-projects.test.ts`
Expected: PASS — including the new sync-route test.

- [ ] **Step 8: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS — no errors.

- [ ] **Step 9: Commit**

```bash
git add src/backend/routes/projects.ts src/backend/test/routes-projects.test.ts
git commit -m "feat(projects): detect git remote on save and add github sync route"
```

---

## Task 7: Frontend — API method + sync on Kanban open

**Files:**
- Modify: `src/frontend/src/api.ts` (projects block, lines 66-79)
- Modify: `src/frontend/src/App.tsx` (add an effect near the existing task-loading effects, lines 124-150)

- [ ] **Step 1: Add the `githubSync` API method**

In `src/frontend/src/api.ts`, inside `api.projects` (after the `createTask` entry at line 78), add:

```typescript
    githubSync: (id: string) =>
      fetchJson<{ created: number; total: number }>(`/api/projects/${id}/github/sync`, { method: 'POST' }),
```

- [ ] **Step 2: Trigger sync when the Kanban opens for a project**

In `src/frontend/src/App.tsx`, after the existing effect that loads tasks when `activeProjectId` changes (the effect at lines 128-137), add a new effect that syncs GitHub issues whenever the Kanban subview is shown for a project, then reloads tasks:

```typescript
  useEffect(() => {
    if (!activeProjectId || subView !== 'kanban') return;
    let cancelled = false;
    (async () => {
      try {
        const { created } = await api.projects.githubSync(activeProjectId);
        if (!cancelled && created > 0) await loadTasks(activeProjectId);
      } catch (err) {
        console.error('GitHub sync failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [activeProjectId, subView, loadTasks]);
```

- [ ] **Step 3: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/api.ts src/frontend/src/App.tsx
git commit -m "feat(frontend): sync GitHub issues when opening a project's Kanban"
```

---

## Task 8: Frontend — show the tracked repo in the project modal

**Files:**
- Modify: `src/frontend/src/components/ProjectModal.tsx` (Repository Path block, lines 48-58)

- [ ] **Step 1: Add a read-only repo line under the Repository Path field**

In `src/frontend/src/components/ProjectModal.tsx`, the modal already receives the `project` prop (with `git_remote` available in edit mode). After the Repository Path `<div>` (which closes at line 58), add a read-only line shown only when editing:

```tsx
          {isEditing && (
            <div>
              <label className="block text-xs text-faint mb-1">Git repository</label>
              <p className="text-sm font-mono text-muted">
                {parseRepoLabel(project?.git_remote) ?? 'none detected'}
              </p>
              <p className="text-[10px] text-faint mt-1">Detected from the repository's git remote. Open issues sync into Triage.</p>
            </div>
          )}
```

- [ ] **Step 2: Add the `parseRepoLabel` helper**

At the top of `src/frontend/src/components/ProjectModal.tsx`, below the imports (after line 2), add a small helper that reduces a remote URL to `owner/repo` for display (frontend-local; the backend stores the raw URL):

```tsx
/** Reduce a github remote URL to "owner/repo" for display; null if not GitHub. */
function parseRepoLabel(remote?: string): string | null {
  if (!remote) return null;
  const m = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
```

- [ ] **Step 3: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/ProjectModal.tsx
git commit -m "feat(frontend): show the tracked GitHub repo in the project modal"
```

---

## Task 9: Full verification

- [ ] **Step 1: Run the full backend test suite**

Run: `npm run --workspace=src/backend test`
Expected: PASS — all tests, including the four new github-* files.

- [ ] **Step 2: Typecheck everything**

Run: `npm run typecheck`
Expected: PASS — shared, backend, frontend all clean.

- [ ] **Step 3: Manual smoke (optional, requires a real GitHub repo on disk)**

- Create or edit a project whose `repo_path` is a local clone of a GitHub repo.
- Open its Kanban. Within a moment, open issues appear as `[#N] title` cards in Triage.
- Move one to In Progress, re-open the Kanban: the card stays in In Progress and is not duplicated.
- For a private repo, set `GITHUB_TOKEN` in the backend environment before launching; without it a private repo surfaces a "GitHub sync failed" notification and the board still loads.

- [ ] **Step 4: Final commit (if any uncommitted changes remain)**

```bash
git status
# commit anything outstanding with an appropriate message
```

---

## Self-Review notes (for the implementer)

- **Throttle is in-memory and process-global** — it resets on backend restart (acceptable; first navigation after restart syncs). Tests call `__resetThrottle()` for isolation.
- **No auto-deletion**: issues closed on GitHub simply stop appearing in the `state=open` feed; existing tasks are never removed or moved by sync. Deleting a task while its issue is still open will let the next post-window sync recreate it in Triage — this is the agreed behavior.
- **Token**: `process.env.GITHUB_TOKEN`, optional. Public repos sync unauthenticated (subject to GitHub's lower anonymous rate limit).
- **Detection failures never block a save** — `detectGitRemote` returns `''` on any error.
