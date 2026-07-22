# Monday.com Project Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link Nexus tasks to Monday.com items so a Monday item is the initiative, Nexus tasks are its children, progress rolls up to Monday, and agents can read the initiative they are working under.

**Architecture:** A new `src/backend/monday/` module mirroring the existing `jira/` and `github/` integrations: a GraphQL client, a disposable SQLite mirror of Monday items, a non-disposable link table, pure roll-up computation, and a throttled write path that only ever touches a configured roll-up column and the item's updates feed. Agents get three read-biased tools via a Pi extension plus linked-item context injected through `systemPromptOverride`. The UI adds a per-project Project Management view and a back-reference badge on Kanban cards.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, `@earendil-works/pi-coding-agent` extensions, React + Vite, `node:test` (backend) / vitest (frontend).

**Spec:** `project_docs/design/2026-07-22-monday-project-management-design.md`

## Global Constraints

- **Token source:** `MONDAY_TOKEN` environment variable only. Never `config.yaml`, never the DB.
- **Write invariant:** Nexus writes only the configured roll-up column and the updates feed. Never the status column, never any other column. No task may add a status write.
- **Link cardinality:** one Monday item per task (`task_id` is the link table's PRIMARY KEY). Many tasks per item.
- **Roll-up buckets:** `triage`+`todo` → open, `in_progress` → in progress, `review` → in review, `deploy` → done. Percentage is `done / total`.
- **200-with-errors:** Monday's API returns HTTP 200 with an `errors` array on failure. Every response must be checked for it. "Empty result" and "auth rejected" must never look alike.
- **Prune rule:** a `monday_items` row referenced by a link is never deleted — it is marked `state = 'missing'`.
- **Tool availability:** the Monday extension is omitted wholesale when Monday is disabled or unconfigured; `monday_post_update` is omitted unless that project's `updates.enabled` is true.
- **Migrations:** create indexes for new tables **after** the `CREATE TABLE` statements. The backend runs under `tsx watch` and re-runs migrations against the live DB.
- **Tests:** backend tests must `delete process.env.MONDAY_TOKEN` at the top of any file asserting unconfigured behaviour.
- **API version is pinned** in config (`monday.api_version`). Confirm the value against Monday's current supported versions during Task 2; pinning matters more than which version.

**Backend test command:** `npm run --workspace=src/backend test`
**Frontend test command:** `npm run --workspace=src/frontend test`
**Typecheck:** `npm run typecheck`

---

## File Structure

**Create:**
- `src/backend/monday/client.ts` — GraphQL transport, error mapping, complexity tracking, typed queries/mutations
- `src/backend/monday/map.ts` — pure Monday item → mirror row
- `src/backend/monday/rollup.ts` — pure task statuses → roll-up counts/text/percent
- `src/backend/monday/store.ts` — mirror + link table DB access
- `src/backend/monday/sync.ts` — scope sync, linked-item refresh, prune
- `src/backend/monday/writes.ts` — throttle/coalesce, column write, update post
- `src/backend/monday/poll.ts` — background linked-item refresh loop
- `src/backend/routes/monday.ts` — `/api/monday/*`
- `src/backend/pi/monday-tool.ts` — agent tool extension
- `src/backend/pi/monday-context.ts` — linked-item context block builder
- `src/frontend/src/components/ProjectManagementView.tsx`
- `src/frontend/src/components/MondayItemPicker.tsx`
- `src/frontend/src/components/MondayBadge.tsx`

**Modify:**
- `src/shared/index.ts` — `NexusConfig.monday`, `ProjectConfig.monday`, `MondayItem`, `TaskMondayLink`, `MONDAY_ROLLUP_BUCKETS`
- `src/backend/config.ts` — `monday` defaults
- `src/backend/db.ts` — two tables + three indexes
- `src/backend/activity/events.ts` — `monday_sync`, `monday_write` operation kinds
- `src/backend/index.ts` — register routes, start poll
- `src/backend/pi/runtime.ts` — wire Monday extension + context injection
- `src/backend/trust/snapshot.ts` — Monday secret source + mirror maintenance
- `src/frontend/src/api.ts` — Monday endpoints
- `src/frontend/src/components/KanbanBoard.tsx` — badge, links loaded with task list
- `src/frontend/src/components/SettingsPage.tsx` — Monday section

---

## Task 1: Foundation — types, config, schema

**Files:**
- Modify: `src/shared/index.ts`
- Modify: `src/backend/config.ts`
- Modify: `src/backend/db.ts`
- Modify: `src/backend/activity/events.ts`
- Test: `src/backend/test/monday-schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `MondayItem`, `TaskMondayLink`, `MondayProjectConfig`, `NexusConfig['monday']`, `ProjectConfig['monday']`, tables `monday_items` and `task_monday_links`, operation kinds `'monday_sync' | 'monday_write'`.

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-schema.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { getDb } from '../db';

function tempDb() {
  return getDb(':memory:');
}

test('monday_items and task_monday_links tables exist with expected columns', () => {
  const db: Database.Database = tempDb();
  const itemCols = (db.pragma('table_info(monday_items)') as { name: string }[]).map((c) => c.name);
  assert.ok(itemCols.includes('item_id'));
  assert.ok(itemCols.includes('board_id'));
  assert.ok(itemCols.includes('group_id'));
  assert.ok(itemCols.includes('state'));
  assert.ok(itemCols.includes('status_label'));
  assert.ok(itemCols.includes('column_values_json'));
  assert.ok(itemCols.includes('synced_at'));

  const linkCols = (db.pragma('table_info(task_monday_links)') as { name: string }[]).map((c) => c.name);
  assert.deepEqual(linkCols.sort(), ['created_at', 'item_id', 'project_id', 'task_id']);
  db.close();
});

test('task_monday_links enforces one item per task', () => {
  const db = tempDb();
  db.prepare('INSERT INTO task_monday_links (task_id, item_id, project_id, created_at) VALUES (?, ?, ?, ?)')
    .run('task-1', 'item-1', 'proj-1', '2026-07-22T00:00:00.000Z');
  assert.throws(
    () => db.prepare('INSERT INTO task_monday_links (task_id, item_id, project_id, created_at) VALUES (?, ?, ?, ?)')
      .run('task-1', 'item-2', 'proj-1', '2026-07-22T00:00:00.000Z'),
    /UNIQUE constraint failed/,
  );
  db.close();
});

test('monday indexes are created', () => {
  const db = tempDb();
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
    .map((r) => r.name);
  assert.ok(names.includes('idx_monday_items_board'));
  assert.ok(names.includes('idx_task_monday_links_item'));
  assert.ok(names.includes('idx_task_monday_links_project'));
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `table_info(monday_items)` returns an empty array, so `itemCols.includes('item_id')` is false.

- [ ] **Step 3: Add the shared types**

In `src/shared/index.ts`, after the `ProjectConfig` interface, add:

```ts
/** Which roll-up bucket each Kanban column contributes to. */
export const MONDAY_ROLLUP_BUCKETS: Record<TaskStatus, 'open' | 'inProgress' | 'inReview' | 'done'> = {
  triage: 'open',
  todo: 'open',
  in_progress: 'inProgress',
  review: 'inReview',
  deploy: 'done',
};

/** A mirrored Monday item. Disposable — Monday stays canonical. */
export interface MondayItem {
  item_id: string;
  board_id: string;
  board_name: string;
  group_id: string | null;
  group_title: string | null;
  name: string;
  /** 'missing' is Nexus-local: the item vanished from Monday but a link survives. */
  state: 'active' | 'archived' | 'deleted' | 'missing';
  status_label: string | null;
  status_color: string | null;
  /** JSON array of owner display names. */
  owners_json: string;
  url: string | null;
  /** Raw column values, keyed by column id. Context injection and the read
   *  tools need fields this schema does not model. */
  column_values_json: string;
  monday_updated_at: string | null;
  synced_at: string;
}

/** A task→item link. NOT disposable: user intent, survives a mirror wipe. */
export interface TaskMondayLink {
  task_id: string;
  item_id: string;
  project_id: string;
  created_at: string;
}

/** Per-project Monday scope and opt-ins, stored in projects.config_json. */
export interface MondayProjectConfig {
  board_id: string;
  /** Optional narrowing to a single group on the board. */
  group_id?: string | null;
  rollup: {
    enabled: boolean;
    column_id: string | null;
    /** Resolved when the column is chosen, not inferred per write: Monday
     *  column ids are user-renamable, so the id is not a reliable type hint. */
    column_type: 'text' | 'numeric';
  };
  updates: { enabled: boolean; min_interval_minutes: number };
}
```

Extend `ProjectConfig` in the same file:

```ts
export interface ProjectConfig {
  column_defaults: Record<TaskStatus, string | null>;
  monday?: MondayProjectConfig;
}
```

Extend `NexusConfig` — add after the `github` block, before the closing brace:

```ts
  monday: {
    /** When false the poll loop stays dormant and no tools are registered. */
    enabled: boolean;
    /** Pinned Monday API version. Monday dates its API; an unpinned client
     *  shifts under you. */
    api_version: string;
    /** Linked-item refresh cadence in minutes while Nexus is running. */
    poll_minutes: number;
  };
```

- [ ] **Step 4: Add the config defaults**

In `src/backend/config.ts`, after the `github` block in the defaults object:

```ts
  monday: {
    enabled: false,
    api_version: '2024-10',
    poll_minutes: 10,
  },
```

- [ ] **Step 5: Add the operation kinds**

In `src/backend/activity/events.ts`, extend `OperationKind`:

```ts
export type OperationKind =
  | 'chat_turn'
  | 'assistant_stream'
  | 'jira_sync'
  | 'github_sync'
  | 'monday_sync'
  | 'monday_write'
  | 'memory_archive'
  | 'memory_index'
  | 'mission_tick';
```

- [ ] **Step 6: Add the tables**

In `src/backend/db.ts`, inside the main schema `db.exec(...)` block, after the `tickets` table:

```sql
    CREATE TABLE IF NOT EXISTS monday_items (
      item_id            TEXT PRIMARY KEY,
      board_id           TEXT NOT NULL,
      board_name         TEXT NOT NULL DEFAULT '',
      group_id           TEXT,
      group_title        TEXT,
      name               TEXT NOT NULL DEFAULT '',
      state              TEXT NOT NULL DEFAULT 'active',
      status_label       TEXT,
      status_color       TEXT,
      owners_json        TEXT NOT NULL DEFAULT '[]',
      url                TEXT,
      column_values_json TEXT NOT NULL DEFAULT '{}',
      monday_updated_at  TEXT,
      synced_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_monday_links (
      task_id    TEXT PRIMARY KEY,
      item_id    TEXT NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
```

Then add the indexes **in the index block that runs after the tables** (alongside `idx_tickets_status`):

```sql
    CREATE INDEX IF NOT EXISTS idx_monday_items_board ON monday_items(board_id);
    CREATE INDEX IF NOT EXISTS idx_task_monday_links_item ON task_monday_links(item_id);
    CREATE INDEX IF NOT EXISTS idx_task_monday_links_project ON task_monday_links(project_id);
```

Both tables are new, so `CREATE TABLE IF NOT EXISTS` is sufficient — no `ALTER TABLE` migration is needed, and no index references a column added by a later recreate.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 3 tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/shared/index.ts src/backend/config.ts src/backend/db.ts src/backend/activity/events.ts src/backend/test/monday-schema.test.ts
git commit -m "feat(monday): types, config defaults, and mirror/link schema"
```

---

## Task 2: GraphQL client and item mapping

**Files:**
- Create: `src/backend/monday/client.ts`
- Create: `src/backend/monday/map.ts`
- Test: `src/backend/test/monday-client.test.ts`

**Interfaces:**
- Consumes: `MondayItem` from Task 1.
- Produces:
  - `class MondayError extends Error { code?: string; status?: number; bodySnippet?: string }`
  - `interface MondayClientOptions { token: string; apiVersion: string; fetchImpl?: typeof fetch }`
  - `mondayGraphql<T>(opts: MondayClientOptions, query: string, variables: Record<string, unknown>): Promise<T>`
  - `fetchBoardItems(opts, boardId: string, groupId: string | null): Promise<RawMondayItem[]>`
  - `fetchItemsByIds(opts, ids: string[]): Promise<RawMondayItem[]>`
  - `setSimpleColumnValue(opts, boardId: string, itemId: string, columnId: string, value: string): Promise<void>`
  - `createUpdate(opts, itemId: string, body: string): Promise<void>`
  - `interface RawMondayItem` (shape below)
  - `mapItem(raw: RawMondayItem, syncedAt: string): MondayItem` (from `map.ts`)

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mondayGraphql, fetchItemsByIds, MondayError } from '../monday/client';
import { mapItem } from '../monday/map';

const OPTS = { token: 'tok', apiVersion: '2024-10' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('mondayGraphql sends the token and pinned API version', async () => {
  let seen: RequestInit | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    seen = init;
    return jsonResponse({ data: { ok: true } });
  };
  await mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {});
  const headers = seen!.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'tok');
  assert.equal(headers['API-Version'], '2024-10');
});

test('200 with an errors array is a failure, not an empty result', async () => {
  const fakeFetch = async () => jsonResponse({
    errors: [{ message: 'Not Authenticated', extensions: { code: 'UserUnauthorizedException' } }],
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'UserUnauthorizedException');
      assert.match(err.message, /Not Authenticated/);
      return true;
    },
  );
});

test('an empty result is NOT reported as an error', async () => {
  const fakeFetch = async () => jsonResponse({ data: { items: [] } });
  const items = await fetchItemsByIds({ ...OPTS, fetchImpl: fakeFetch as any }, ['1']);
  assert.deepEqual(items, []);
});

test('429 carries the reset hint', async () => {
  const fakeFetch = async () => new Response('rate limited', {
    status: 429,
    headers: { 'retry-after': '17' },
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 17);
      return true;
    },
  );
});

test('complexity exhaustion is surfaced as a retryable error', async () => {
  const fakeFetch = async () => jsonResponse({
    errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'ComplexityException' } }],
    extensions: { complexity: { after: 0, reset_in_x_seconds: 42 } },
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'ComplexityException');
      assert.equal(err.retryAfterSeconds, 42);
      return true;
    },
  );
});

test('fetchItemsByIds returns the raw items', async () => {
  const fakeFetch = async () => jsonResponse({
    data: { items: [{ id: '1', name: 'Initiative A', state: 'active' }] },
  });
  const items = await fetchItemsByIds({ ...OPTS, fetchImpl: fakeFetch as any }, ['1']);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Initiative A');
});

const RAW = {
  id: '900',
  name: 'Ship the thing',
  state: 'active',
  updated_at: '2026-07-20T09:00:00Z',
  url: 'https://x.monday.com/boards/1/pulses/900',
  board: { id: '1', name: 'Portfolio' },
  group: { id: 'topics', title: 'Q3' },
  column_values: [
    { id: 'status', type: 'status', text: 'Working on it', value: '{"index":0}' },
    { id: 'person', type: 'people', text: 'Keith Symmonds', value: null },
    { id: 'text_mkxyz', type: 'text', text: '', value: null },
  ],
};

test('mapItem flattens status, owners, and keeps raw column values', () => {
  const row = mapItem(RAW as any, '2026-07-22T10:00:00.000Z');
  assert.equal(row.item_id, '900');
  assert.equal(row.board_id, '1');
  assert.equal(row.board_name, 'Portfolio');
  assert.equal(row.group_id, 'topics');
  assert.equal(row.group_title, 'Q3');
  assert.equal(row.name, 'Ship the thing');
  assert.equal(row.state, 'active');
  assert.equal(row.status_label, 'Working on it');
  assert.deepEqual(JSON.parse(row.owners_json), ['Keith Symmonds']);
  assert.equal(row.monday_updated_at, '2026-07-20T09:00:00Z');
  assert.equal(row.synced_at, '2026-07-22T10:00:00.000Z');
  const cols = JSON.parse(row.column_values_json);
  assert.equal(cols.text_mkxyz.type, 'text');
});

test('mapItem tolerates an item with no group, status, or owners', () => {
  const row = mapItem({ id: '5', name: 'Bare', state: 'active', column_values: [] } as any, 'now');
  assert.equal(row.group_id, null);
  assert.equal(row.status_label, null);
  assert.deepEqual(JSON.parse(row.owners_json), []);
  assert.equal(row.board_id, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/client'`.

- [ ] **Step 3: Write the client**

Create `src/backend/monday/client.ts`:

```ts
/**
 * Monday.com GraphQL client.
 *
 * The trap this file exists to avoid: Monday returns HTTP 200 with an
 * `errors` array for most failures — bad token, bad board id, malformed
 * query. A client that checks res.ok reads that as success and quietly
 * mirrors nothing. That is the same shape as the Jira bug where a wrong
 * `jira.user` gave 200-and-empty instead of 401. So every response is
 * checked for `errors` before its data is trusted, and "empty result" is
 * never allowed to look like "auth rejected".
 *
 * The token comes from MONDAY_TOKEN only — never config, never the DB.
 */

const ENDPOINT = 'https://api.monday.com/v2';

export class MondayError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = 'MondayError';
  }

  /** Rate limit and complexity exhaustion are worth retrying; auth is not. */
  get retryable(): boolean {
    return this.status === 429 || this.code === 'ComplexityException' || (this.status ?? 0) >= 500;
  }
}

export interface MondayClientOptions {
  token: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

interface GraphqlErrorShape {
  message?: string;
  extensions?: { code?: string };
}

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlErrorShape[];
  error_message?: string;
  extensions?: { complexity?: { after?: number; reset_in_x_seconds?: number } };
}

export interface RawMondayColumnValue {
  id: string;
  type?: string;
  text?: string | null;
  value?: string | null;
}

export interface RawMondayItem {
  id: string;
  name?: string;
  state?: string;
  updated_at?: string | null;
  url?: string | null;
  board?: { id?: string; name?: string } | null;
  group?: { id?: string; title?: string } | null;
  column_values?: RawMondayColumnValue[];
}

/** Single transport entry point. Every query and mutation goes through here. */
export async function mondayGraphql<T>(
  opts: MondayClientOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: opts.token,
        'API-Version': opts.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new MondayError(`Monday unreachable: ${(err as Error).message}`);
  }

  if (res.status === 429) {
    const hint = Number(res.headers.get('retry-after') ?? '');
    throw new MondayError('Monday rate limit exceeded', 'RateLimit', 429, Number.isFinite(hint) ? hint : undefined);
  }

  const text = await res.text();
  let body: GraphqlEnvelope<T>;
  try {
    body = JSON.parse(text) as GraphqlEnvelope<T>;
  } catch {
    throw new MondayError(`Monday returned non-JSON (${res.status})`, undefined, res.status, undefined, text.slice(0, 300));
  }

  // The load-bearing check. Do this BEFORE looking at res.ok or body.data.
  const errors = body.errors ?? (body.error_message ? [{ message: body.error_message }] : []);
  if (errors.length > 0) {
    const code = errors[0]?.extensions?.code;
    const reset = body.extensions?.complexity?.reset_in_x_seconds;
    throw new MondayError(
      errors.map((e) => e.message ?? 'unknown error').join('; '),
      code,
      res.status,
      code === 'ComplexityException' ? reset : undefined,
      text.slice(0, 300),
    );
  }

  if (!res.ok) {
    throw new MondayError(`Monday HTTP ${res.status}`, undefined, res.status, undefined, text.slice(0, 300));
  }
  if (body.data === undefined) {
    throw new MondayError('Monday response had no data field', undefined, res.status, undefined, text.slice(0, 300));
  }
  return body.data;
}

const ITEM_FIELDS = `
  id
  name
  state
  updated_at
  url
  board { id name }
  group { id title }
  column_values { id type text value }
`;

const BOARD_ITEMS_QUERY = `
  query BoardItems($boardId: ID!, $cursor: String) {
    boards(ids: [$boardId]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items { ${ITEM_FIELDS} }
      }
    }
  }
`;

const GROUP_ITEMS_QUERY = `
  query GroupItems($boardId: ID!, $groupId: String!, $cursor: String) {
    boards(ids: [$boardId]) {
      groups(ids: [$groupId]) {
        items_page(limit: 100, cursor: $cursor) {
          cursor
          items { ${ITEM_FIELDS} }
        }
      }
    }
  }
`;

interface ItemsPage { cursor: string | null; items: RawMondayItem[] }

/**
 * All items on a board, or on one group of it when groupId is set. Follows
 * the cursor to completion — initiative-level boards are small, and a partial
 * mirror would make the prune step delete live rows.
 */
export async function fetchBoardItems(
  opts: MondayClientOptions,
  boardId: string,
  groupId: string | null,
): Promise<RawMondayItem[]> {
  const out: RawMondayItem[] = [];
  let cursor: string | null = null;
  do {
    const page: ItemsPage | undefined = groupId
      ? (await mondayGraphql<{ boards?: { groups?: { items_page: ItemsPage }[] }[] }>(
          opts, GROUP_ITEMS_QUERY, { boardId, groupId, cursor },
        )).boards?.[0]?.groups?.[0]?.items_page
      : (await mondayGraphql<{ boards?: { items_page: ItemsPage }[] }>(
          opts, BOARD_ITEMS_QUERY, { boardId, cursor },
        )).boards?.[0]?.items_page;

    if (!page) break;
    out.push(...(page.items ?? []));
    cursor = page.cursor ?? null;
  } while (cursor);
  return out;
}

const ITEMS_BY_IDS_QUERY = `
  query ItemsByIds($ids: [ID!]!) {
    items(ids: $ids) { ${ITEM_FIELDS} }
  }
`;

/** Exactly the given items. Used by the linked-item refresh; flat in board size. */
export async function fetchItemsByIds(
  opts: MondayClientOptions,
  ids: string[],
): Promise<RawMondayItem[]> {
  if (ids.length === 0) return [];
  const data = await mondayGraphql<{ items?: RawMondayItem[] }>(opts, ITEMS_BY_IDS_QUERY, { ids });
  return data.items ?? [];
}

const SET_COLUMN_MUTATION = `
  mutation SetColumn($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
    change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
  }
`;

/**
 * Write one column. The ONLY column any caller may pass is the project's
 * configured roll-up column — see the write invariant in the spec. There is
 * deliberately no status-column helper here.
 */
export async function setSimpleColumnValue(
  opts: MondayClientOptions,
  boardId: string,
  itemId: string,
  columnId: string,
  value: string,
): Promise<void> {
  await mondayGraphql(opts, SET_COLUMN_MUTATION, { boardId, itemId, columnId, value });
}

const CREATE_UPDATE_MUTATION = `
  mutation PostUpdate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) { id }
  }
`;

/** Post to an item's updates feed. */
export async function createUpdate(
  opts: MondayClientOptions,
  itemId: string,
  body: string,
): Promise<void> {
  await mondayGraphql(opts, CREATE_UPDATE_MUTATION, { itemId, body });
}
```

- [ ] **Step 4: Write the mapper**

Create `src/backend/monday/map.ts`:

```ts
/** Pure Monday item → mirror row. No I/O, no clock — syncedAt is passed in. */
import type { MondayItem } from '@nexus/shared';
import type { RawMondayItem, RawMondayColumnValue } from './client.js';

/** The first status-type column is the item's headline status. */
function statusColumn(cols: RawMondayColumnValue[]): RawMondayColumnValue | undefined {
  return cols.find((c) => c.type === 'status');
}

/** People columns render as a comma-joined display-name list in `text`. */
function owners(cols: RawMondayColumnValue[]): string[] {
  const people = cols.find((c) => c.type === 'people');
  const text = people?.text?.trim();
  if (!text) return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Status colour lives in the column's JSON value, when present. */
function statusColor(col: RawMondayColumnValue | undefined): string | null {
  if (!col?.value) return null;
  try {
    const parsed = JSON.parse(col.value) as { color?: string } | null;
    return parsed?.color ?? null;
  } catch {
    return null;
  }
}

function isKnownState(state: string | undefined): state is MondayItem['state'] {
  return state === 'active' || state === 'archived' || state === 'deleted';
}

export function mapItem(raw: RawMondayItem, syncedAt: string): MondayItem {
  const cols = raw.column_values ?? [];
  const status = statusColumn(cols);
  const byId: Record<string, RawMondayColumnValue> = {};
  for (const c of cols) byId[c.id] = c;

  return {
    item_id: String(raw.id),
    board_id: raw.board?.id ? String(raw.board.id) : '',
    board_name: raw.board?.name ?? '',
    group_id: raw.group?.id ?? null,
    group_title: raw.group?.title ?? null,
    name: raw.name ?? '',
    state: isKnownState(raw.state) ? raw.state : 'active',
    status_label: status?.text?.trim() ? status.text.trim() : null,
    status_color: statusColor(status),
    owners_json: JSON.stringify(owners(cols)),
    url: raw.url ?? null,
    column_values_json: JSON.stringify(byId),
    monday_updated_at: raw.updated_at ?? null,
    synced_at: syncedAt,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 11 tests (3 from Task 1, 8 new).

- [ ] **Step 6: Confirm the pinned API version**

Check Monday's currently supported API versions and, if `2024-10` is no longer supported, update the default in `src/backend/config.ts` and the test's `OPTS`. Record the value you confirmed in the commit message.

- [ ] **Step 7: Commit**

```bash
git add src/backend/monday/client.ts src/backend/monday/map.ts src/backend/test/monday-client.test.ts
git commit -m "feat(monday): GraphQL client with 200-with-errors handling, and item mapping"
```

---

## Task 3: Roll-up computation

**Files:**
- Create: `src/backend/monday/rollup.ts`
- Test: `src/backend/test/monday-rollup.test.ts`

**Interfaces:**
- Consumes: `TaskStatus`, `MONDAY_ROLLUP_BUCKETS` from Task 1.
- Produces:
  - `interface RollupCounts { total: number; open: number; inProgress: number; inReview: number; done: number }`
  - `computeRollup(statuses: TaskStatus[]): RollupCounts`
  - `formatRollupText(counts: RollupCounts): string`
  - `formatRollupPercent(counts: RollupCounts): number`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-rollup.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRollup, formatRollupText, formatRollupPercent } from '../monday/rollup';

test('computeRollup buckets the five Kanban columns', () => {
  const counts = computeRollup(['triage', 'todo', 'in_progress', 'review', 'deploy']);
  assert.deepEqual(counts, { total: 5, open: 2, inProgress: 1, inReview: 1, done: 1 });
});

test('only deploy counts as done', () => {
  assert.equal(computeRollup(['review', 'review']).done, 0);
  assert.equal(computeRollup(['deploy', 'deploy']).done, 2);
});

test('formatRollupText always leads with done/total', () => {
  assert.equal(formatRollupText(computeRollup(['deploy', 'todo'])), '1/2 done');
});

test('formatRollupText appends review and progress only when non-zero', () => {
  assert.equal(
    formatRollupText(computeRollup(['deploy', 'deploy', 'deploy', 'review', 'in_progress'])),
    '3/5 done · 1 in review · 1 in progress',
  );
  assert.equal(formatRollupText(computeRollup(['deploy', 'review'])), '1/2 done · 1 in review');
  assert.equal(formatRollupText(computeRollup(['deploy', 'in_progress'])), '1/2 done · 1 in progress');
});

test('formatRollupText reports an empty link set distinctly', () => {
  assert.equal(formatRollupText(computeRollup([])), 'no linked tasks');
});

test('formatRollupPercent is done over total, rounded', () => {
  assert.equal(formatRollupPercent(computeRollup([])), 0);
  assert.equal(formatRollupPercent(computeRollup(['deploy', 'deploy', 'todo'])), 67);
  assert.equal(formatRollupPercent(computeRollup(['review', 'review'])), 0);
  assert.equal(formatRollupPercent(computeRollup(['deploy'])), 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="rollup"`
Expected: FAIL — `Cannot find module '../monday/rollup'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/rollup.ts`:

```ts
/**
 * Pure roll-up computation: linked task statuses → the value written to the
 * project's configured Monday column.
 *
 * Deploy is the only bucket that counts as done, so a numeric column reads 0
 * until work actually reaches Deploy. Review is broken out separately because
 * it is the state a human most often wants to act on.
 */
import { MONDAY_ROLLUP_BUCKETS, type TaskStatus } from '@nexus/shared';

export interface RollupCounts {
  total: number;
  open: number;
  inProgress: number;
  inReview: number;
  done: number;
}

export function computeRollup(statuses: TaskStatus[]): RollupCounts {
  const counts: RollupCounts = { total: statuses.length, open: 0, inProgress: 0, inReview: 0, done: 0 };
  for (const status of statuses) {
    counts[MONDAY_ROLLUP_BUCKETS[status]] += 1;
  }
  return counts;
}

export function formatRollupText(counts: RollupCounts): string {
  if (counts.total === 0) return 'no linked tasks';
  const parts = [`${counts.done}/${counts.total} done`];
  if (counts.inReview > 0) parts.push(`${counts.inReview} in review`);
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  return parts.join(' · ');
}

export function formatRollupPercent(counts: RollupCounts): number {
  if (counts.total === 0) return 0;
  return Math.round((counts.done / counts.total) * 100);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="rollup"`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/monday/rollup.ts src/backend/test/monday-rollup.test.ts
git commit -m "feat(monday): pure roll-up computation from linked task statuses"
```

---

## Task 4: Mirror and link store

**Files:**
- Create: `src/backend/monday/store.ts`
- Test: `src/backend/test/monday-store.test.ts`

**Interfaces:**
- Consumes: tables from Task 1, `MondayItem` / `TaskMondayLink` types.
- Produces:
  - `upsertItems(db, items: MondayItem[]): void`
  - `pruneScope(db, boardId: string, groupId: string | null, keepItemIds: string[], syncedAt: string): number` — returns rows marked missing or deleted
  - `getItem(db, itemId: string): MondayItem | undefined`
  - `listItemsForBoard(db, boardId: string, groupId: string | null): MondayItem[]`
  - `linkTask(db, link: TaskMondayLink): void`
  - `unlinkTask(db, taskId: string): void`
  - `getLinkForTask(db, taskId: string): TaskMondayLink | undefined`
  - `listLinksForProject(db, projectId: string): TaskMondayLink[]`
  - `listLinkedItemIds(db): string[]`
  - `listLinkedTaskStatuses(db, itemId: string): TaskStatus[]`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-store.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayItem } from '@nexus/shared';
import { getDb } from '../db';
import {
  upsertItems, pruneScope, getItem, listItemsForBoard,
  linkTask, unlinkTask, getLinkForTask, listLinkedItemIds, listLinkedTaskStatuses,
} from '../monday/store';

function item(id: string, over: Partial<MondayItem> = {}): MondayItem {
  return {
    item_id: id, board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
    name: `Item ${id}`, state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null,
    synced_at: '2026-07-22T00:00:00.000Z', ...over,
  };
}

test('upsertItems inserts then updates in place', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1')]);
  upsertItems(db, [item('1', { name: 'Renamed', status_label: 'Done' })]);
  const row = getItem(db, '1')!;
  assert.equal(row.name, 'Renamed');
  assert.equal(row.status_label, 'Done');
  assert.equal(listItemsForBoard(db, 'b1', null).length, 1);
  db.close();
});

test('pruneScope deletes unlinked rows that vanished from the board', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1'), item('2')]);
  const affected = pruneScope(db, 'b1', null, ['1'], '2026-07-22T01:00:00.000Z');
  assert.equal(affected, 1);
  assert.equal(getItem(db, '2'), undefined);
  assert.ok(getItem(db, '1'));
  db.close();
});

test('pruneScope NEVER deletes a linked row — it marks it missing', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1'), item('2')]);
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: 'now' });
  pruneScope(db, 'b1', null, ['1'], '2026-07-22T01:00:00.000Z');
  const row = getItem(db, '2');
  assert.ok(row, 'linked row must survive the prune');
  assert.equal(row!.state, 'missing');
  db.close();
});

test('pruneScope is confined to the board and group it synced', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1', { board_id: 'b1' }), item('9', { board_id: 'b2' })]);
  pruneScope(db, 'b1', null, [], '2026-07-22T01:00:00.000Z');
  assert.ok(getItem(db, '9'), 'other boards must be untouched');
  db.close();
});

test('pruneScope with a group set only touches that group', () => {
  const db = getDb(':memory:');
  upsertItems(db, [item('1', { group_id: 'g1' }), item('2', { group_id: 'g2' })]);
  pruneScope(db, 'b1', 'g1', [], '2026-07-22T01:00:00.000Z');
  assert.equal(getItem(db, '1'), undefined);
  assert.ok(getItem(db, '2'), 'other groups must be untouched');
  db.close();
});

test('linking replaces any prior link for the task', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: 'later' });
  assert.equal(getLinkForTask(db, 't1')!.item_id, '2');
  db.close();
});

test('unlinkTask removes the link', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  unlinkTask(db, 't1');
  assert.equal(getLinkForTask(db, 't1'), undefined);
  db.close();
});

test('listLinkedItemIds is distinct across projects', () => {
  const db = getDb(':memory:');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p2', created_at: 'now' });
  linkTask(db, { task_id: 't3', item_id: '2', project_id: 'p1', created_at: 'now' });
  assert.deepEqual(listLinkedItemIds(db).sort(), ['1', '2']);
  db.close();
});

test('listLinkedTaskStatuses joins through to the tasks table', () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','', '', '{}', 0, '', 'now', 'now')`).run();
  const insertTask = db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
                                 VALUES (?, 'p1', ?, '', ?, 'medium', 'now', 'now')`);
  insertTask.run('t1', 'A', 'deploy');
  insertTask.run('t2', 'B', 'review');
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p1', created_at: 'now' });
  assert.deepEqual(listLinkedTaskStatuses(db, '1').sort(), ['deploy', 'review']);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/store'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/store.ts`:

```ts
/**
 * DB access for the Monday mirror and the task→item links.
 *
 * The two tables have deliberately different contracts. `monday_items` is
 * disposable and rebuildable from the API. `task_monday_links` is user intent
 * and must survive a mirror wipe or a board reorganisation — which is why
 * pruning marks a linked row 'missing' instead of deleting it.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, TaskMondayLink, TaskStatus } from '@nexus/shared';

const ITEM_COLUMNS = `item_id, board_id, board_name, group_id, group_title, name, state,
  status_label, status_color, owners_json, url, column_values_json, monday_updated_at, synced_at`;

export function upsertItems(db: Database.Database, items: MondayItem[]): void {
  const stmt = db.prepare(`
    INSERT INTO monday_items (${ITEM_COLUMNS})
    VALUES (@item_id, @board_id, @board_name, @group_id, @group_title, @name, @state,
            @status_label, @status_color, @owners_json, @url, @column_values_json,
            @monday_updated_at, @synced_at)
    ON CONFLICT(item_id) DO UPDATE SET
      board_id = excluded.board_id,
      board_name = excluded.board_name,
      group_id = excluded.group_id,
      group_title = excluded.group_title,
      name = excluded.name,
      state = excluded.state,
      status_label = excluded.status_label,
      status_color = excluded.status_color,
      owners_json = excluded.owners_json,
      url = excluded.url,
      column_values_json = excluded.column_values_json,
      monday_updated_at = excluded.monday_updated_at,
      synced_at = excluded.synced_at
  `);
  const run = db.transaction((rows: MondayItem[]) => {
    for (const row of rows) stmt.run(row);
  });
  run(items);
}

/**
 * Reconcile the mirror against what the board just returned. Confined to the
 * synced board (and group, when scoped) so other scopes are untouched.
 *
 * Linked rows are never deleted: they are marked 'missing' so a link to an
 * item someone archived in Monday degrades visibly instead of vanishing.
 * Returns the number of rows affected.
 */
export function pruneScope(
  db: Database.Database,
  boardId: string,
  groupId: string | null,
  keepItemIds: string[],
  syncedAt: string,
): number {
  const keep = new Set(keepItemIds);
  const scopeSql = groupId
    ? 'SELECT item_id FROM monday_items WHERE board_id = ? AND group_id = ?'
    : 'SELECT item_id FROM monday_items WHERE board_id = ?';
  const params = groupId ? [boardId, groupId] : [boardId];
  const present = (db.prepare(scopeSql).all(...params) as { item_id: string }[]).map((r) => r.item_id);
  const stale = present.filter((id) => !keep.has(id));
  if (stale.length === 0) return 0;

  const linked = new Set(
    (db.prepare(
      `SELECT DISTINCT item_id FROM task_monday_links WHERE item_id IN (${stale.map(() => '?').join(',')})`,
    ).all(...stale) as { item_id: string }[]).map((r) => r.item_id),
  );

  const markMissing = db.prepare(
    "UPDATE monday_items SET state = 'missing', synced_at = ? WHERE item_id = ?",
  );
  const remove = db.prepare('DELETE FROM monday_items WHERE item_id = ?');

  const run = db.transaction(() => {
    for (const id of stale) {
      if (linked.has(id)) markMissing.run(syncedAt, id);
      else remove.run(id);
    }
  });
  run();
  return stale.length;
}

export function getItem(db: Database.Database, itemId: string): MondayItem | undefined {
  return db.prepare(`SELECT ${ITEM_COLUMNS} FROM monday_items WHERE item_id = ?`).get(itemId) as MondayItem | undefined;
}

export function listItemsForBoard(
  db: Database.Database,
  boardId: string,
  groupId: string | null,
): MondayItem[] {
  const sql = groupId
    ? `SELECT ${ITEM_COLUMNS} FROM monday_items WHERE board_id = ? AND group_id = ? ORDER BY name`
    : `SELECT ${ITEM_COLUMNS} FROM monday_items WHERE board_id = ? ORDER BY group_title, name`;
  const params = groupId ? [boardId, groupId] : [boardId];
  return db.prepare(sql).all(...params) as MondayItem[];
}

/** Upsert on task_id: linking a task that already has a link replaces it. */
export function linkTask(db: Database.Database, link: TaskMondayLink): void {
  db.prepare(`
    INSERT INTO task_monday_links (task_id, item_id, project_id, created_at)
    VALUES (@task_id, @item_id, @project_id, @created_at)
    ON CONFLICT(task_id) DO UPDATE SET
      item_id = excluded.item_id,
      project_id = excluded.project_id,
      created_at = excluded.created_at
  `).run(link);
}

export function unlinkTask(db: Database.Database, taskId: string): void {
  db.prepare('DELETE FROM task_monday_links WHERE task_id = ?').run(taskId);
}

export function getLinkForTask(db: Database.Database, taskId: string): TaskMondayLink | undefined {
  return db.prepare('SELECT task_id, item_id, project_id, created_at FROM task_monday_links WHERE task_id = ?')
    .get(taskId) as TaskMondayLink | undefined;
}

export function listLinksForProject(db: Database.Database, projectId: string): TaskMondayLink[] {
  return db.prepare('SELECT task_id, item_id, project_id, created_at FROM task_monday_links WHERE project_id = ?')
    .all(projectId) as TaskMondayLink[];
}

/** Every item id with at least one link, across all projects. Drives the poll. */
export function listLinkedItemIds(db: Database.Database): string[] {
  return (db.prepare('SELECT DISTINCT item_id FROM task_monday_links').all() as { item_id: string }[])
    .map((r) => r.item_id);
}

/** Statuses of every task linked to an item — the roll-up's input. */
export function listLinkedTaskStatuses(db: Database.Database, itemId: string): TaskStatus[] {
  return (db.prepare(`
    SELECT t.status AS status
    FROM task_monday_links l
    JOIN tasks t ON t.id = l.task_id
    WHERE l.item_id = ?
  `).all(itemId) as { status: TaskStatus }[]).map((r) => r.status);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/monday/store.ts src/backend/test/monday-store.test.ts
git commit -m "feat(monday): mirror and link store with linked-row-safe pruning"
```

---

## Task 5: Scope sync and linked-item refresh

**Files:**
- Create: `src/backend/monday/sync.ts`
- Test: `src/backend/test/monday-sync.test.ts`

**Interfaces:**
- Consumes: `fetchBoardItems`, `fetchItemsByIds`, `RawMondayItem`, `MondayError` (Task 2); `mapItem` (Task 2); store functions (Task 4).
- Produces:
  - `interface MondaySyncResult { fetched: number; pruned: number }`
  - `syncScope(db, opts: MondayClientOptions, boardId, groupId, now: string, fetchImpl?): Promise<MondaySyncResult>`
  - `refreshLinkedItems(db, opts: MondayClientOptions, now: string, fetchImpl?): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-sync.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { syncScope, refreshLinkedItems } from '../monday/sync';
import { getItem, linkTask, upsertItems } from '../monday/store';
import { MondayError } from '../monday/client';
import type { MondayItem } from '@nexus/shared';

const OPTS = { token: 'tok', apiVersion: '2024-10' };
const NOW = '2026-07-22T10:00:00.000Z';

function raw(id: string, name = `Item ${id}`) {
  return {
    id, name, state: 'active', updated_at: null, url: null,
    board: { id: 'b1', name: 'Portfolio' }, group: { id: 'g1', title: 'Q3' },
    column_values: [],
  };
}

test('syncScope mirrors fetched items', async () => {
  const db = getDb(':memory:');
  const result = await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  assert.deepEqual(result, { fetched: 2, pruned: 0 });
  assert.equal(getItem(db, '1')!.name, 'Item 1');
  db.close();
});

test('syncScope prunes rows the board no longer returns', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  const result = await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  assert.equal(result.pruned, 1);
  assert.equal(getItem(db, '2'), undefined);
  db.close();
});

test('syncScope never drops a linked item', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1'), raw('2')] as any);
  linkTask(db, { task_id: 't1', item_id: '2', project_id: 'p1', created_at: NOW });
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  assert.equal(getItem(db, '2')!.state, 'missing');
  db.close();
});

test('syncScope propagates client errors rather than silently mirroring nothing', async () => {
  const db = getDb(':memory:');
  await assert.rejects(
    () => syncScope(db, OPTS, 'b1', null, NOW, async () => {
      throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
    }),
    /Not Authenticated/,
  );
  db.close();
});

test('an auth failure must not be mistaken for an empty board', async () => {
  const db = getDb(':memory:');
  await syncScope(db, OPTS, 'b1', null, NOW, async () => [raw('1')] as any);
  await assert.rejects(() => syncScope(db, OPTS, 'b1', null, NOW, async () => {
    throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
  }));
  assert.ok(getItem(db, '1'), 'a failed sync must not prune the existing mirror');
  db.close();
});

test('refreshLinkedItems queries only linked ids', async () => {
  const db = getDb(':memory:');
  const stale: MondayItem = {
    item_id: '5', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Old', state: 'active', status_label: null, status_color: null, owners_json: '[]',
    url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'old',
  };
  upsertItems(db, [stale]);
  linkTask(db, { task_id: 't1', item_id: '5', project_id: 'p1', created_at: NOW });

  let askedFor: string[] = [];
  const count = await refreshLinkedItems(db, OPTS, NOW, async (_o, ids) => {
    askedFor = ids;
    return [{ ...raw('5', 'Fresh'), board: { id: 'b1', name: 'Portfolio' } }] as any;
  });
  assert.deepEqual(askedFor, ['5']);
  assert.equal(count, 1);
  assert.equal(getItem(db, '5')!.name, 'Fresh');
  db.close();
});

test('refreshLinkedItems marks a linked item Monday no longer returns as missing', async () => {
  const db = getDb(':memory:');
  upsertItems(db, [{
    item_id: '7', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Gone', state: 'active', status_label: null, status_color: null, owners_json: '[]',
    url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'old',
  }]);
  linkTask(db, { task_id: 't1', item_id: '7', project_id: 'p1', created_at: NOW });
  await refreshLinkedItems(db, OPTS, NOW, async () => []);
  assert.equal(getItem(db, '7')!.state, 'missing');
  db.close();
});

test('refreshLinkedItems is a no-op when nothing is linked', async () => {
  const db = getDb(':memory:');
  let called = false;
  const count = await refreshLinkedItems(db, OPTS, NOW, async () => { called = true; return []; });
  assert.equal(count, 0);
  assert.equal(called, false);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/sync'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/sync.ts`:

```ts
/**
 * Two read paths, matched to two freshness needs.
 *
 * syncScope is lazy — driven by opening the Project Management view. It walks
 * the whole scoped board and reconciles the mirror against it.
 *
 * refreshLinkedItems is the background path. It asks for exactly the linked
 * item ids, so its cost is flat in board size no matter how large the board
 * grows. This is what roll-up writes read against.
 *
 * Neither swallows a client error: a failed fetch must never be reconciled as
 * "the board is empty", or an auth failure would prune the entire mirror.
 */
import type Database from 'better-sqlite3';
import {
  fetchBoardItems, fetchItemsByIds,
  type MondayClientOptions, type RawMondayItem,
} from './client.js';
import { mapItem } from './map.js';
import { upsertItems, pruneScope, listLinkedItemIds, getItem } from './store.js';

export interface MondaySyncResult {
  fetched: number;
  pruned: number;
}

type FetchBoard = (opts: MondayClientOptions, boardId: string, groupId: string | null) => Promise<RawMondayItem[]>;
type FetchByIds = (opts: MondayClientOptions, ids: string[]) => Promise<RawMondayItem[]>;

/**
 * Full sync of one project's scope. Throws on client failure — the caller
 * (route or poll) decides how to surface it. Nothing is pruned unless the
 * fetch succeeded.
 */
export async function syncScope(
  db: Database.Database,
  opts: MondayClientOptions,
  boardId: string,
  groupId: string | null,
  now: string,
  fetchImpl: FetchBoard = fetchBoardItems,
): Promise<MondaySyncResult> {
  const rawItems = await fetchImpl(opts, boardId, groupId);
  const rows = rawItems.map((raw) => mapItem(raw, now));
  upsertItems(db, rows);
  const pruned = pruneScope(db, boardId, groupId, rows.map((r) => r.item_id), now);
  return { fetched: rows.length, pruned };
}

/**
 * Refresh every linked item across all projects in one query. Returns the
 * number of items refreshed. A linked item Monday no longer returns is marked
 * 'missing' rather than dropped — the link survives.
 */
export async function refreshLinkedItems(
  db: Database.Database,
  opts: MondayClientOptions,
  now: string,
  fetchImpl: FetchByIds = fetchItemsByIds,
): Promise<number> {
  const ids = listLinkedItemIds(db);
  if (ids.length === 0) return 0;

  const rawItems = await fetchImpl(opts, ids);
  const rows = rawItems.map((raw) => mapItem(raw, now));
  upsertItems(db, rows);

  const returned = new Set(rows.map((r) => r.item_id));
  const missing = ids.filter((id) => !returned.has(id));
  const markMissing = db.prepare("UPDATE monday_items SET state = 'missing', synced_at = ? WHERE item_id = ?");
  for (const id of missing) {
    if (getItem(db, id)) markMissing.run(now, id);
  }
  return rows.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 8 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/monday/sync.ts src/backend/test/monday-sync.test.ts
git commit -m "feat(monday): scope sync and flat-cost linked-item refresh"
```

---

## Task 6: Throttled write path

**Files:**
- Create: `src/backend/monday/writes.ts`
- Test: `src/backend/test/monday-writes.test.ts`

**Interfaces:**
- Consumes: `setSimpleColumnValue`, `createUpdate` (Task 2); `computeRollup`, `formatRollupText`, `formatRollupPercent` (Task 3); `listLinkedTaskStatuses`, `getItem` (Task 4).
- Produces:
  - `class UpdateThrottle { constructor(windowMs: number); record(itemId: string, event: string, now: number): string[] | null; due(now: number): string[]; drain(itemId: string, now: number): string[] }`
  - `interface RollupWriteDeps { setColumn: typeof setSimpleColumnValue; postUpdate: typeof createUpdate }`
  - `writeRollup(db, opts, cfg: MondayProjectConfig, itemId: string, deps?): Promise<'written' | 'unchanged' | 'skipped'>`
  - `postItemUpdate(db, opts, itemId, body: string, provenance: string | null, deps?): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-writes.test.ts`:

```ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig } from '@nexus/shared';
import { getDb } from '../db';
import { UpdateThrottle, writeRollup, postItemUpdate, __resetWriteState } from '../monday/writes';
import { upsertItems, linkTask } from '../monday/store';

const OPTS = { token: 'tok', apiVersion: '2024-10' };
const MINUTE = 60_000;

// lastWritten is module-level, so without this a value written by one test
// suppresses a write in the next.
beforeEach(() => __resetWriteState());

function cfg(over: Partial<MondayProjectConfig> = {}): MondayProjectConfig {
  return {
    board_id: 'b1',
    group_id: null,
    rollup: { enabled: true, column_id: 'text_mkxyz', column_type: 'text' },
    updates: { enabled: true, min_interval_minutes: 30 },
    ...over,
  };
}

function seedItem(db: ReturnType<typeof getDb>, itemId = '1') {
  upsertItems(db, [{
    item_id: itemId, board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

function seedTasks(db: ReturnType<typeof getDb>, statuses: string[], itemId = '1') {
  db.prepare(`INSERT OR IGNORE INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', '{}', 0, '', 'now','now')`).run();
  const insert = db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
                             VALUES (?, 'p1', ?, '', ?, 'medium', 'now', 'now')`);
  statuses.forEach((status, i) => {
    insert.run(`t${i}`, `Task ${i}`, status);
    linkTask(db, { task_id: `t${i}`, item_id: itemId, project_id: 'p1', created_at: 'now' });
  });
}

test('an isolated event posts immediately', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  assert.deepEqual(throttle.record('1', 'task moved to Review', 0), ['task moved to Review']);
});

test('events inside the window are coalesced, not dropped', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  assert.equal(throttle.record('1', 'second', 1 * MINUTE), null);
  assert.equal(throttle.record('1', 'third', 2 * MINUTE), null);
  assert.deepEqual(throttle.due(31 * MINUTE), ['1']);
  assert.deepEqual(throttle.drain('1', 31 * MINUTE), ['second', 'third']);
});

test('nothing is due before the window elapses', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  throttle.record('1', 'second', 5 * MINUTE);
  assert.deepEqual(throttle.due(20 * MINUTE), []);
});

test('draining resets the window so the next isolated event posts immediately', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'first', 0);
  throttle.record('1', 'second', 1 * MINUTE);
  throttle.drain('1', 31 * MINUTE);
  assert.deepEqual(throttle.record('1', 'later', 90 * MINUTE), ['later']);
});

test('throttling is per item', () => {
  const throttle = new UpdateThrottle(30 * MINUTE);
  throttle.record('1', 'a', 0);
  assert.deepEqual(throttle.record('2', 'b', 1 * MINUTE), ['b']);
});

test('writeRollup writes the formatted text to the configured column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'review', 'todo']);
  const calls: unknown[][] = [];
  const result = await writeRollup(db, OPTS, cfg(), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(result, 'written');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3], 'text_mkxyz');
  assert.equal(calls[0][4], '1/3 done · 1 in review');
  db.close();
});

test('a numeric column receives the percentage, not the text form', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy', 'deploy', 'todo']);
  const calls: unknown[][] = [];
  await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: 'numbers_9', column_type: 'numeric' } }), '1', {
    setColumn: async (...args: unknown[]) => { calls.push(args); },
    postUpdate: async () => {},
  } as any);
  assert.equal(calls[0][4], '67');
  db.close();
});

test('writeRollup skips an unchanged value', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy']);
  const deps = { setColumn: async () => {}, postUpdate: async () => {} } as any;
  await writeRollup(db, OPTS, cfg(), '1', deps);
  const second = await writeRollup(db, OPTS, cfg(), '1', deps);
  assert.equal(second, 'unchanged');
  db.close();
});

test('writeRollup is skipped when roll-up is disabled or has no column', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  seedTasks(db, ['deploy']);
  const deps = { setColumn: async () => { throw new Error('must not write'); }, postUpdate: async () => {} } as any;
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: false, column_id: 'c', column_type: 'text' } }), '1', deps), 'skipped');
  assert.equal(await writeRollup(db, OPTS, cfg({ rollup: { enabled: true, column_id: null, column_type: 'text' } }), '1', deps), 'skipped');
  db.close();
});

test('postItemUpdate appends a provenance line for agent-authored updates', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Finished the migration.', 'Nexus task "Migrate DB" (thread abc123)', {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.match(body, /Finished the migration\./);
  assert.match(body, /Nexus task "Migrate DB" \(thread abc123\)/);
  db.close();
});

test('postItemUpdate omits the provenance line when there is no author', async () => {
  const db = getDb(':memory:');
  seedItem(db);
  let body = '';
  await postItemUpdate(db, OPTS, '1', 'Automated roll-up note.', null, {
    setColumn: async () => {},
    postUpdate: async (_o: unknown, _id: string, b: string) => { body = b; },
  } as any);
  assert.equal(body, 'Automated roll-up note.');
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/writes'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/writes.ts`:

```ts
/**
 * The only place Nexus writes to Monday.
 *
 * The write invariant: only the project's configured roll-up column and the
 * item's updates feed. Never the status column, never anything else a human
 * owns. Nexus and a human editing the item therefore write disjoint fields,
 * so there is no read-modify-write conflict to lose and no way for an agent
 * to silently declare an initiative done.
 *
 * Throttling is leading-edge with a trailing flush: an isolated event posts
 * at once, and everything that arrives inside the window merges into a single
 * later post. Nothing is dropped, and a quiet project never waits 30 minutes
 * to say something.
 */
import type Database from 'better-sqlite3';
import type { MondayProjectConfig } from '@nexus/shared';
import { setSimpleColumnValue, createUpdate, type MondayClientOptions } from './client.js';
import { computeRollup, formatRollupText, formatRollupPercent } from './rollup.js';
import { listLinkedTaskStatuses, getItem } from './store.js';

/** Per-item throttle with coalescing. Pure: the clock is passed in. */
export class UpdateThrottle {
  private readonly lastPostAt = new Map<string, number>();
  private readonly pending = new Map<string, string[]>();

  constructor(private readonly windowMs: number) {}

  /**
   * Record an event. Returns the events to post NOW (leading edge), or null
   * when the event was queued for the trailing flush.
   */
  record(itemId: string, event: string, now: number): string[] | null {
    const last = this.lastPostAt.get(itemId);
    if (last === undefined || now - last >= this.windowMs) {
      this.lastPostAt.set(itemId, now);
      return [event];
    }
    const queue = this.pending.get(itemId) ?? [];
    queue.push(event);
    this.pending.set(itemId, queue);
    return null;
  }

  /** Item ids whose queued events are ready to flush. */
  due(now: number): string[] {
    const out: string[] = [];
    for (const [itemId, queue] of this.pending) {
      if (queue.length === 0) continue;
      const last = this.lastPostAt.get(itemId) ?? 0;
      if (now - last >= this.windowMs) out.push(itemId);
    }
    return out;
  }

  /** Take an item's queued events and restart its window. */
  drain(itemId: string, now: number): string[] {
    const queue = this.pending.get(itemId) ?? [];
    this.pending.delete(itemId);
    if (queue.length > 0) this.lastPostAt.set(itemId, now);
    return queue;
  }
}

export interface RollupWriteDeps {
  setColumn: typeof setSimpleColumnValue;
  postUpdate: typeof createUpdate;
}

const DEFAULT_DEPS: RollupWriteDeps = { setColumn: setSimpleColumnValue, postUpdate: createUpdate };

/** Last value written per item, so an unchanged roll-up never re-writes. */
const lastWritten = new Map<string, string>();

/** Test helper: clear the in-memory last-written cache between cases. */
export function __resetWriteState(): void {
  lastWritten.clear();
}

/**
 * Compute and write the roll-up for one item. Returns 'skipped' when the
 * project has roll-up off or no column configured, 'unchanged' when the value
 * matches what was last written, 'written' otherwise.
 *
 * A numeric roll-up column receives the percentage; anything else receives the
 * text form. The column type was resolved when the column was configured.
 */
export async function writeRollup(
  db: Database.Database,
  opts: MondayClientOptions,
  cfg: MondayProjectConfig,
  itemId: string,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<'written' | 'unchanged' | 'skipped'> {
  if (!cfg.rollup.enabled || !cfg.rollup.column_id) return 'skipped';

  const item = getItem(db, itemId);
  if (!item) return 'skipped';

  const counts = computeRollup(listLinkedTaskStatuses(db, itemId));
  const value = cfg.rollup.column_type === 'numeric'
    ? String(formatRollupPercent(counts))
    : formatRollupText(counts);

  const cacheKey = `${itemId}::${cfg.rollup.column_id}`;
  if (lastWritten.get(cacheKey) === value) return 'unchanged';

  await deps.setColumn(opts, item.board_id, itemId, cfg.rollup.column_id, value);
  lastWritten.set(cacheKey, value);
  return 'written';
}

/**
 * Post to an item's updates feed. `provenance` names the Nexus task and thread
 * for agent-authored updates so a human reading Monday never has to guess who
 * wrote it; pass null for Nexus's own automated notes.
 */
export async function postItemUpdate(
  db: Database.Database,
  opts: MondayClientOptions,
  itemId: string,
  body: string,
  provenance: string | null,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<void> {
  const full = provenance ? `${body}\n\n— posted by Nexus on behalf of ${provenance}` : body;
  await deps.postUpdate(opts, itemId, full);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 10 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/monday/writes.ts src/backend/test/monday-writes.test.ts
git commit -m "feat(monday): throttled roll-up and updates write path"
```

---

## Task 7: Poll loop and Activity integration

**Files:**
- Create: `src/backend/monday/poll.ts`
- Modify: `src/backend/index.ts`
- Test: `src/backend/test/monday-poll.test.ts`

**Interfaces:**
- Consumes: `refreshLinkedItems` (Task 5), `ActivityEvent` (Task 1), `insertNotification`.
- Produces:
  - `resolveMondayToken(): string | undefined`
  - `runMondayRefreshOnce(db, cfg: NexusConfig['monday'], token: string | undefined, refresh?, emit?): Promise<number | null>`
  - `startMondayPoll(db, emit?): () => void` (returns a stop function)

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-poll.test.ts`:

```ts
// A live MONDAY_TOKEN in the dev shell would make the "unconfigured" cases
// pass for the wrong reason — exactly what happened with JIRA_TOKEN.
delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { runMondayRefreshOnce, resolveMondayToken } from '../monday/poll';
import { MondayError } from '../monday/client';
import type { ActivityEvent } from '../activity/events';

const CFG = { enabled: true, api_version: '2024-10', poll_minutes: 10 };

test('resolveMondayToken reads MONDAY_TOKEN only', () => {
  assert.equal(resolveMondayToken(), undefined);
  process.env.MONDAY_TOKEN = 'from-env';
  assert.equal(resolveMondayToken(), 'from-env');
  delete process.env.MONDAY_TOKEN;
});

test('the refresh is dormant when disabled', async () => {
  const db = getDb(':memory:');
  let called = false;
  const result = await runMondayRefreshOnce(db, { ...CFG, enabled: false }, 'tok', async () => { called = true; return 1; });
  assert.equal(result, null);
  assert.equal(called, false);
  db.close();
});

test('the refresh is dormant with no token', async () => {
  const db = getDb(':memory:');
  let called = false;
  const result = await runMondayRefreshOnce(db, CFG, undefined, async () => { called = true; return 1; });
  assert.equal(result, null);
  assert.equal(called, false);
  db.close();
});

test('a successful refresh emits start and succeeded', async () => {
  const db = getDb(':memory:');
  const events: ActivityEvent[] = [];
  const result = await runMondayRefreshOnce(db, CFG, 'tok', async () => 3, (e) => events.push(e));
  assert.equal(result, 3);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].kind, 'monday_sync');
  assert.equal(events.at(-1)!.status, 'succeeded');
  db.close();
});

test('a failed refresh emits failed, records a notification, and never throws', async () => {
  const db = getDb(':memory:');
  const events: ActivityEvent[] = [];
  const result = await runMondayRefreshOnce(db, CFG, 'tok', async () => {
    throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200);
  }, (e) => events.push(e));
  assert.equal(result, null);
  assert.equal(events.at(-1)!.status, 'failed');
  assert.match(events.at(-1)!.error ?? '', /Not Authenticated/);
  const notes = db.prepare('SELECT title, message FROM notifications').all() as { title: string; message: string }[];
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /Not Authenticated/);
  db.close();
});

test('an identical repeat failure does not notify twice', async () => {
  const db = getDb(':memory:');
  const fail = async () => { throw new MondayError('Not Authenticated', 'UserUnauthorizedException', 200); };
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  await runMondayRefreshOnce(db, CFG, 'tok', fail);
  const count = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c;
  assert.equal(count, 1);
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/poll'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/poll.ts`:

```ts
/**
 * Background refresh of linked Monday items. Ticks only while the backend
 * process runs (a setInterval, not a system cron), matching "sync while I'm in
 * front of Nexus" — the same contract as the Jira poll.
 *
 * Only linked items are refreshed, so cost is flat in board size. Full scope
 * syncs are lazy and driven by the Project Management view instead.
 */
import type Database from 'better-sqlite3';
import type { NexusConfig } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { refreshLinkedItems } from './sync.js';
import type { MondayClientOptions } from './client.js';
import { insertNotification } from '../notifications/index.js';
import type { ActivityEvent } from '../activity/events.js';

type MondayConfig = NexusConfig['monday'];
type Refresh = (db: Database.Database, opts: MondayClientOptions, now: string) => Promise<number>;

/** The token comes from the environment only — never config, never the DB. */
export function resolveMondayToken(): string | undefined {
  const token = process.env.MONDAY_TOKEN?.trim();
  return token ? token : undefined;
}

// Last error message notified about, per-process. Suppresses a flood of
// identical "Monday sync failed" toasts when the same 401 recurs every tick.
let lastErrorMessage: string | null = null;

/** Test-only: clear the deduped-error state. */
export function __resetPollErrorState(): void {
  lastErrorMessage = null;
}

/**
 * Run one linked-item refresh. Returns the count refreshed, or null when
 * dormant (disabled / no token) or when the refresh failed. Never throws.
 */
export async function runMondayRefreshOnce(
  db: Database.Database,
  cfg: MondayConfig,
  token: string | undefined,
  refresh: Refresh = (database, opts, now) => refreshLinkedItems(database, opts, now),
  emit?: (event: ActivityEvent) => void,
): Promise<number | null> {
  if (!cfg.enabled || !token) return null;

  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  emit?.({ type: 'start', operationId, kind: 'monday_sync', title: 'Monday refresh' });

  try {
    const count = await refresh(db, { token, apiVersion: cfg.api_version }, new Date().toISOString());
    lastErrorMessage = null;
    emit?.({
      type: 'stop', operationId, kind: 'monday_sync', title: 'Monday refresh',
      status: 'succeeded', durationMs: Date.now() - startedAt,
    });
    return count;
  } catch (err) {
    const message = (err as Error).message;
    emit?.({
      type: 'stop', operationId, kind: 'monday_sync', title: 'Monday refresh',
      status: 'failed', durationMs: Date.now() - startedAt, error: message,
    });
    if (lastErrorMessage !== message) {
      lastErrorMessage = message;
      insertNotification(db, {
        level: 'error',
        title: 'Monday refresh failed',
        message: `${message}. Check MONDAY_TOKEN and the configured board.`,
      });
    }
    return null;
  }
}

/** Start the interval loop. Returns a stop function. */
export function startMondayPoll(
  db: Database.Database,
  emit?: (event: ActivityEvent) => void,
): () => void {
  const cfg = loadConfig().monday;
  if (!cfg.enabled) return () => {};

  const tick = () => {
    void runMondayRefreshOnce(db, loadConfig().monday, resolveMondayToken(), undefined, emit);
  };
  const handle = setInterval(tick, Math.max(1, cfg.poll_minutes) * 60_000);
  tick();
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Wire the poll into the server**

In `src/backend/index.ts`, alongside where the Jira poll is started, add the import and the start call:

```ts
import { startMondayPoll } from './monday/poll.js';
```

```ts
  startMondayPoll(db, (event) => activity.handleEvent(event));
```

Match the exact emit callback shape used by the neighbouring `startJiraPoll(...)` call in that file — if the Jira poll is passed `activity.handleEvent` directly, do the same rather than wrapping it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 6 new tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/backend/monday/poll.ts src/backend/index.ts src/backend/test/monday-poll.test.ts
git commit -m "feat(monday): linked-item poll loop with deduped failure notifications"
```

---

## Task 8: HTTP routes

**Files:**
- Create: `src/backend/routes/monday.ts`
- Modify: `src/backend/index.ts`
- Test: `src/backend/test/monday-routes.test.ts`

**Interfaces:**
- Consumes: store (Task 4), sync (Task 5), writes (Task 6), poll's `resolveMondayToken` (Task 7).
- Produces these endpoints:
  - `GET /api/monday/projects/:projectId/items` → `{ items: MondayItemWithLinks[] }` (mirror read; `?refresh=1` syncs first)
  - `GET /api/monday/projects/:projectId/search?q=` → `{ items: MondayItem[] }` (live query, picker)
  - `GET /api/monday/projects/:projectId/links` → `{ links: TaskMondayLink[] }`
  - `POST /api/monday/links` body `{ task_id, item_id, project_id }` → `{ link: TaskMondayLink }`
  - `DELETE /api/monday/links/:taskId` → `{ ok: true }`
  - `GET /api/monday/status` → `{ enabled: boolean; configured: boolean }`
- Produces the shared type `MondayItemWithLinks = MondayItem & { rollup: RollupCounts; rollup_text: string; task_ids: string[] }` (add to `src/shared/index.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-routes.test.ts`:

```ts
delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { getDb } from '../db';
import { registerMondayRoutes } from '../routes/monday';
import { upsertItems, getLinkForTask } from '../monday/store';

function seed(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','A','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
}

async function buildApp(db: ReturnType<typeof getDb>) {
  const app = Fastify();
  await app.register(async (instance) => registerMondayRoutes(instance, { db } as never));
  return app;
}

test('GET items returns mirrored items with roll-up and linked task ids', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });

  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p1/items' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: { item_id: string; rollup_text: string; task_ids: string[] }[] };
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].rollup_text, '1/1 done');
  assert.deepEqual(body.items[0].task_ids, ['t1']);
  await app.close();
  db.close();
});

test('POST links creates a link and replaces an existing one', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1')!.item_id, '1');
  await app.close();
  db.close();
});

test('POST links rejects a missing field', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  db.close();
});

test('DELETE links removes the link', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  await app.inject({ method: 'POST', url: '/api/monday/links', payload: { task_id: 't1', item_id: '1', project_id: 'p1' } });
  const res = await app.inject({ method: 'DELETE', url: '/api/monday/links/t1' });
  assert.equal(res.statusCode, 200);
  assert.equal(getLinkForTask(db, 't1'), undefined);
  await app.close();
  db.close();
});

test('GET status reports unconfigured without a token', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/status' });
  assert.equal(res.json().configured, false);
  await app.close();
  db.close();
});

test('GET items 404s for an unknown project', async () => {
  const db = getDb(':memory:');
  seed(db);
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/nope/items' });
  assert.equal(res.statusCode, 404);
  await app.close();
  db.close();
});

test('GET items 409s when the project has no Monday scope configured', async () => {
  const db = getDb(':memory:');
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p2','p2','P2','P2','','', '{}', 0, '', 'now','now')`).run();
  const app = await buildApp(db);
  const res = await app.inject({ method: 'GET', url: '/api/monday/projects/p2/items' });
  assert.equal(res.statusCode, 409);
  await app.close();
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../routes/monday'`.

- [ ] **Step 3: Add the shared response type**

In `src/shared/index.ts`, after `MondayItem`:

```ts
/** A mirrored item enriched with its Nexus roll-up, as returned by the API. */
export interface MondayItemWithLinks extends MondayItem {
  rollup: { total: number; open: number; inProgress: number; inReview: number; done: number };
  rollup_text: string;
  task_ids: string[];
}
```

- [ ] **Step 4: Write the routes**

Create `src/backend/routes/monday.ts`:

```ts
/**
 * /api/monday/* — the Project Management view's read paths and the link CRUD.
 *
 * The picker (`/search`) deliberately queries Monday live rather than reading
 * the mirror, so an item created thirty seconds ago is findable. Everything
 * else reads the mirror.
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { MondayProjectConfig, MondayItemWithLinks, Project } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from '../monday/poll.js';
import { syncScope } from '../monday/sync.js';
import { fetchBoardItems, MondayError, type MondayClientOptions } from '../monday/client.js';
import { mapItem } from '../monday/map.js';
import {
  listItemsForBoard, listLinksForProject, linkTask, unlinkTask, listLinkedTaskStatuses,
} from '../monday/store.js';
import { computeRollup, formatRollupText } from '../monday/rollup.js';

interface Deps { db: Database.Database }

function projectMondayConfig(project: Project): MondayProjectConfig | null {
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

function clientOptions(): MondayClientOptions | null {
  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!cfg.enabled || !token) return null;
  return { token, apiVersion: cfg.api_version };
}

export function registerMondayRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/api/monday/status', async () => {
    const cfg = loadConfig().monday;
    return { enabled: cfg.enabled, configured: cfg.enabled && Boolean(resolveMondayToken()) };
  });

  app.get<{ Params: { projectId: string }; Querystring: { refresh?: string } }>(
    '/api/monday/projects/:projectId/items',
    async (request, reply) => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.projectId) as Project | undefined;
      if (!project) return reply.code(404).send({ error: 'project not found' });

      const cfg = projectMondayConfig(project);
      if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project' });

      if (request.query.refresh === '1') {
        const opts = clientOptions();
        if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set' });
        try {
          await syncScope(db, opts, cfg.board_id, cfg.group_id ?? null, new Date().toISOString());
        } catch (err) {
          const monday = err as MondayError;
          return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
        }
      }

      const links = listLinksForProject(db, project.id);
      const byItem = new Map<string, string[]>();
      for (const link of links) {
        byItem.set(link.item_id, [...(byItem.get(link.item_id) ?? []), link.task_id]);
      }

      const items: MondayItemWithLinks[] = listItemsForBoard(db, cfg.board_id, cfg.group_id ?? null)
        .map((item) => {
          const counts = computeRollup(listLinkedTaskStatuses(db, item.item_id));
          return { ...item, rollup: counts, rollup_text: formatRollupText(counts), task_ids: byItem.get(item.item_id) ?? [] };
        });
      return { items };
    },
  );

  app.get<{ Params: { projectId: string }; Querystring: { q?: string } }>(
    '/api/monday/projects/:projectId/search',
    async (request, reply) => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(request.params.projectId) as Project | undefined;
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const cfg = projectMondayConfig(project);
      if (!cfg) return reply.code(409).send({ error: 'no Monday scope configured for this project' });
      const opts = clientOptions();
      if (!opts) return reply.code(409).send({ error: 'Monday is disabled or MONDAY_TOKEN is not set' });

      const query = (request.query.q ?? '').trim().toLowerCase();
      try {
        const now = new Date().toISOString();
        const raw = await fetchBoardItems(opts, cfg.board_id, cfg.group_id ?? null);
        const items = raw
          .map((r) => mapItem(r, now))
          .filter((item) => !query || item.name.toLowerCase().includes(query))
          .slice(0, 50);
        return { items };
      } catch (err) {
        const monday = err as MondayError;
        return reply.code(502).send({ error: monday.message, code: monday.code, retryable: monday.retryable ?? false });
      }
    },
  );

  app.get<{ Params: { projectId: string } }>('/api/monday/projects/:projectId/links', async (request) => {
    return { links: listLinksForProject(db, request.params.projectId) };
  });

  app.post<{ Body: { task_id?: string; item_id?: string; project_id?: string } }>(
    '/api/monday/links',
    async (request, reply) => {
      const { task_id: taskId, item_id: itemId, project_id: projectId } = request.body ?? {};
      if (!taskId || !itemId || !projectId) {
        return reply.code(400).send({ error: 'task_id, item_id and project_id are required' });
      }
      const link = { task_id: taskId, item_id: itemId, project_id: projectId, created_at: new Date().toISOString() };
      linkTask(db, link);
      return { link };
    },
  );

  app.delete<{ Params: { taskId: string } }>('/api/monday/links/:taskId', async (request) => {
    unlinkTask(db, request.params.taskId);
    return { ok: true };
  });
}
```

- [ ] **Step 5: Register the routes**

In `src/backend/index.ts`, add the import and registration next to the other route registrations. Match how neighbouring routes receive their dependencies — if they close over `db` from the enclosing scope rather than taking a `deps` argument, adapt `registerMondayRoutes` to the same signature and update the test's `buildApp` helper accordingly.

```ts
import { registerMondayRoutes } from './routes/monday.js';
```

```ts
  app.register(registerMondayRoutes);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 7 new tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/monday.ts src/backend/index.ts src/shared/index.ts src/backend/test/monday-routes.test.ts
git commit -m "feat(monday): /api/monday routes for items, live search, and links"
```

---

## Task 9: Agent tools

**Files:**
- Create: `src/backend/pi/monday-tool.ts`
- Test: `src/backend/test/monday-tool.test.ts`

**Interfaces:**
- Consumes: store (Task 4), client (Task 2), writes (Task 6).
- Produces:
  - `interface MondayToolDeps { search(query: string, boardId?: string): Promise<MondayItem[]>; getItem(itemId: string): Promise<MondayItemDetail | null>; postUpdate?(itemId: string, body: string): Promise<void> }`
  - `interface MondayItemDetail { item: MondayItem; updates: string[]; linked_tasks: { id: string; title: string; status: TaskStatus }[] }`
  - `createMondayExtension(deps: MondayToolDeps): ExtensionFactory`
  - `mondayToolNames(deps: MondayToolDeps): string[]` (test seam listing which tools would register)

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-tool.test.ts`:

```ts
delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMondayExtension, mondayToolNames } from '../pi/monday-tool';
import type { MondayItem } from '@nexus/shared';

const ITEM: MondayItem = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/1', column_values_json: '{}',
  monday_updated_at: null, synced_at: 'now',
};

const READ_DEPS = {
  search: async () => [ITEM],
  getItem: async () => ({ item: ITEM, updates: ['Kicked off'], linked_tasks: [{ id: 't1', title: 'A', status: 'deploy' as const }] }),
};

/** Minimal Pi stub capturing registerTool calls. */
function fakePi() {
  const tools: { name: string; description: string; promptSnippet?: string; execute: Function }[] = [];
  return { tools, registerTool: (t: any) => tools.push(t) };
}

test('read tools register when Monday is configured', () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), ['monday_get_item', 'monday_search']);
});

test('monday_post_update is omitted when the project has updates disabled', () => {
  assert.deepEqual(mondayToolNames(READ_DEPS as any).sort(), ['monday_get_item', 'monday_search']);
});

test('monday_post_update registers only when postUpdate is supplied', () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, postUpdate: async () => {} } as any)(pi as any);
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), ['monday_get_item', 'monday_post_update', 'monday_search']);
});

test('every tool carries a promptSnippet', () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, postUpdate: async () => {} } as any)(pi as any);
  for (const tool of pi.tools) {
    assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0, `${tool.name} needs a promptSnippet`);
  }
});

test('monday_search returns formatted results', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const search = pi.tools.find((t) => t.name === 'monday_search')!;
  const result = await search.execute('call-1', { query: 'ship' });
  assert.match(result.content[0].text, /Ship the thing/);
  assert.equal(result.details.count, 1);
});

test('monday_search rejects an empty query', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const search = pi.tools.find((t) => t.name === 'monday_search')!;
  await assert.rejects(() => search.execute('call-1', { query: '  ' }), /non-empty/);
});

test('monday_get_item includes status, owners, updates, and linked tasks', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const get = pi.tools.find((t) => t.name === 'monday_get_item')!;
  const result = await get.execute('call-1', { item_id: '1' });
  const text = result.content[0].text as string;
  assert.match(text, /Working on it/);
  assert.match(text, /Keith Symmonds/);
  assert.match(text, /Kicked off/);
  assert.match(text, /A \(deploy\)/);
});

test('monday_get_item reports a missing item without throwing', async () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, getItem: async () => null } as any)(pi as any);
  const get = pi.tools.find((t) => t.name === 'monday_get_item')!;
  const result = await get.execute('call-1', { item_id: '404' });
  assert.equal(result.details.status, 'missing');
});

test('monday_post_update passes the body through to the dep', async () => {
  const pi = fakePi();
  let posted = '';
  createMondayExtension({ ...READ_DEPS, postUpdate: async (_id: string, body: string) => { posted = body; } } as any)(pi as any);
  const post = pi.tools.find((t) => t.name === 'monday_post_update')!;
  await post.execute('call-1', { item_id: '1', body: 'Done the migration' });
  assert.equal(posted, 'Done the migration');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../pi/monday-tool'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/pi/monday-tool.ts`:

```ts
/**
 * The agent's window onto Monday.
 *
 * Read-biased on purpose. An agent can read the initiative a task serves and
 * look wider when it needs to, but it cannot create items, set status, or edit
 * columns — it narrates to your portfolio, it does not restructure it.
 *
 * `monday_post_update` is registered only when the project has opted in, which
 * follows the memory_recall precedent: a session never advertises a tool that
 * cannot run.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { MondayItem, TaskStatus } from '@nexus/shared';

export interface MondayItemDetail {
  item: MondayItem;
  updates: string[];
  linked_tasks: { id: string; title: string; status: TaskStatus }[];
}

export interface MondayToolDeps {
  search(query: string, boardId?: string): Promise<MondayItem[]>;
  getItem(itemId: string): Promise<MondayItemDetail | null>;
  /** Present only when the project has opted in to agent-authored updates. */
  postUpdate?(itemId: string, body: string): Promise<void>;
}

const SearchSchema = Type.Object({
  query: Type.String({ description: 'Text to match against item names' }),
  board_id: Type.Optional(Type.String({
    description: "Board to search. Defaults to the project's configured board; pass this only to look outside it.",
  })),
});

const GetItemSchema = Type.Object({
  item_id: Type.String({ description: 'The Monday item id' }),
});

const PostUpdateSchema = Type.Object({
  item_id: Type.String({ description: 'The Monday item to post on' }),
  body: Type.String({ description: 'The update text, in your own words' }),
});

function formatItemLine(item: MondayItem): string {
  const status = item.status_label ? ` [${item.status_label}]` : '';
  const missing = item.state === 'missing' ? ' (no longer in Monday)' : '';
  return `- ${item.name}${status}${missing} — id ${item.item_id}${item.url ? ` — ${item.url}` : ''}`;
}

function formatDetail(detail: MondayItemDetail): string {
  const { item, updates, linked_tasks: linkedTasks } = detail;
  const owners = (JSON.parse(item.owners_json || '[]') as string[]).join(', ');
  const lines = [
    `${item.name} (id ${item.item_id})`,
    `Board: ${item.board_name}${item.group_title ? ` › ${item.group_title}` : ''}`,
    `Status: ${item.status_label ?? 'none'}`,
    `Owners: ${owners || 'none'}`,
  ];
  if (item.url) lines.push(`URL: ${item.url}`);
  if (linkedTasks.length > 0) {
    lines.push('', 'Linked Nexus tasks:');
    for (const task of linkedTasks) lines.push(`- ${task.title} (${task.status})`);
  }
  if (updates.length > 0) {
    lines.push('', 'Recent updates:');
    for (const update of updates) lines.push(`- ${update}`);
  }
  return lines.join('\n');
}

/** Which tools this dep set would register. Exposed for tests and diagnostics. */
export function mondayToolNames(deps: MondayToolDeps): string[] {
  const names = ['monday_search', 'monday_get_item'];
  if (deps.postUpdate) names.push('monday_post_update');
  return names;
}

export function createMondayExtension(deps: MondayToolDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'monday_search',
      label: 'Search Monday',
      description:
        'Search Monday.com items by name. Scoped to this project\'s board by default. Use it to find the '
        + 'initiative a piece of work belongs to, or related initiatives.',
      promptSnippet: 'monday_search: find Monday.com initiatives by name',
      parameters: SearchSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; count: number }>> {
        const query = params.query?.trim() ?? '';
        // Pi's agent loop turns a throw into an error tool result and continues
        // the turn, so throw rather than returning a pseudo-error to parse.
        if (!query) throw new Error('monday_search needs a non-empty query.');
        const items = await deps.search(query, params.board_id);
        if (items.length === 0) {
          return {
            content: [{ type: 'text', text: `No Monday items matched: ${query}` }],
            details: { status: 'empty', count: 0 },
          };
        }
        return {
          content: [{ type: 'text', text: items.map(formatItemLine).join('\n') }],
          details: { status: 'ok', count: items.length },
        };
      },
    });

    pi.registerTool({
      name: 'monday_get_item',
      label: 'Read Monday item',
      description:
        'Read a Monday.com item in full: status, owners, recent updates, and the Nexus tasks linked to it. '
        + 'Use it when the snapshot in your context may be stale, or to read an item you found via monday_search.',
      promptSnippet: 'monday_get_item: read a Monday.com initiative in full, including current status',
      parameters: GetItemSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string }>> {
        const detail = await deps.getItem(params.item_id);
        if (!detail) {
          return {
            content: [{ type: 'text', text: `No Monday item with id ${params.item_id}` }],
            details: { status: 'missing' },
          };
        }
        return {
          content: [{ type: 'text', text: formatDetail(detail) }],
          details: { status: 'ok' },
        };
      },
    });

    if (!deps.postUpdate) return;

    const postUpdate = deps.postUpdate;
    pi.registerTool({
      name: 'monday_post_update',
      label: 'Post Monday update',
      description:
        'Post an update to a Monday.com item\'s update thread, reporting progress in your own words. '
        + 'Use it for meaningful milestones, not routine steps. It cannot change the item\'s status or any column.',
      promptSnippet: 'monday_post_update: report progress on a Monday.com initiative',
      parameters: PostUpdateSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string }>> {
        const body = params.body?.trim() ?? '';
        if (!body) throw new Error('monday_post_update needs a non-empty body.');
        await postUpdate(params.item_id, body);
        return {
          content: [{ type: 'text', text: `Posted an update to Monday item ${params.item_id}.` }],
          details: { status: 'ok' },
        };
      },
    });
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 9 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/pi/monday-tool.ts src/backend/test/monday-tool.test.ts
git commit -m "feat(monday): agent read tools plus opt-in update tool"
```

---

## Task 10: Context injection and runtime wiring

**Files:**
- Create: `src/backend/pi/monday-context.ts`
- Modify: `src/backend/pi/runtime.ts`
- Test: `src/backend/test/monday-context.test.ts`

**Interfaces:**
- Consumes: `MondayItem` (Task 1), `RollupCounts` / `formatRollupText` (Task 3), `MondayToolDeps` (Task 9).
- Produces:
  - `interface MondayContextInput { item: MondayItem; rollupText: string; siblingCount: number; updates: string[] }`
  - `buildMondayContextBlock(input: MondayContextInput, maxChars?: number): string`
  - `PiRuntime` gains an optional `mondayContext?: (threadId: string, cwd: string) => MondayContextInput | null` and `mondayTools?: (threadId: string) => MondayToolDeps | null`, used to build `systemPromptOverride` and the extension.

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-context.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMondayContextBlock } from '../pi/monday-context';
import type { MondayItem } from '@nexus/shared';

const ITEM: MondayItem = {
  item_id: '900', board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
  name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/900', column_values_json: '{}',
  monday_updated_at: '2026-07-20T09:00:00Z', synced_at: '2026-07-22T10:00:00Z',
};

const INPUT = { item: ITEM, rollupText: '1 of 5 done', siblingCount: 5, updates: ['Kicked off', 'Blocked on infra'] };

test('the block names the item, status, owners, and roll-up', () => {
  const block = buildMondayContextBlock(INPUT);
  assert.match(block, /Ship the thing/);
  assert.match(block, /Working on it/);
  assert.match(block, /Keith Symmonds/);
  assert.match(block, /1 of 5 done/);
  assert.match(block, /https:\/\/x\.monday\.com\/900/);
});

test('the block states it is a snapshot and names the refresh tool', () => {
  const block = buildMondayContextBlock(INPUT);
  assert.match(block, /snapshot/i);
  assert.match(block, /monday_get_item/);
});

test('the block is capped and drops updates first', () => {
  const many = { ...INPUT, updates: Array.from({ length: 40 }, (_, i) => `Update number ${i} with a good deal of text`) };
  const block = buildMondayContextBlock(many, 600);
  assert.ok(block.length <= 600, `block was ${block.length} chars`);
  assert.match(block, /Ship the thing/, 'the headline must survive truncation');
  assert.match(block, /monday_get_item/, 'the refresh hint must survive truncation');
});

test('a missing item is flagged rather than rendered as normal', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, state: 'missing' } });
  assert.match(block, /no longer present in Monday/i);
});

test('an item with no owners or status renders without empty fields', () => {
  const block = buildMondayContextBlock({
    ...INPUT,
    item: { ...ITEM, status_label: null, owners_json: '[]' },
  });
  assert.doesNotMatch(block, /Owners:\s*$/m);
  assert.doesNotMatch(block, /Status:\s*$/m);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../pi/monday-context'`.

- [ ] **Step 3: Write the context builder**

Create `src/backend/pi/monday-context.ts`:

```ts
/**
 * The linked-item block injected into a task session's system prompt.
 *
 * This goes through systemPromptOverride rather than the transcript because
 * that hook is re-evaluated whenever a session is created OR resumed from
 * disk — so a thread reopened next week gets current item state instead of a
 * stale line frozen in message history, and the block never becomes something
 * the model re-reads on every turn.
 *
 * It is honest about staleness: the block says it is a snapshot and names the
 * tool that returns live state, rather than pretending to be current.
 */
import type { MondayItem } from '@nexus/shared';

export interface MondayContextInput {
  item: MondayItem;
  /** Pre-formatted roll-up, e.g. "1 of 5 done". */
  rollupText: string;
  /** How many Nexus tasks share this item. */
  siblingCount: number;
  updates: string[];
}

/** Roughly 400 tokens. Updates are dropped first when over budget. */
const DEFAULT_MAX_CHARS = 1600;

export function buildMondayContextBlock(
  input: MondayContextInput,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const { item, rollupText, siblingCount, updates } = input;
  const owners = (JSON.parse(item.owners_json || '[]') as string[]).join(', ');

  const head: string[] = ['## Monday.com initiative for this task', ''];
  if (item.state === 'missing') {
    head.push('WARNING: this item is no longer present in Monday. The link survives, but the details below are the last known state.');
    head.push('');
  }
  head.push(`Initiative: ${item.name} (id ${item.item_id})`);
  head.push(`Board: ${item.board_name}${item.group_title ? ` › ${item.group_title}` : ''}`);
  if (item.status_label) head.push(`Status: ${item.status_label}`);
  if (owners) head.push(`Owners: ${owners}`);
  if (item.url) head.push(`URL: ${item.url}`);
  head.push(`Nexus tasks under this initiative: ${siblingCount} (${rollupText})`);

  // Kept out of the truncation budget's reach: without it the model has no way
  // to know the block can be refreshed.
  const tail = [
    '',
    'This is a snapshot taken when this session started, not live data. Call monday_get_item for current state.',
  ];

  const headText = head.join('\n');
  const tailText = tail.join('\n');
  const budget = maxChars - headText.length - tailText.length;

  const body: string[] = [];
  if (updates.length > 0 && budget > 20) {
    let used = 0;
    const kept: string[] = [];
    for (const update of updates) {
      const line = `- ${update}`;
      if (used + line.length + 1 > budget - 'Recent updates:'.length - 2) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length > 0) body.push('', 'Recent updates:', ...kept);
  }

  const block = [headText, ...body, tailText].join('\n');
  return block.length <= maxChars ? block : `${headText}${tailText}`;
}
```

- [ ] **Step 4: Wire the runtime**

In `src/backend/pi/runtime.ts`, extend `buildSessionExtensionFactories` to accept an optional Monday dep resolver, and append the extension when it returns deps:

```ts
export function buildSessionExtensionFactories(
  threadId: string,
  cwd: string,
  questions: QuestionBroker,
  approvals: ApprovalBroker,
  isSupervised: () => boolean,
  signalFactoryBuilder: (cwd: string) => ExtensionFactory = createSignalFilterExtension,
  recallMemories?: MemoryRecallFn,
  mondayTools?: (threadId: string) => MondayToolDeps | null,
): ExtensionFactory[] {
  const monday = mondayTools?.(threadId) ?? null;
  return [
    createQuestionExtension(threadId, questions),
    createApprovalExtension(threadId, cwd, approvals, isSupervised),
    signalFactoryBuilder(cwd),
    // Omitted when the runtime was built without a recall backend (tests,
    // headless callers) so sessions don't advertise a tool that can't run.
    ...(recallMemories ? [createMemoryExtension(cwd, recallMemories)] : []),
    // Same contract for Monday: omitted wholesale when the feature is off,
    // unconfigured, or this thread's task has no linked item.
    ...(monday ? [createMondayExtension(monday)] : []),
  ];
}
```

Add the imports:

```ts
import { createMondayExtension, type MondayToolDeps } from './monday-tool.js';
import { buildMondayContextBlock, type MondayContextInput } from './monday-context.js';
```

Add two optional resolvers as `PiRuntime` fields, set the same way `recallMemories` is, and pass the tools resolver through in `createSession`:

```ts
      extensionFactories: buildSessionExtensionFactories(
        threadId, cwd, this.questions, this.approvals, () => this.isSupervised(threadId),
        createSignalFilterExtension, this.recallMemories, this.mondayTools,
      ),
```

Then extend the `buildResourceLoaderOptions` call in `createSession` with the system-prompt override:

```ts
    const mondayContext = this.mondayContext?.(threadId, cwd) ?? null;
    const resourceLoader = new DefaultResourceLoader(buildResourceLoaderOptions({
      cwd,
      agentDir: this.paths.sessionsDir,
      settingsManager,
      extensionFactories: buildSessionExtensionFactories(/* …as above… */),
      // Re-evaluated on every session create AND resume, so a thread reopened
      // later sees current item state rather than a stale frozen line.
      systemPromptOverride: mondayContext
        ? (base: string | undefined) => `${base ?? ''}\n\n${buildMondayContextBlock(mondayContext)}`
        : undefined,
    }) as ConstructorParameters<typeof DefaultResourceLoader>[0]);
```

Extend `buildResourceLoaderOptions`'s `Pick<...>` to include `systemPromptOverride` so it passes through:

```ts
export function buildResourceLoaderOptions(
  options: Pick<ResourceLoaderOptions, 'cwd' | 'agentDir' | 'settingsManager' | 'extensionFactories' | 'systemPromptOverride'>,
): ResourceLoaderOptions {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 5 new tests.

Run: `npm run --workspace=src/backend test`
Expected: PASS — the whole backend suite, including `pi-runtime.test.ts`, which exercises `buildSessionExtensionFactories` and must still pass with the new optional argument.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/backend/pi/monday-context.ts src/backend/pi/runtime.ts src/backend/test/monday-context.test.ts
git commit -m "feat(monday): inject linked-item context via systemPromptOverride"
```

---

## Task 11: Frontend API client and Project Management view

**Files:**
- Modify: `src/frontend/src/api.ts`
- Create: `src/frontend/src/components/ProjectManagementView.tsx`
- Test: `src/frontend/src/components/ProjectManagementView.test.tsx`

**Interfaces:**
- Consumes: `/api/monday/*` (Task 8), `MondayItemWithLinks` (Task 8).
- Produces (in `api.ts`):
  - `fetchMondayItems(projectId: string, refresh?: boolean): Promise<MondayItemWithLinks[]>`
  - `searchMondayItems(projectId: string, query: string): Promise<MondayItem[]>`
  - `linkTaskToMondayItem(projectId: string, taskId: string, itemId: string): Promise<void>`
  - `unlinkTaskFromMondayItem(taskId: string): Promise<void>`
  - `fetchMondayLinks(projectId: string): Promise<TaskMondayLink[]>`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/components/ProjectManagementView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ProjectManagementView } from './ProjectManagementView';
import * as api from '../api';

const ITEM = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
  name: 'Ship the thing', state: 'active' as const, status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/1', column_values_json: '{}',
  monday_updated_at: null, synced_at: 'now',
  rollup: { total: 3, open: 1, inProgress: 0, inReview: 1, done: 1 },
  rollup_text: '1/3 done · 1 in review',
  task_ids: ['t1', 't2', 't3'],
};

beforeEach(() => vi.restoreAllMocks());

describe('ProjectManagementView', () => {
  it('renders items grouped by Monday group with their roll-up', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([ITEM] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText('Ship the thing')).toBeTruthy();
    expect(screen.getByText('1/3 done · 1 in review')).toBeTruthy();
    expect(screen.getByText('Q3')).toBeTruthy();
  });

  it('shows an empty state when no items are mirrored', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/no monday items/i)).toBeTruthy();
  });

  it('flags an item that is no longer in Monday', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockResolvedValue([{ ...ITEM, state: 'missing' }] as never);
    render(<ProjectManagementView projectId="p1" />);
    expect(await screen.findByText(/unavailable/i)).toBeTruthy();
  });

  it('surfaces a load failure instead of rendering an empty board', async () => {
    vi.spyOn(api, 'fetchMondayItems').mockRejectedValue(new Error('Not Authenticated'));
    render(<ProjectManagementView projectId="p1" />);
    await waitFor(() => expect(screen.getByText(/Not Authenticated/)).toBeTruthy());
    expect(screen.queryByText(/no monday items/i)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/frontend test -- ProjectManagementView`
Expected: FAIL — cannot resolve `./ProjectManagementView`.

- [ ] **Step 3: Add the API client functions**

In `src/frontend/src/api.ts`. The file already imports `apiFetch` from `./api-base` — use it rather than calling `fetch` directly, and add the new types to the existing `@nexus/shared` import list at the top:

```ts
import type { MondayItem, MondayItemWithLinks, TaskMondayLink } from '@nexus/shared';

export async function fetchMondayItems(projectId: string, refresh = false): Promise<MondayItemWithLinks[]> {
  const query = refresh ? '?refresh=1' : '';
  const data = await apiFetch<{ items: MondayItemWithLinks[] }>(`/api/monday/projects/${projectId}/items${query}`);
  return data.items;
}

export async function searchMondayItems(projectId: string, query: string): Promise<MondayItem[]> {
  const data = await apiFetch<{ items: MondayItem[] }>(
    `/api/monday/projects/${projectId}/search?q=${encodeURIComponent(query)}`,
  );
  return data.items;
}

export async function fetchMondayLinks(projectId: string): Promise<TaskMondayLink[]> {
  const data = await apiFetch<{ links: TaskMondayLink[] }>(`/api/monday/projects/${projectId}/links`);
  return data.links;
}

export async function linkTaskToMondayItem(projectId: string, taskId: string, itemId: string): Promise<void> {
  await apiFetch('/api/monday/links', {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, task_id: taskId, item_id: itemId }),
  });
}

export async function unlinkTaskFromMondayItem(taskId: string): Promise<void> {
  await apiFetch(`/api/monday/links/${taskId}`, { method: 'DELETE' });
}
```

- [ ] **Step 4: Write the view**

Create `src/frontend/src/components/ProjectManagementView.tsx`:

```tsx
/**
 * The initiative level. Monday items for the project's configured scope,
 * grouped the way Monday groups them, each showing the roll-up computed from
 * its linked Nexus tasks.
 *
 * A load failure renders as an error, never as an empty board — "Monday
 * rejected our token" and "this board has no items" must not look alike.
 */
import { useCallback, useEffect, useState } from 'react';
import type { MondayItemWithLinks } from '@nexus/shared';
import { fetchMondayItems } from '../api';

interface Props {
  projectId: string;
}

export function ProjectManagementView({ projectId }: Props) {
  const [items, setItems] = useState<MondayItemWithLinks[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setError(null);
    if (refresh) setRefreshing(true);
    try {
      setItems(await fetchMondayItems(projectId, refresh));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => { void load(false); }, [load]);

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-500">{error}</p>
        <button type="button" className="mt-3 underline" onClick={() => void load(false)}>Retry</button>
      </div>
    );
  }

  if (items === null) return <div className="p-6 opacity-60">Loading Monday items…</div>;
  if (items.length === 0) return <div className="p-6 opacity-60">No Monday items in this project&apos;s scope.</div>;

  const groups = new Map<string, MondayItemWithLinks[]>();
  for (const item of items) {
    const key = item.group_title ?? 'Ungrouped';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Project Management</h2>
        <button type="button" className="text-sm underline" disabled={refreshing} onClick={() => void load(true)}>
          {refreshing ? 'Refreshing…' : 'Refresh from Monday'}
        </button>
      </div>

      {[...groups.entries()].map(([groupTitle, groupItems]) => (
        <section key={groupTitle} className="space-y-2">
          <h3 className="text-sm uppercase tracking-wide opacity-60">{groupTitle}</h3>
          <ul className="space-y-2">
            {groupItems.map((item) => (
              <li key={item.item_id} className="rounded border border-white/10 p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">{item.name}</span>
                  <span className="text-sm opacity-70">{item.rollup_text}</span>
                </div>
                <div className="mt-1 text-sm opacity-60">
                  {item.status_label ? <span className="mr-3">{item.status_label}</span> : null}
                  <span>{item.task_ids.length} linked task{item.task_ids.length === 1 ? '' : 's'}</span>
                  {item.state === 'missing' ? <span className="ml-3 text-amber-500">item unavailable in Monday</span> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace=src/frontend test -- ProjectManagementView`
Expected: PASS — 4 tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/api.ts src/frontend/src/components/ProjectManagementView.tsx src/frontend/src/components/ProjectManagementView.test.tsx
git commit -m "feat(monday): Project Management view with per-item roll-up"
```

---

## Task 12: Kanban badge, link picker, and Settings

**Files:**
- Create: `src/frontend/src/components/MondayBadge.tsx`
- Create: `src/frontend/src/components/MondayItemPicker.tsx`
- Modify: `src/frontend/src/components/KanbanBoard.tsx`
- Modify: `src/frontend/src/components/SettingsPage.tsx`
- Modify: `src/backend/trust/snapshot.ts`
- Test: `src/frontend/src/components/MondayItemPicker.test.tsx`

**Interfaces:**
- Consumes: `fetchMondayLinks`, `searchMondayItems`, `linkTaskToMondayItem`, `unlinkTaskFromMondayItem` (Task 11).
- Produces:
  - `<MondayBadge item={MondayItem | undefined} />`
  - `<MondayItemPicker projectId taskId currentItemId onLinked />`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/components/MondayItemPicker.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MondayItemPicker } from './MondayItemPicker';
import * as api from '../api';

const ITEM = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active' as const, status_label: null, status_color: null,
  owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
};

beforeEach(() => vi.restoreAllMocks());

describe('MondayItemPicker', () => {
  it('searches Monday live and links the chosen item', async () => {
    const search = vi.spyOn(api, 'searchMondayItems').mockResolvedValue([ITEM] as never);
    const link = vi.spyOn(api, 'linkTaskToMondayItem').mockResolvedValue(undefined as never);
    const onLinked = vi.fn();
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId={null} onLinked={onLinked} />);

    await userEvent.type(screen.getByPlaceholderText(/search monday/i), 'ship');
    await waitFor(() => expect(search).toHaveBeenCalledWith('p1', 'ship'));
    await userEvent.click(await screen.findByText('Ship the thing'));

    await waitFor(() => expect(link).toHaveBeenCalledWith('p1', 't1', '1'));
    expect(onLinked).toHaveBeenCalled();
  });

  it('offers unlink when the task already has a link', async () => {
    const unlink = vi.spyOn(api, 'unlinkTaskFromMondayItem').mockResolvedValue(undefined as never);
    vi.spyOn(api, 'searchMondayItems').mockResolvedValue([] as never);
    const onLinked = vi.fn();
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId="1" onLinked={onLinked} />);
    await userEvent.click(screen.getByRole('button', { name: /unlink/i }));
    await waitFor(() => expect(unlink).toHaveBeenCalledWith('t1'));
  });

  it('surfaces a search failure', async () => {
    vi.spyOn(api, 'searchMondayItems').mockRejectedValue(new Error('Not Authenticated'));
    render(<MondayItemPicker projectId="p1" taskId="t1" currentItemId={null} onLinked={vi.fn()} />);
    await userEvent.type(screen.getByPlaceholderText(/search monday/i), 'x');
    expect(await screen.findByText(/Not Authenticated/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/frontend test -- MondayItemPicker`
Expected: FAIL — cannot resolve `./MondayItemPicker`.

- [ ] **Step 3: Write the badge**

Create `src/frontend/src/components/MondayBadge.tsx`:

```tsx
/** Single chip on a Kanban card showing the task's linked Monday initiative. */
import type { MondayItem } from '@nexus/shared';

interface Props {
  item: MondayItem | undefined;
}

export function MondayBadge({ item }: Props) {
  if (!item) return null;
  const unavailable = item.state === 'missing';
  return (
    <span
      title={unavailable ? `${item.name} — no longer in Monday` : item.name}
      className={`inline-flex max-w-[12rem] truncate rounded px-1.5 py-0.5 text-[11px] ${
        unavailable ? 'bg-amber-500/15 text-amber-500' : 'bg-sky-500/15 text-sky-400'
      }`}
    >
      {item.name}
    </span>
  );
}
```

- [ ] **Step 4: Write the picker**

Create `src/frontend/src/components/MondayItemPicker.tsx`:

```tsx
/**
 * Link a task to a Monday item. Reachable from both ends — an item row in the
 * Project Management view and the task modal on Kanban — so this component is
 * shared rather than duplicated.
 *
 * Search hits Monday live rather than the mirror, so an item created moments
 * ago is findable.
 */
import { useEffect, useState } from 'react';
import type { MondayItem } from '@nexus/shared';
import { searchMondayItems, linkTaskToMondayItem, unlinkTaskFromMondayItem } from '../api';

interface Props {
  projectId: string;
  taskId: string;
  currentItemId: string | null;
  onLinked: () => void;
}

export function MondayItemPicker({ projectId, taskId, currentItemId, onLinked }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MondayItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setError(null);
      try {
        const items = await searchMondayItems(projectId, query.trim());
        if (!cancelled) setResults(items);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [projectId, query]);

  async function link(itemId: string) {
    setBusy(true);
    setError(null);
    try {
      await linkTaskToMondayItem(projectId, taskId, itemId);
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await unlinkTaskFromMondayItem(taskId);
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        type="search"
        value={query}
        placeholder="Search Monday initiatives…"
        onChange={(event) => setQuery(event.target.value)}
        className="w-full rounded border border-white/10 bg-transparent px-2 py-1 text-sm"
      />
      {error ? <p className="text-sm text-red-500">{error}</p> : null}
      {currentItemId ? (
        <button type="button" disabled={busy} onClick={() => void unlink()} className="text-sm underline">
          Unlink from Monday
        </button>
      ) : null}
      <ul className="max-h-56 space-y-1 overflow-y-auto">
        {results.map((item) => (
          <li key={item.item_id}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void link(item.item_id)}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-white/5"
            >
              {item.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Wire the badge into Kanban**

In `src/frontend/src/components/KanbanBoard.tsx`:

1. Load links **with the task list**, not per card — every card render needs link state, so a per-card fetch would be one request per card:

```tsx
const [mondayItems, setMondayItems] = useState<Map<string, MondayItemWithLinks>>(new Map());

useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const items = await fetchMondayItems(projectId);
      if (cancelled) return;
      const byTask = new Map<string, MondayItemWithLinks>();
      for (const item of items) {
        for (const taskId of item.task_ids) byTask.set(taskId, item);
      }
      setMondayItems(byTask);
    } catch {
      // Monday being unavailable must never block the board: cards simply
      // render without their badge.
      if (!cancelled) setMondayItems(new Map());
    }
  })();
  return () => { cancelled = true; };
}, [projectId]);
```

2. Render the badge in the card body, alongside the existing metadata row:

```tsx
<MondayBadge item={mondayItems.get(task.id)} />
```

3. Add the imports:

```tsx
import { MondayBadge } from './MondayBadge';
import { fetchMondayItems } from '../api';
import type { MondayItemWithLinks } from '@nexus/shared';
```

- [ ] **Step 6: Add the Settings section**

In `src/frontend/src/components/SettingsPage.tsx`, add a Monday section following the existing Jira/GitHub section pattern in that file. It edits the global `monday` block (`enabled`, `api_version`, `poll_minutes`) and states that the token comes from `MONDAY_TOKEN` and is never stored in config — mirroring how the Jira section describes `JIRA_TOKEN`.

In `src/backend/trust/snapshot.ts`, add Monday to the snapshot the same way Jira and GitHub appear: `MONDAY_TOKEN` as a secret source, `https://api.monday.com/v2` as an outbound destination, and the `monday_items` mirror as clearable state.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run --workspace=src/frontend test`
Expected: PASS — the whole frontend suite, including the 3 new picker tests and the existing KanbanBoard tests.

Run: `npm run --workspace=src/backend test`
Expected: PASS — the whole backend suite.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/components/MondayBadge.tsx src/frontend/src/components/MondayItemPicker.tsx src/frontend/src/components/MondayItemPicker.test.tsx src/frontend/src/components/KanbanBoard.tsx src/frontend/src/components/SettingsPage.tsx src/backend/trust/snapshot.ts
git commit -m "feat(monday): Kanban badge, shared link picker, Settings and trust snapshot"
```

---

## Task 13: Resolve a thread's Monday deps

**Files:**
- Create: `src/backend/monday/session-deps.ts`
- Modify: `src/backend/index.ts`
- Test: `src/backend/test/monday-session-deps.test.ts`

Task 10 defined `PiRuntime.mondayContext` and `PiRuntime.mondayTools` and made the runtime consume them, but nothing supplies them. This task builds the resolvers and hands them to the runtime where `recallMemories` is supplied today (`src/backend/index.ts:55`).

**Interfaces:**
- Consumes: store (Task 4), client (Task 2), writes (Task 6), `MondayToolDeps` / `MondayItemDetail` (Task 9), `MondayContextInput` (Task 10).
- Produces:
  - `resolveThreadItem(db, threadId: string): { item: MondayItem; projectId: string; cfg: MondayProjectConfig; taskId: string } | null`
  - `buildMondayContext(db, threadId: string): MondayContextInput | null`
  - `buildMondayToolDeps(db, threadId: string): MondayToolDeps | null`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-session-deps.test.ts`:

```ts
delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../db';
import { buildMondayContext, buildMondayToolDeps, resolveThreadItem } from '../monday/session-deps';
import { upsertItems, linkTask } from '../monday/store';

function seed(db: ReturnType<typeof getDb>, updatesEnabled: boolean) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: updatesEnabled, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at, thread_id)
              VALUES ('t1','p1','Migrate DB','','review','medium','now','now','thread-1')`).run();
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t2','p1','Sibling','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
    name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  linkTask(db, { task_id: 't2', item_id: '1', project_id: 'p1', created_at: 'now' });
}

test('resolveThreadItem finds the item via thread → task → link', () => {
  const db = getDb(':memory:');
  seed(db, false);
  const resolved = resolveThreadItem(db, 'thread-1')!;
  assert.equal(resolved.item.name, 'Ship the thing');
  assert.equal(resolved.taskId, 't1');
  assert.equal(resolved.projectId, 'p1');
  db.close();
});

test('resolveThreadItem returns null for a thread with no linked task', () => {
  const db = getDb(':memory:');
  seed(db, false);
  assert.equal(resolveThreadItem(db, 'thread-unknown'), null);
  db.close();
});

test('buildMondayContext counts siblings and formats the roll-up', () => {
  const db = getDb(':memory:');
  seed(db, false);
  const ctx = buildMondayContext(db, 'thread-1')!;
  assert.equal(ctx.siblingCount, 2);
  assert.equal(ctx.rollupText, '1/2 done · 1 in review');
  db.close();
});

test('buildMondayContext returns null when the thread has no link', () => {
  const db = getDb(':memory:');
  seed(db, false);
  assert.equal(buildMondayContext(db, 'thread-unknown'), null);
  db.close();
});

test('tool deps omit postUpdate when the project has updates disabled', () => {
  const db = getDb(':memory:');
  seed(db, false);
  process.env.MONDAY_TOKEN = 'tok';
  const deps = buildMondayToolDeps(db, 'thread-1')!;
  assert.equal(deps.postUpdate, undefined);
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('tool deps include postUpdate when the project opts in', () => {
  const db = getDb(':memory:');
  seed(db, true);
  process.env.MONDAY_TOKEN = 'tok';
  const deps = buildMondayToolDeps(db, 'thread-1')!;
  assert.equal(typeof deps.postUpdate, 'function');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('tool deps are null without a token, so no tool is advertised', () => {
  const db = getDb(':memory:');
  seed(db, true);
  assert.equal(buildMondayToolDeps(db, 'thread-1'), null);
  db.close();
});

test('getItem dep reports the linked Nexus tasks', async () => {
  const db = getDb(':memory:');
  seed(db, false);
  process.env.MONDAY_TOKEN = 'tok';
  const deps = buildMondayToolDeps(db, 'thread-1')!;
  const detail = await deps.getItem('1');
  assert.equal(detail!.linked_tasks.length, 2);
  assert.ok(detail!.linked_tasks.some((t) => t.title === 'Migrate DB'));
  delete process.env.MONDAY_TOKEN;
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/session-deps'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/session-deps.ts`:

```ts
/**
 * Turns a chat thread into the Monday context and tools its session should get.
 *
 * A thread only gets any of this when its task has a link, so the vast
 * majority of sessions pay nothing: no injected block, no registered tools.
 * That is the same contract memory_recall follows — never advertise a tool
 * that cannot run.
 */
import type Database from 'better-sqlite3';
import type { MondayItem, MondayProjectConfig, Project, TaskStatus } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from './poll.js';
import { getItem, listLinkedTaskStatuses } from './store.js';
import { fetchBoardItems, type MondayClientOptions } from './client.js';
import { mapItem } from './map.js';
import { postItemUpdate } from './writes.js';
import { computeRollup, formatRollupText } from './rollup.js';
import type { MondayToolDeps, MondayItemDetail } from '../pi/monday-tool.js';
import type { MondayContextInput } from '../pi/monday-context.js';

interface ResolvedThread {
  item: MondayItem;
  projectId: string;
  cfg: MondayProjectConfig;
  taskId: string;
}

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** thread → task → link → item. Null when any hop is missing. */
export function resolveThreadItem(db: Database.Database, threadId: string): ResolvedThread | null {
  const row = db.prepare(`
    SELECT t.id AS task_id, t.project_id AS project_id, l.item_id AS item_id
    FROM tasks t
    JOIN task_monday_links l ON l.task_id = t.id
    WHERE t.thread_id = ?
  `).get(threadId) as { task_id: string; project_id: string; item_id: string } | undefined;
  if (!row) return null;

  const item = getItem(db, row.item_id);
  if (!item) return null;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(row.project_id) as Project | undefined;
  const cfg = projectMondayConfig(project);
  if (!cfg) return null;

  return { item, projectId: row.project_id, cfg, taskId: row.task_id };
}

/** The most recent updates already mirrored for an item, newest first. */
function recentUpdates(item: MondayItem): string[] {
  try {
    const cols = JSON.parse(item.column_values_json || '{}') as Record<string, { text?: string | null }>;
    const updates = cols.updates?.text;
    return updates ? [updates] : [];
  } catch {
    return [];
  }
}

export function buildMondayContext(db: Database.Database, threadId: string): MondayContextInput | null {
  const resolved = resolveThreadItem(db, threadId);
  if (!resolved) return null;
  const counts = computeRollup(listLinkedTaskStatuses(db, resolved.item.item_id));
  return {
    item: resolved.item,
    rollupText: formatRollupText(counts),
    siblingCount: counts.total,
    updates: recentUpdates(resolved.item),
  };
}

function clientOptions(): MondayClientOptions | null {
  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!cfg.enabled || !token) return null;
  return { token, apiVersion: cfg.api_version };
}

export function buildMondayToolDeps(db: Database.Database, threadId: string): MondayToolDeps | null {
  const resolved = resolveThreadItem(db, threadId);
  if (!resolved) return null;
  const opts = clientOptions();
  if (!opts) return null;

  const deps: MondayToolDeps = {
    async search(query, boardId) {
      const now = new Date().toISOString();
      const raw = await fetchBoardItems(opts, boardId ?? resolved.cfg.board_id, boardId ? null : resolved.cfg.group_id ?? null);
      const needle = query.toLowerCase();
      return raw.map((r) => mapItem(r, now)).filter((item) => item.name.toLowerCase().includes(needle)).slice(0, 25);
    },
    async getItem(itemId): Promise<MondayItemDetail | null> {
      const item = getItem(db, itemId);
      if (!item) return null;
      const linkedTasks = db.prepare(`
        SELECT t.id AS id, t.title AS title, t.status AS status
        FROM task_monday_links l JOIN tasks t ON t.id = l.task_id
        WHERE l.item_id = ?
      `).all(itemId) as { id: string; title: string; status: TaskStatus }[];
      return { item, updates: recentUpdates(item), linked_tasks: linkedTasks };
    },
  };

  // Registered only when the project opted in. Supervised threads still gate
  // the call through the existing ApprovalBroker, which wraps every tool call
  // in a supervised session — no extra gating is needed here.
  if (resolved.cfg.updates.enabled) {
    const task = db.prepare('SELECT title FROM tasks WHERE id = ?').get(resolved.taskId) as { title: string } | undefined;
    const provenance = `Nexus task "${task?.title ?? resolved.taskId}" (thread ${threadId})`;
    deps.postUpdate = async (itemId, body) => {
      await postItemUpdate(db, opts, itemId, body, provenance);
    };
  }

  return deps;
}
```

- [ ] **Step 4: Hand the resolvers to the runtime**

In `src/backend/index.ts`, at the `PiRuntime` construction (around line 55, where `recallMemories` is supplied), add:

```ts
    mondayContext: (threadId) => buildMondayContext(db, threadId),
    mondayTools: (threadId) => buildMondayToolDeps(db, threadId),
```

with the import:

```ts
import { buildMondayContext, buildMondayToolDeps } from './monday/session-deps.js';
```

The `mondayContext` signature declared in Task 10 is `(threadId, cwd)`; `cwd` is unused here, so declare the parameter and ignore it rather than changing the runtime's call site.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: PASS — 8 new tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/backend/monday/session-deps.ts src/backend/index.ts src/backend/test/monday-session-deps.test.ts
git commit -m "feat(monday): resolve per-thread Monday context and tool deps"
```

---

## Task 14: Roll-up write trigger and column self-disable

**Files:**
- Create: `src/backend/monday/trigger.ts`
- Modify: `src/backend/routes/projects.ts`
- Modify: `src/backend/routes/monday.ts`
- Test: `src/backend/test/monday-trigger.test.ts`

`writeRollup` and `UpdateThrottle` exist but nothing calls them. This task is the trigger, plus the spec's last unimplemented error rule: a deleted roll-up column notifies once and self-disables rather than retrying forever.

**Interfaces:**
- Consumes: `writeRollup`, `postItemUpdate`, `UpdateThrottle` (Task 6); `getLinkForTask` (Task 4); `MondayError` (Task 2).
- Produces:
  - `scheduleRollup(db, taskId: string, event: string | null, emit?): Promise<void>`
  - `disableRollupForProject(db, projectId: string, reason: string): void`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/monday-trigger.test.ts`:

```ts
delete process.env.MONDAY_TOKEN;

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { MondayProjectConfig, Project } from '@nexus/shared';
import { getDb } from '../db';
import { scheduleRollup, disableRollupForProject } from '../monday/trigger';
import { __resetWriteState } from '../monday/writes';
import { upsertItems, linkTask } from '../monday/store';
import { MondayError } from '../monday/client';
import type { ActivityEvent } from '../activity/events';

beforeEach(() => __resetWriteState());

function seed(db: ReturnType<typeof getDb>) {
  db.prepare(`INSERT INTO projects (id, slug, name, badge, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at)
              VALUES ('p1','p','P','P','','', ?, 0, '', 'now','now')`)
    .run(JSON.stringify({
      monday: {
        board_id: 'b1', group_id: null,
        rollup: { enabled: true, column_id: 'text_1', column_type: 'text' },
        updates: { enabled: false, min_interval_minutes: 30 },
      },
    }));
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t1','p1','A','','deploy','medium','now','now')`).run();
  upsertItems(db, [{
    item_id: '1', board_id: 'b1', board_name: '', group_id: null, group_title: null,
    name: 'Initiative', state: 'active', status_label: null, status_color: null,
    owners_json: '[]', url: null, column_values_json: '{}', monday_updated_at: null, synced_at: 'now',
  }]);
  linkTask(db, { task_id: 't1', item_id: '1', project_id: 'p1', created_at: 'now' });
  process.env.MONDAY_TOKEN = 'tok';
}

function readConfig(db: ReturnType<typeof getDb>): MondayProjectConfig {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get('p1') as Project;
  return (JSON.parse(project.config_json) as { monday: MondayProjectConfig }).monday;
}

test('a rollup write emits a monday_write operation', async () => {
  const db = getDb(':memory:');
  seed(db);
  const events: ActivityEvent[] = [];
  await scheduleRollup(db, 't1', null, (e) => events.push(e), { setColumn: async () => {}, postUpdate: async () => {} } as never);
  assert.equal(events[0].kind, 'monday_write');
  assert.equal(events.at(-1)!.status, 'succeeded');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('scheduleRollup is a no-op for an unlinked task and never throws', async () => {
  const db = getDb(':memory:');
  seed(db);
  db.prepare(`INSERT INTO tasks (id, project_id, title, description, status, priority, created_at, updated_at)
              VALUES ('t9','p1','B','','todo','medium','now','now')`).run();
  const events: ActivityEvent[] = [];
  await scheduleRollup(db, 't9', null, (e) => events.push(e));
  assert.equal(events.length, 0);
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('a failed write does not throw — the caller must not be blocked', async () => {
  const db = getDb(':memory:');
  seed(db);
  const events: ActivityEvent[] = [];
  await scheduleRollup(db, 't1', null, (e) => events.push(e), {
    setColumn: async () => { throw new MondayError('rate limited', 'RateLimit', 429, 10); },
    postUpdate: async () => {},
  } as never);
  assert.equal(events.at(-1)!.status, 'failed');
  assert.equal(readConfig(db).rollup.enabled, true, 'a retryable failure must not disable roll-up');
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('a deleted roll-up column self-disables the project and notifies once', async () => {
  const db = getDb(':memory:');
  seed(db);
  const fail = { setColumn: async () => { throw new MondayError('Column not found', 'ColumnValueException', 200); }, postUpdate: async () => {} };
  await scheduleRollup(db, 't1', null, undefined, fail as never);
  assert.equal(readConfig(db).rollup.enabled, false);
  const notes = db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number };
  assert.equal(notes.c, 1);

  // Now disabled, a second call must not write or notify again.
  await scheduleRollup(db, 't1', null, undefined, fail as never);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c, 1);
  delete process.env.MONDAY_TOKEN;
  db.close();
});

test('disableRollupForProject preserves the rest of the project config', () => {
  const db = getDb(':memory:');
  seed(db);
  disableRollupForProject(db, 'p1', 'column deleted');
  const cfg = readConfig(db);
  assert.equal(cfg.rollup.enabled, false);
  assert.equal(cfg.board_id, 'b1', 'scope must survive');
  assert.equal(cfg.updates.min_interval_minutes, 30);
  delete process.env.MONDAY_TOKEN;
  db.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/backend test -- --test-name-pattern="monday"`
Expected: FAIL — `Cannot find module '../monday/trigger'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/monday/trigger.ts`:

```ts
/**
 * The single funnel every write trigger goes through: task status change,
 * link, unlink, task delete.
 *
 * Two rules matter here. A write failure never propagates to the caller — the
 * Kanban move already succeeded locally and the operation is retryable from
 * the Activity Console. And a write that fails because the configured column
 * no longer exists in Monday self-disables roll-up for that project after one
 * notification, rather than failing on every future move forever.
 */
import type Database from 'better-sqlite3';
import type { MondayProjectConfig, Project } from '@nexus/shared';
import { loadConfig } from '../config.js';
import { resolveMondayToken } from './poll.js';
import { getLinkForTask } from './store.js';
import { writeRollup, type RollupWriteDeps } from './writes.js';
import { MondayError, type MondayClientOptions } from './client.js';
import { insertNotification } from '../notifications/index.js';
import type { ActivityEvent } from '../activity/events.js';

/** Error codes that mean the configuration is wrong, not that Monday is busy. */
const CONFIG_ERROR_CODES = new Set(['ColumnValueException', 'InvalidColumnIdException']);

function projectMondayConfig(project: Project | undefined): MondayProjectConfig | null {
  if (!project) return null;
  try {
    const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
    return parsed.monday?.board_id ? parsed.monday : null;
  } catch {
    return null;
  }
}

/** Turn roll-up off for a project, leaving every other setting intact. */
export function disableRollupForProject(db: Database.Database, projectId: string, reason: string): void {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  if (!project) return;
  const parsed = JSON.parse(project.config_json || '{}') as { monday?: MondayProjectConfig };
  if (!parsed.monday) return;
  parsed.monday.rollup.enabled = false;
  db.prepare('UPDATE projects SET config_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(parsed), new Date().toISOString(), projectId);
  insertNotification(db, {
    level: 'error',
    title: 'Monday roll-up disabled',
    message: `${reason}. Re-select a roll-up column in the project's Monday settings to turn it back on.`,
  });
}

/**
 * Recompute and write the roll-up for whatever item this task is linked to.
 * Silent no-op when the task has no link, when Monday is off, or when the
 * project has roll-up disabled. Never throws.
 */
export async function scheduleRollup(
  db: Database.Database,
  taskId: string,
  _event: string | null,
  emit?: (event: ActivityEvent) => void,
  deps?: RollupWriteDeps,
): Promise<void> {
  const link = getLinkForTask(db, taskId);
  if (!link) return;

  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!cfg.enabled || !token) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(link.project_id) as Project | undefined;
  const projectCfg = projectMondayConfig(project);
  if (!projectCfg || !projectCfg.rollup.enabled || !projectCfg.rollup.column_id) return;

  const opts: MondayClientOptions = { token, apiVersion: cfg.api_version };
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  emit?.({
    type: 'start', operationId, kind: 'monday_write', title: 'Monday roll-up',
    projectId: link.project_id, taskId,
  });

  try {
    const result = await writeRollup(db, opts, projectCfg, link.item_id, deps);
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
      projectId: link.project_id, taskId, status: 'succeeded',
      durationMs: Date.now() - startedAt, lastEvent: result,
    });
  } catch (err) {
    const monday = err as MondayError;
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
      projectId: link.project_id, taskId, status: 'failed',
      durationMs: Date.now() - startedAt, error: monday.message,
    });
    // A missing column is a configuration problem: retrying it on every future
    // task move would fail forever and bury the Activity Console.
    if (monday.code && CONFIG_ERROR_CODES.has(monday.code)) {
      disableRollupForProject(db, link.project_id, `Monday rejected the roll-up column: ${monday.message}`);
    }
  }
}
```

- [ ] **Step 4: Call the trigger from the task status path**

In `src/backend/routes/projects.ts`, find the handler that updates a task's status (the Kanban move endpoint) and, after the status update commits and the response value is built, add a fire-and-forget call:

```ts
  void scheduleRollup(db, taskId, `task moved to ${status}`, (event) => activity.handleEvent(event));
```

Use `void` deliberately: the roll-up must never delay or fail the Kanban move. Add the import:

```ts
import { scheduleRollup } from '../monday/trigger.js';
```

Match how the surrounding handlers reach the ActivityManager — if they don't have one in scope, omit the `emit` argument rather than threading a new dependency through the route.

- [ ] **Step 5: Call the trigger from link and unlink**

Unlink is the awkward case: once the link is gone, `scheduleRollup(db, taskId)` finds nothing and returns, leaving the item showing a stale count that includes the task you just detached. So the trigger needs an item-addressed entry point as well as a task-addressed one.

First refactor `src/backend/monday/trigger.ts` so the body lives in an item-addressed function and `scheduleRollup` delegates to it. Replace the `scheduleRollup` you wrote in Step 3 with:

```ts
/**
 * Roll up a specific item. The item-addressed form, needed by unlink — where
 * the link is already gone by the time we recompute.
 */
export async function scheduleRollupForItem(
  db: Database.Database,
  itemId: string,
  projectId: string,
  taskId: string | null,
  emit?: (event: ActivityEvent) => void,
  deps?: RollupWriteDeps,
): Promise<void> {
  const cfg = loadConfig().monday;
  const token = resolveMondayToken();
  if (!cfg.enabled || !token) return;

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
  const projectCfg = projectMondayConfig(project);
  if (!projectCfg || !projectCfg.rollup.enabled || !projectCfg.rollup.column_id) return;

  const opts: MondayClientOptions = { token, apiVersion: cfg.api_version };
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  emit?.({ type: 'start', operationId, kind: 'monday_write', title: 'Monday roll-up', projectId, taskId });

  try {
    const result = await writeRollup(db, opts, projectCfg, itemId, deps);
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
      projectId, taskId, status: 'succeeded', durationMs: Date.now() - startedAt, lastEvent: result,
    });
  } catch (err) {
    const monday = err as MondayError;
    emit?.({
      type: 'stop', operationId, kind: 'monday_write', title: 'Monday roll-up',
      projectId, taskId, status: 'failed', durationMs: Date.now() - startedAt, error: monday.message,
    });
    // A missing column is a configuration problem: retrying it on every future
    // task move would fail forever and bury the Activity Console.
    if (monday.code && CONFIG_ERROR_CODES.has(monday.code)) {
      disableRollupForProject(db, projectId, `Monday rejected the roll-up column: ${monday.message}`);
    }
  }
}

/** Roll up whatever item this task is linked to. Silent no-op when unlinked. */
export async function scheduleRollup(
  db: Database.Database,
  taskId: string,
  _event: string | null,
  emit?: (event: ActivityEvent) => void,
  deps?: RollupWriteDeps,
): Promise<void> {
  const link = getLinkForTask(db, taskId);
  if (!link) return;
  await scheduleRollupForItem(db, link.item_id, link.project_id, taskId, emit, deps);
}
```

Then in `src/backend/routes/monday.ts`, after `linkTask(db, link)` in the POST handler:

```ts
      void scheduleRollup(db, taskId, 'task linked');
```

And in the DELETE handler, capture the link **before** removing it:

```ts
  app.delete<{ Params: { taskId: string } }>('/api/monday/links/:taskId', async (request) => {
    const existing = getLinkForTask(db, request.params.taskId);
    unlinkTask(db, request.params.taskId);
    if (existing) {
      // Recompute the item we just detached from, or it keeps a count that
      // still includes this task.
      void scheduleRollupForItem(db, existing.item_id, existing.project_id, null);
    }
    return { ok: true };
  });
```

Add `getLinkForTask` to the existing store import in that file, and import `scheduleRollup` / `scheduleRollupForItem` from `../monday/trigger.js`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm run --workspace=src/backend test`
Expected: PASS — the whole backend suite, including the 5 new trigger tests.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/backend/monday/trigger.ts src/backend/routes/projects.ts src/backend/routes/monday.ts src/backend/test/monday-trigger.test.ts
git commit -m "feat(monday): roll-up write trigger with column-deleted self-disable"
```

---

## Final verification

- [ ] **Run the full suite**

```bash
npm run --workspace=src/backend test && npm run --workspace=src/frontend test && npm run typecheck
```

Expected: all pass.

- [ ] **Verify the migration against a copy of the live DB**

The backend runs under `tsx watch` and re-runs migrations on the live DB, so a bad migration takes it down. Test on a copy first:

```bash
cp ~/.nexus/nexus.db /tmp/nexus-migration-check.db
```

Then point a throwaway backend run at the copy and confirm it boots and that `monday_items` and `task_monday_links` exist.

- [ ] **End-to-end check with a real board**

With `MONDAY_TOKEN` set and `monday.enabled: true`:

1. Configure a project's scope, roll-up column, and updates opt-in in Settings.
2. Open Project Management, click Refresh — items appear grouped by Monday group.
3. Link a task, confirm the badge appears on its Kanban card.
4. Move that task to Deploy, confirm the roll-up column changes in Monday and a `monday_write` operation appears in the Activity Console.
5. Open the task's chat and confirm the agent can answer "what initiative does this task belong to?" without a tool call — that proves context injection is live.
6. Temporarily point the project at a non-existent roll-up column id, move a task, and confirm roll-up self-disables with exactly one notification.
