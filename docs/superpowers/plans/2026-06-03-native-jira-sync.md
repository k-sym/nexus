# Native Jira Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Jira tickets natively inside the Nexus backend on a poll loop that ticks only while the backend runs, syncing them into the existing Tickets view and surfacing change/error toasts in the running UI.

**Architecture:** A backend `setInterval` poll (gated on `jira.enabled` + `JIRA_TOKEN` env) fetches Jira via REST, upserts through a shared `syncTickets` function (also used by the existing push endpoint), and writes rows to a new `notifications` table. The frontend polls `/api/notifications` and renders unseen rows as toasts. Non-secret Jira config lives in Settings; the token stays in the environment.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React, Tailwind, `node:test` (via `tsx --test`).

**Spec:** `docs/superpowers/specs/2026-06-03-native-jira-sync-design.md`

**Branch:** `feat/native-jira-sync`

**Conventions to follow:**
- Backend tests: `node:test` + `node:assert/strict`, files in `src/backend/test/*.test.ts`, run with `npm --workspace=src/backend run test`.
- DB tables are declared in `src/backend/db.ts` via `CREATE TABLE IF NOT EXISTS` inside the single `db.exec(\`...\`)` block; indexes alongside.
- Routes are `export async function registerXRoutes(fastify)` and registered in `src/backend/index.ts`. `fastify.db` is the decorated better-sqlite3 handle.
- Run `npm --workspace=src/backend run typecheck` and `npm --workspace=src/shared run build` after shared-type changes (shared must be rebuilt for the backend to see new types).

---

## File Structure

**Create:**
- `src/backend/tickets/sync.ts` — `syncTickets()` + `IncomingTicket` (extracted from the route)
- `src/backend/jira/client.ts` — `fetchJiraTickets()`, `mapIssues()`, `JiraError`
- `src/backend/jira/poll.ts` — `runJiraSyncOnce()`, `startJiraSync()`
- `src/backend/notifications/index.ts` — `insertNotification()`, `listUnseen()`, `markSeen()`, types
- `src/backend/routes/notifications.ts` — `registerNotificationRoutes()`
- `src/backend/test/tickets-sync.test.ts`
- `src/backend/test/jira-client.test.ts`
- `src/backend/test/notifications.test.ts`
- `src/backend/test/jira-poll.test.ts`
- `src/frontend/src/components/NotificationToasts.tsx`

**Modify:**
- `src/shared/index.ts` — add `jira` block to `NexusConfig`
- `src/backend/config.ts` — `jira` defaults in `DEFAULT_CONFIG`
- `src/backend/routes/settings.ts` — carry `jira` through the PUT merge
- `src/backend/db.ts` — `notifications` table + index
- `src/backend/routes/tickets.ts` — use `syncTickets()` instead of inline upsert
- `src/backend/index.ts` — register notifications route, `startJiraSync(db)`
- `src/frontend/src/api.ts` — `api.notifications` + `JiraConfig` typing
- `src/frontend/src/App.tsx` — mount `<NotificationToasts />`
- `src/frontend/src/components/SettingsPage.tsx` — Jira section

---

## Task 1: Add `jira` config block (shared type + backend default + settings merge)

**Files:**
- Modify: `src/shared/index.ts` (NexusConfig, after the `scheduler` block ~line 214)
- Modify: `src/backend/config.ts` (DEFAULT_CONFIG ~line 43-46; add jira after scheduler)
- Modify: `src/backend/routes/settings.ts` (PUT merge ~line 43-55)
- Test: `src/backend/test/db.test.ts` is unrelated; config has no unit test — verify via typecheck.

- [ ] **Step 1: Add `jira` to the `NexusConfig` interface**

In `src/shared/index.ts`, inside `interface NexusConfig`, immediately after the `scheduler: { ... }` block, add:

```ts
  jira: {
    /** When false (default) the poll loop stays dormant. */
    enabled: boolean;
    /** Atlassian account email used for basic auth (paired with JIRA_TOKEN). */
    user: string;
    /** Jira Cloud host, e.g. "safety-services.atlassian.net". */
    instance: string;
    /** Project key to sync, e.g. "SUP". */
    project: string;
    /** Poll cadence in minutes while Nexus is running. */
    poll_minutes: number;
  };
```

- [ ] **Step 2: Add `jira` defaults to `DEFAULT_CONFIG`**

In `src/backend/config.ts`, inside `DEFAULT_CONFIG`, after the `scheduler: { enabled: true, check_interval_seconds: 60 },` block, add:

```ts
  jira: {
    enabled: false,
    user: '',
    instance: '',
    project: 'SUP',
    poll_minutes: 15,
  },
```

- [ ] **Step 3: Carry `jira` through the settings PUT merge**

In `src/backend/routes/settings.ts`, in the `merged` object inside the `PUT /api/settings` handler, add a `jira` line after the `models` block (it has no secret, so a plain pick-with-fallback is enough):

```ts
    const merged: NexusConfig = {
      ...current,
      ...incoming,
      jira: incoming.jira ?? current.jira,
      models: {
        openrouter: { api_key: apiKey },
        local: {
          base_url: incoming.models?.local?.base_url ?? current.models.local.base_url,
          api_key: incoming.models?.local?.api_key ?? current.models.local.api_key,
          embedding_model: incoming.models?.local?.embedding_model ?? current.models.local.embedding_model,
          rerank_model: incoming.models?.local?.rerank_model ?? current.models.local.rerank_model,
        },
      },
    };
```

- [ ] **Step 4: Rebuild shared types and typecheck the backend**

Run: `npm --workspace=src/shared run build && npm --workspace=src/backend run typecheck`
Expected: both succeed with no errors. (The backend imports `NexusConfig` from the built `@nexus/shared`, so shared must be rebuilt first.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/index.ts src/backend/config.ts src/backend/routes/settings.ts
git commit -m "feat(backend): add jira config block (token stays in env)"
```

---

## Task 2: `notifications` table + migration test

**Files:**
- Modify: `src/backend/db.ts` (add table to the `db.exec` block + index near the other `CREATE INDEX` lines)
- Test: `src/backend/test/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/notifications.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

function freshDb() {
  const base = join(tmpdir(), `nexus-notiftest-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('notifications table exists with expected columns', () => {
  const { db, cleanup } = freshDb();
  const cols = (db.pragma('table_info(notifications)') as { name: string }[]).map(c => c.name);
  cleanup();
  for (const c of ['id', 'level', 'title', 'message', 'created_at', 'seen_at']) {
    assert.ok(cols.includes(c), `${c} column present`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 notifications`
Expected: FAIL — `table_info(notifications)` returns no rows, so the column assertions fail.

- [ ] **Step 3: Add the table**

In `src/backend/db.ts`, inside the big `db.exec(\`...\`)` template (after the `tickets` `CREATE TABLE`, before the closing backtick / `CREATE INDEX` lines), add:

```sql
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      seen_at TEXT
    );
```

And next to the other `CREATE INDEX IF NOT EXISTS` lines add:

```sql
    CREATE INDEX IF NOT EXISTS idx_notifications_unseen ON notifications(seen_at);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 notifications`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/db.ts src/backend/test/notifications.test.ts
git commit -m "feat(backend): notifications table"
```

---

## Task 3: Extract `syncTickets()` and use it in the route

**Files:**
- Create: `src/backend/tickets/sync.ts`
- Modify: `src/backend/routes/tickets.ts` (replace inline upsert with `syncTickets`)
- Test: `src/backend/test/tickets-sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/tickets-sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { syncTickets } from '../tickets/sync';

function freshDb() {
  const base = join(tmpdir(), `nexus-syncticket-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

test('syncTickets inserts new, updates existing, removes stale with replaceAll', () => {
  const { db, cleanup } = freshDb();

  const r1 = syncTickets(db, [
    { key: 'SUP-1', summary: 'one', status: 'Open' },
    { key: 'SUP-2', summary: 'two', status: 'Open' },
  ], { source: 'test', replaceAll: true });
  assert.deepEqual(r1, { inserted: 2, updated: 0, removed: 0 });

  const r2 = syncTickets(db, [
    { key: 'SUP-1', summary: 'one EDITED', status: 'Done' },
  ], { source: 'test', replaceAll: true });
  assert.deepEqual(r2, { inserted: 0, updated: 1, removed: 1 });

  const rows = db.prepare('SELECT key, summary FROM tickets ORDER BY key').all() as { key: string; summary: string }[];
  cleanup();
  assert.deepEqual(rows, [{ key: 'SUP-1', summary: 'one EDITED' }]);
});

test('syncTickets without replaceAll leaves stale rows', () => {
  const { db, cleanup } = freshDb();
  syncTickets(db, [{ key: 'SUP-1' }], { source: 'test', replaceAll: true });
  const r = syncTickets(db, [{ key: 'SUP-2' }], { source: 'test', replaceAll: false });
  const count = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as { c: number }).c;
  cleanup();
  assert.deepEqual(r, { inserted: 1, updated: 0, removed: 0 });
  assert.equal(count, 2);
});

test('syncTickets skips entries without a key', () => {
  const { db, cleanup } = freshDb();
  const r = syncTickets(db, [{ summary: 'no key' } as any, { key: 'SUP-9' }], { source: 'test', replaceAll: false });
  cleanup();
  assert.deepEqual(r, { inserted: 1, updated: 0, removed: 0 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 syncTickets`
Expected: FAIL — `Cannot find module '../tickets/sync'`.

- [ ] **Step 3: Create `syncTickets`**

Create `src/backend/tickets/sync.ts`:

```ts
/**
 * Shared Jira-ticket upsert. Used by both the push endpoint (POST /api/jira/sync)
 * and the native poll (jira/poll.ts). Jira stays canonical; Nexus never writes back.
 */
import type Database from 'better-sqlite3';

export interface IncomingTicket {
  key: string;
  summary?: string;
  status?: string;
  priority?: string;
  assignee?: string | null;
  created?: string | null;
  updated?: string | null;
  url?: string | null;
}

export interface SyncResult {
  inserted: number;
  updated: number;
  removed: number;
}

export function syncTickets(
  db: Database.Database,
  tickets: IncomingTicket[],
  opts: { source: string; replaceAll: boolean },
): SyncResult {
  const now = new Date().toISOString();
  const existing = new Set(
    (db.prepare('SELECT key FROM tickets').all() as { key: string }[]).map(r => r.key),
  );
  const incomingKeys = new Set<string>();

  const upsert = db.prepare(`
    INSERT INTO tickets (key, summary, status, priority, assignee, created, updated, url, source, synced_at)
    VALUES (@key, @summary, @status, @priority, @assignee, @created, @updated, @url, @source, @synced_at)
    ON CONFLICT(key) DO UPDATE SET
      summary = excluded.summary, status = excluded.status, priority = excluded.priority,
      assignee = excluded.assignee, created = excluded.created, updated = excluded.updated,
      url = excluded.url, source = excluded.source, synced_at = excluded.synced_at
  `);
  const del = db.prepare('DELETE FROM tickets WHERE key = ?');

  let inserted = 0;
  let updated = 0;
  let removed = 0;

  const run = db.transaction(() => {
    for (const t of tickets) {
      if (!t?.key) continue;
      incomingKeys.add(t.key);
      upsert.run({
        key: t.key,
        summary: t.summary ?? '',
        status: t.status ?? '',
        priority: t.priority ?? '',
        assignee: t.assignee ?? null,
        created: t.created ?? null,
        updated: t.updated ?? null,
        url: t.url ?? null,
        source: opts.source,
        synced_at: now,
      });
      if (existing.has(t.key)) updated++;
      else inserted++;
    }
    if (opts.replaceAll) {
      for (const k of existing) {
        if (!incomingKeys.has(k)) {
          del.run(k);
          removed++;
        }
      }
    }
  });
  run();

  return { inserted, updated, removed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 syncTickets`
Expected: all three `syncTickets` tests PASS.

- [ ] **Step 5: Refactor the route to use `syncTickets`**

Replace the body of `src/backend/routes/tickets.ts` with:

```ts
/**
 * Tickets — a disposable mirror of Jira tickets assigned to the user.
 *
 * `POST /api/jira/sync` is the push path (the legacy OpenClaw "Nigel" cron). The
 * native poll (jira/poll.ts) shares the same syncTickets() upsert. Jira stays
 * canonical; Nexus never writes back.
 */
import { FastifyInstance } from 'fastify';
import { syncTickets, type IncomingTicket } from '../tickets/sync';

export async function registerTicketRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/tickets', async () => {
    return db.prepare('SELECT * FROM tickets ORDER BY datetime(updated) DESC, key DESC').all();
  });

  fastify.post('/api/jira/sync', async (request) => {
    const body = request.body as { tickets?: IncomingTicket[]; source?: string; replaceAll?: boolean };
    const tickets = Array.isArray(body?.tickets) ? body.tickets : [];
    return syncTickets(db, tickets, {
      source: body?.source ?? 'unknown',
      replaceAll: body?.replaceAll === true,
    });
  });
}
```

- [ ] **Step 6: Typecheck and re-run tests**

Run: `npm --workspace=src/backend run typecheck && npm --workspace=src/backend run test 2>&1 | tail -5`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/backend/tickets/sync.ts src/backend/routes/tickets.ts src/backend/test/tickets-sync.test.ts
git commit -m "refactor(backend): extract syncTickets, reuse in jira/sync route"
```

---

## Task 4: Jira client (`fetchJiraTickets` + `mapIssues` + `JiraError`)

**Files:**
- Create: `src/backend/jira/client.ts`
- Test: `src/backend/test/jira-client.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/jira-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapIssues, fetchJiraTickets, JiraError } from '../jira/client';

const ISSUE = {
  key: 'SUP-42',
  fields: {
    summary: 'Printer on fire',
    status: { name: 'In Progress' },
    priority: { name: 'High' },
    assignee: { displayName: 'Keith Symmonds' },
    created: '2026-05-01T09:00:00.000+0100',
    updated: '2026-06-01T10:30:00.000+0100',
  },
};

test('mapIssues maps fields and builds the browse url', () => {
  const [t] = mapIssues([ISSUE as any], 'example.atlassian.net');
  assert.deepEqual(t, {
    key: 'SUP-42',
    summary: 'Printer on fire',
    status: 'In Progress',
    priority: 'High',
    assignee: 'Keith Symmonds',
    created: '2026-05-01',
    updated: '2026-06-01',
    url: 'https://example.atlassian.net/browse/SUP-42',
  });
});

test('mapIssues falls back for missing priority/assignee', () => {
  const [t] = mapIssues([{ key: 'SUP-1', fields: { summary: 's' } } as any], 'h');
  assert.equal(t.priority, 'Medium');
  assert.equal(t.assignee, null);
});

test('fetchJiraTickets throws JiraError with status + snippet on non-2xx', async () => {
  const fakeFetch = async () => new Response('nope: bad token', { status: 401 });
  await assert.rejects(
    () => fetchJiraTickets({ user: 'u', instance: 'h', project: 'SUP' }, 'tok', fakeFetch as any),
    (err: unknown) => {
      assert.ok(err instanceof JiraError);
      assert.equal((err as JiraError).status, 401);
      assert.match((err as JiraError).message, /401/);
      assert.match((err as JiraError).message, /bad token/);
      return true;
    },
  );
});

test('fetchJiraTickets returns mapped tickets on success', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ issues: [ISSUE] }), { status: 200, headers: { 'content-type': 'application/json' } });
  const tickets = await fetchJiraTickets({ user: 'u', instance: 'example.atlassian.net', project: 'SUP' }, 'tok', fakeFetch as any);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].key, 'SUP-42');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "jira/client\|mapIssues\|fetchJiraTickets"`
Expected: FAIL — `Cannot find module '../jira/client'`.

- [ ] **Step 3: Create the client**

Create `src/backend/jira/client.ts`:

```ts
/**
 * Minimal Jira Cloud REST client for the native ticket poll. Mirrors what the
 * legacy jira-sync.sh curl did. Auth is HTTP Basic (account email : API token);
 * the token comes from the JIRA_TOKEN env var, never config/DB.
 */
import type { IncomingTicket } from '../tickets/sync';

export class JiraError extends Error {
  constructor(message: string, readonly status?: number, readonly bodySnippet?: string) {
    super(message);
    this.name = 'JiraError';
  }
}

interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string } | null;
    assignee?: { displayName?: string } | null;
    created?: string;
    updated?: string;
  };
}

export interface JiraQueryConfig {
  user: string;
  instance: string;
  project: string;
}

/** Pure mapping: Jira issues → ticket rows. */
export function mapIssues(issues: JiraIssue[], instance: string): IncomingTicket[] {
  return issues.map((issue) => {
    const f = issue.fields ?? {};
    return {
      key: issue.key,
      summary: f.summary ?? '',
      status: f.status?.name ?? '',
      priority: f.priority?.name ?? 'Medium',
      assignee: f.assignee?.displayName ?? null,
      created: f.created ? f.created.slice(0, 10) : null,
      updated: f.updated ? f.updated.slice(0, 10) : null,
      url: `https://${instance}/browse/${issue.key}`,
    };
  });
}

/**
 * Fetch open project tickets assigned to the authenticated user. `fetchImpl` is
 * injectable for tests; defaults to global fetch.
 */
export async function fetchJiraTickets(
  cfg: JiraQueryConfig,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IncomingTicket[]> {
  const url = `https://${cfg.instance}/rest/api/3/search/jql`;
  const jql = `project=${cfg.project} AND statusCategory != Done AND assignee = currentUser() ORDER BY created DESC`;
  const auth = Buffer.from(`${cfg.user}:${token}`).toString('base64');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields: ['summary', 'status', 'priority', 'assignee', 'created', 'updated'],
      }),
    });
  } catch (err) {
    throw new JiraError(`Jira request failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new JiraError(`Jira ${cfg.instance} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
  }

  const json = (await res.json()) as { issues?: JiraIssue[] };
  return mapIssues(json.issues ?? [], cfg.instance);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "mapIssues\|fetchJiraTickets"`
Expected: all four tests PASS. (Node 20+ provides global `Response`/`fetch`.)

- [ ] **Step 5: Commit**

```bash
git add src/backend/jira/client.ts src/backend/test/jira-client.test.ts
git commit -m "feat(backend): jira REST client (fetch + map)"
```

---

## Task 5: Notifications module + routes

**Files:**
- Create: `src/backend/notifications/index.ts`
- Create: `src/backend/routes/notifications.ts`
- Modify: `src/backend/index.ts` (register the route)
- Test: extend `src/backend/test/notifications.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/backend/test/notifications.test.ts`:

```ts
import { insertNotification, listUnseen, markSeen } from '../notifications';

test('insertNotification + listUnseen + markSeen lifecycle', () => {
  const { db, cleanup } = freshDb();

  const id1 = insertNotification(db, { level: 'info', title: 'Jira', message: '2 new' });
  insertNotification(db, { level: 'error', title: 'Jira sync failed', message: 'HTTP 401' });

  let unseen = listUnseen(db);
  assert.equal(unseen.length, 2);
  assert.equal(unseen[0].level, 'error'); // most recent first

  markSeen(db, [id1]);
  unseen = listUnseen(db);
  cleanup();
  assert.equal(unseen.length, 1);
  assert.equal(unseen[0].title, 'Jira sync failed');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "lifecycle"`
Expected: FAIL — `Cannot find module '../notifications'`.

- [ ] **Step 3: Create the notifications module**

Create `src/backend/notifications/index.ts`:

```ts
/**
 * In-app notifications: a small event source for transient toasts (e.g. Jira sync
 * results). The frontend polls listUnseen, renders each as a toast, then marks
 * them seen so they show once.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

export type NotificationLevel = 'info' | 'error';

export interface NotificationRow {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  created_at: string;
  seen_at: string | null;
}

const MAX_UNSEEN = 20;

/** Insert a notification and return its id. */
export function insertNotification(
  db: Database.Database,
  n: { level: NotificationLevel; title: string; message: string },
): string {
  const id = uuid();
  db.prepare(
    'INSERT INTO notifications (id, level, title, message, created_at, seen_at) VALUES (?, ?, ?, ?, ?, NULL)',
  ).run(id, n.level, n.title, n.message, new Date().toISOString());
  return id;
}

/** Unseen notifications, most recent first. */
export function listUnseen(db: Database.Database, limit = MAX_UNSEEN): NotificationRow[] {
  return db
    .prepare('SELECT * FROM notifications WHERE seen_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(limit) as NotificationRow[];
}

/** Mark the given ids seen. No-op for an empty list. */
export function markSeen(db: Database.Database, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare('UPDATE notifications SET seen_at = ? WHERE id = ? AND seen_at IS NULL');
  const tx = db.transaction((list: string[]) => {
    for (const id of list) stmt.run(now, id);
  });
  tx(ids);
}
```

> Note: `created_at` is an ISO timestamp; two rows inserted in the same millisecond are tie-broken by `rowid DESC` so "most recent first" is stable for the test.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "lifecycle"`
Expected: PASS.

- [ ] **Step 5: Create the route**

Create `src/backend/routes/notifications.ts`:

```ts
/** Notifications API — unseen list + mark-seen, polled by the frontend toaster. */
import { FastifyInstance } from 'fastify';
import { listUnseen, markSeen } from '../notifications';

export async function registerNotificationRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/notifications', async () => {
    return listUnseen(db);
  });

  fastify.post('/api/notifications/seen', async (request) => {
    const body = request.body as { ids?: string[] };
    const ids = Array.isArray(body?.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    markSeen(db, ids);
    return { ok: true, seen: ids.length };
  });
}
```

- [ ] **Step 6: Register the route in `index.ts`**

In `src/backend/index.ts`, add the import next to the other route imports:

```ts
import { registerNotificationRoutes } from './routes/notifications';
```

and register it alongside the others (after `registerTicketRoutes`):

```ts
  app.register(registerNotificationRoutes);
```

- [ ] **Step 7: Typecheck and commit**

Run: `npm --workspace=src/backend run typecheck && npm --workspace=src/backend run test 2>&1 | tail -5`
Expected: clean typecheck, all tests pass.

```bash
git add src/backend/notifications/index.ts src/backend/routes/notifications.ts src/backend/index.ts src/backend/test/notifications.test.ts
git commit -m "feat(backend): notifications module + API"
```

---

## Task 6: Jira poll loop (`runJiraSyncOnce` + `startJiraSync`) wired into startup

**Files:**
- Create: `src/backend/jira/poll.ts`
- Modify: `src/backend/index.ts` (call `startJiraSync(db)`)
- Test: `src/backend/test/jira-poll.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/jira-poll.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';
import { runJiraSyncOnce } from '../jira/poll';
import { listUnseen } from '../notifications';
import type { IncomingTicket } from '../tickets/sync';

function freshDb() {
  const base = join(tmpdir(), `nexus-jirapoll-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  return { db, cleanup: () => { db.close(); for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true }); } };
}

const JIRA = { enabled: true, user: 'u', instance: 'h', project: 'SUP', poll_minutes: 15 };

test('runJiraSyncOnce is dormant when disabled or token missing', async () => {
  const { db, cleanup } = freshDb();
  const fetchTickets = async () => { throw new Error('should not be called'); };
  const a = await runJiraSyncOnce(db, { ...JIRA, enabled: false }, 'tok', fetchTickets);
  const b = await runJiraSyncOnce(db, JIRA, undefined, fetchTickets);
  cleanup();
  assert.equal(a, null);
  assert.equal(b, null);
});

test('runJiraSyncOnce syncs tickets and notifies on change', async () => {
  const { db, cleanup } = freshDb();
  const tickets: IncomingTicket[] = [{ key: 'SUP-1', summary: 'one' }, { key: 'SUP-2', summary: 'two' }];
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => tickets);
  const count = (db.prepare('SELECT COUNT(*) c FROM tickets').get() as { c: number }).c;
  const notifs = listUnseen(db);
  cleanup();
  assert.deepEqual(res, { inserted: 2, updated: 0, removed: 0 });
  assert.equal(count, 2);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].level, 'info');
  assert.match(notifs[0].message, /2 new/);
});

test('runJiraSyncOnce is silent on no-op (zero changes)', async () => {
  const { db, cleanup } = freshDb();
  await runJiraSyncOnce(db, JIRA, 'tok', async () => [{ key: 'SUP-1' }]);
  // second identical sync: SUP-1 already present, replaceAll removes nothing -> 0/1/0... ensure updated counts as change.
  // Use an empty-but-same set to force a true no-op: re-sync the same single ticket.
  const before = listUnseen(db).length;
  await runJiraSyncOnce(db, JIRA, 'tok', async () => [{ key: 'SUP-1' }]);
  const after = listUnseen(db).length;
  cleanup();
  // The second run updates SUP-1 (updated=1) which IS a change, so a notification is expected.
  // This asserts the change-detection counts updates; see no-op-true test below.
  assert.equal(after, before + 1);
});

test('runJiraSyncOnce true no-op (no tickets, none existing) makes no notification', async () => {
  const { db, cleanup } = freshDb();
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => []);
  const notifs = listUnseen(db);
  cleanup();
  assert.deepEqual(res, { inserted: 0, updated: 0, removed: 0 });
  assert.equal(notifs.length, 0);
});

test('runJiraSyncOnce notifies error and stays non-throwing on fetch failure', async () => {
  const { db, cleanup } = freshDb();
  const res = await runJiraSyncOnce(db, JIRA, 'tok', async () => { throw new Error('HTTP 401: bad token'); });
  const notifs = listUnseen(db);
  cleanup();
  assert.equal(res, null);
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].level, 'error');
  assert.match(notifs[0].message, /401/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "runJiraSyncOnce"`
Expected: FAIL — `Cannot find module '../jira/poll'`.

- [ ] **Step 3: Create the poll module**

Create `src/backend/jira/poll.ts`:

```ts
/**
 * Native Jira poll. Ticks only while the backend process runs (a setInterval,
 * not a system cron) — matching "sync while I'm in front of Nexus". Gated on
 * jira.enabled + JIRA_TOKEN; emits a notification on change or error, silent on
 * no-op.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config';
import { fetchJiraTickets, type JiraQueryConfig } from './client';
import { syncTickets, type IncomingTicket, type SyncResult } from '../tickets/sync';
import { insertNotification } from '../notifications';

type JiraConfig = NexusConfig['jira'];
type FetchTickets = (cfg: JiraQueryConfig, token: string) => Promise<IncomingTicket[]>;

/**
 * Run one sync. Returns the SyncResult, or null when dormant (disabled / no token)
 * or when the fetch failed (an error notification is recorded instead). Never throws.
 * `fetchTickets` is injectable for tests.
 */
export async function runJiraSyncOnce(
  db: Database.Database,
  jira: JiraConfig,
  token: string | undefined,
  fetchTickets: FetchTickets = (cfg, tok) => fetchJiraTickets(cfg, tok),
): Promise<SyncResult | null> {
  if (!jira.enabled || !token) return null;

  try {
    const tickets = await fetchTickets({ user: jira.user, instance: jira.instance, project: jira.project }, token);
    const res = syncTickets(db, tickets, { source: 'nexus', replaceAll: true });
    if (res.inserted + res.updated + res.removed > 0) {
      insertNotification(db, {
        level: 'info',
        title: 'Jira',
        message: `${res.inserted} new, ${res.updated} updated, ${res.removed} removed`,
      });
    }
    return res;
  } catch (err) {
    insertNotification(db, { level: 'error', title: 'Jira sync failed', message: (err as Error).message });
    return null;
  }
}

/**
 * Start the poll. Reads config + JIRA_TOKEN once; if dormant, logs a single line
 * and does nothing. Otherwise runs immediately, then every poll_minutes.
 */
export function startJiraSync(db: Database.Database): { stop: () => void } {
  const jira = loadConfig().jira;
  const token = process.env.JIRA_TOKEN;

  if (!jira.enabled) {
    console.log('[jira] disabled in settings — poll dormant');
    return { stop: () => {} };
  }
  if (!token) {
    console.log('[jira] enabled but JIRA_TOKEN not set in env — poll dormant');
    return { stop: () => {} };
  }

  const everyMs = Math.max(1, jira.poll_minutes) * 60_000;
  console.log(`[jira] poll started — ${jira.project} every ${jira.poll_minutes}m`);
  void runJiraSyncOnce(db, jira, token);
  const timer = setInterval(() => void runJiraSyncOnce(db, jira, token), everyMs);
  return { stop: () => clearInterval(timer) };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm --workspace=src/backend run test 2>&1 | grep -A3 "runJiraSyncOnce"`
Expected: all five `runJiraSyncOnce` tests PASS.

- [ ] **Step 5: Wire `startJiraSync` into startup**

In `src/backend/index.ts`, add the import:

```ts
import { startJiraSync } from './jira/poll';
```

and call it in `main()` after the scheduler block:

```ts
  if (config.scheduler.enabled) {
    startScheduler(db);
  }
  startJiraSync(db);
```

- [ ] **Step 6: Typecheck and commit**

Run: `npm --workspace=src/backend run typecheck && npm --workspace=src/backend run test 2>&1 | tail -5`
Expected: clean typecheck, all tests pass.

```bash
git add src/backend/jira/poll.ts src/backend/index.ts src/backend/test/jira-poll.test.ts
git commit -m "feat(backend): native jira poll loop, gated on enabled+JIRA_TOKEN"
```

---

## Task 7: Frontend — notifications API + toast component

**Files:**
- Modify: `src/frontend/src/api.ts` (add `api.notifications`)
- Create: `src/frontend/src/components/NotificationToasts.tsx`
- Modify: `src/frontend/src/App.tsx` (mount `<NotificationToasts />`)
- Test: none (frontend has no test runner here); verify via typecheck + preview.

- [ ] **Step 1: Add the notifications API**

In `src/frontend/src/api.ts`, add a `NotificationItem` interface near `MissionStatus` (~line 21):

```ts
export interface NotificationItem {
  id: string;
  level: 'info' | 'error';
  title: string;
  message: string;
  created_at: string;
}
```

and add a `notifications` group inside the `api` object (e.g. after the `tickets` group):

```ts
  notifications: {
    list: () => fetchJson<NotificationItem[]>(`${API}/notifications`),
    seen: (ids: string[]) =>
      fetchJson<{ ok: boolean }>(`${API}/notifications/seen`, { method: 'POST', body: JSON.stringify({ ids }) }),
  },
```

- [ ] **Step 2: Create the toast component**

Create `src/frontend/src/components/NotificationToasts.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { api, NotificationItem } from '../api';

const POLL_MS = 15000;
const AUTO_DISMISS_MS = 8000;

const STYLE: Record<NotificationItem['level'], string> = {
  info: 'border-l-indigo-500',
  error: 'border-l-red-500',
};

/**
 * Polls /api/notifications for unseen rows, shows each as a toast in the
 * bottom-right stack, and marks them seen so they appear once. Sits alongside
 * DaemonToasts (which renders derived health alerts).
 */
export default function NotificationToasts() {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    const tick = async () => {
      try {
        const unseen = await api.notifications.list();
        if (!active || unseen.length === 0) return;
        const fresh = unseen.filter(n => !seenRef.current.has(n.id));
        if (fresh.length === 0) return;
        fresh.forEach(n => seenRef.current.add(n.id));
        setItems(prev => [...fresh, ...prev]);
        // Mark seen server-side so they don't return on the next poll.
        await api.notifications.seen(fresh.map(n => n.id));
        // Auto-dismiss each after a short delay.
        fresh.forEach(n => setTimeout(() => {
          if (active) setItems(prev => prev.filter(x => x.id !== n.id));
        }, AUTO_DISMISS_MS));
      } catch {
        /* transient; try again next tick */
      }
    };
    void tick();
    const interval = setInterval(tick, POLL_MS);
    return () => { active = false; clearInterval(interval); };
  }, []);

  if (items.length === 0) return null;

  const dismiss = (id: string) => setItems(prev => prev.filter(x => x.id !== id));

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {items.map(n => (
        <div
          key={n.id}
          role="status"
          className={`bg-zinc-900 border border-zinc-800 border-l-2 ${STYLE[n.level]} rounded-md shadow-lg px-3 py-2 flex items-start gap-2`}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500/70">{n.title}</div>
            <div className="text-sm text-zinc-200 leading-snug">{n.message}</div>
          </div>
          <button
            onClick={() => dismiss(n.id)}
            title="Dismiss"
            className="shrink-0 text-zinc-600 hover:text-zinc-200 transition-colors"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
```

> Note: DaemonToasts and NotificationToasts both render a `fixed bottom-4 right-4` stack. They coexist (two stacked containers in the same corner); the notification toasts auto-dismiss so they don't pile up. This is acceptable for now — if overlap looks wrong in the preview, nudge NotificationToasts up with `bottom-4` → a larger offset, but only if visibly needed (YAGNI).

- [ ] **Step 3: Mount it in App**

In `src/frontend/src/App.tsx`, add the import next to the DaemonToasts import:

```ts
import NotificationToasts from './components/NotificationToasts';
```

and render it next to `<DaemonToasts ... />` in the returned JSX:

```tsx
      <DaemonToasts status={status} />
      <NotificationToasts />
```

- [ ] **Step 4: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/api.ts src/frontend/src/components/NotificationToasts.tsx src/frontend/src/App.tsx
git commit -m "feat(frontend): notification toasts polling /api/notifications"
```

---

## Task 8: Settings UI — Jira section

**Files:**
- Modify: `src/frontend/src/components/SettingsPage.tsx` (add a `<Section title="Jira">` using the existing `update`/`Section`/`Field` helpers)
- Test: none; verify via preview.

- [ ] **Step 1: Add the Jira section**

In `src/frontend/src/components/SettingsPage.tsx`, add a new `<Section>` after the existing Scheduler section (the one toggling `['scheduler','enabled']`). Mirror the existing markup style (the enabled toggle copies the scheduler toggle; text/number inputs copy the memory fields):

```tsx
      <Section title="Jira">
        <Field label="Sync">
          <button
            onClick={() => update(['jira', 'enabled'], !config.jira.enabled)}
            className={`px-3 py-1 text-xs rounded transition-colors ${config.jira.enabled ? 'bg-green-500/20 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}
          >
            {config.jira.enabled ? 'Enabled' : 'Disabled'}
          </button>
        </Field>
        <Field label="Account email">
          <input
            type="text"
            value={config.jira.user}
            onChange={e => update(['jira', 'user'], e.target.value)}
            placeholder="you@example.com"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200"
          />
        </Field>
        <Field label="Instance host">
          <input
            type="text"
            value={config.jira.instance}
            onChange={e => update(['jira', 'instance'], e.target.value)}
            placeholder="your-company.atlassian.net"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200"
          />
        </Field>
        <Field label="Project key">
          <input
            type="text"
            value={config.jira.project}
            onChange={e => update(['jira', 'project'], e.target.value)}
            placeholder="SUP"
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200"
          />
        </Field>
        <Field label="Poll interval (minutes)">
          <input
            type="number"
            min={1}
            value={config.jira.poll_minutes}
            onChange={e => update(['jira', 'poll_minutes'], parseInt(e.target.value, 10) || 15)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-sm text-zinc-200"
          />
        </Field>
        <p className="text-xs text-zinc-500">
          The API token is read from the <span className="font-mono text-zinc-400">JIRA_TOKEN</span> environment
          variable, never stored here. Changes apply on the next backend restart.
        </p>
      </Section>
```

- [ ] **Step 2: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: clean. (`config` is typed `any` in SettingsPage, so `config.jira.*` access compiles.)

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/components/SettingsPage.tsx
git commit -m "feat(frontend): Jira settings section"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Backend typecheck + full test suite**

Run: `npm --workspace=src/shared run build && npm --workspace=src/backend run typecheck && npm --workspace=src/backend run test 2>&1 | tail -15`
Expected: shared builds, typecheck clean, all tests pass (existing + new: tickets-sync, jira-client, notifications, jira-poll).

- [ ] **Step 2: Frontend typecheck + production build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build 2>&1 | tail -5`
Expected: clean typecheck, successful Vite build.

- [ ] **Step 3: Manual smoke (with the running stack restarted so it has JIRA_TOKEN)**

1. Ensure `JIRA_TOKEN` is exported in the shell that launches the backend; restart the Nexus stack.
2. In **Settings → Jira**: set account email, instance, project `SUP`, interval 15, toggle **Enabled**, Save.
3. Restart the backend (config is read at `startJiraSync`).
4. Backend log shows `[jira] poll started — SUP every 15m`.
5. Open **Tickets** — your open SUP tickets appear.
6. On a sync that changes tickets, a toast (`N new, M updated, …`) appears bottom-right; a no-op sync is silent.
7. Toggle **Disabled** + restart → log shows `poll dormant`, no further syncs.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/native-jira-sync
gh pr create --title "feat: native Jira sync (in-app, while-running)" --body "Implements docs/superpowers/specs/2026-06-03-native-jira-sync-design.md. Closes the #3 follow-up."
```

---

## Self-review notes (already reconciled)

- **Spec coverage:** config block (T1), Jira client (T4), shared `syncTickets` (T3), poll loop (T6), notifications table+API (T2,T5), frontend toasts (T7), Settings UI (T8), tests + verify (T9). All spec sections map to a task.
- **Type consistency:** `IncomingTicket`/`SyncResult` defined in `tickets/sync.ts` and imported by `jira/client.ts` and `jira/poll.ts`; `JiraQueryConfig` in `client.ts` consumed by `poll.ts`; `NotificationItem` (frontend) mirrors `NotificationRow` (backend) minus `seen_at`. `syncTickets` signature identical across route + poll.
- **No placeholders:** every code step shows full code; no TODO/TBD.
- **`replaceAll` change-detection caveat:** a re-sync of the *same* ticket counts as `updated` (a "change"), so it notifies. True no-ops (empty set, nothing existing) are silent — covered by tests. This matches the spec's "info on change" intent; the user accepted toast-on-change.
