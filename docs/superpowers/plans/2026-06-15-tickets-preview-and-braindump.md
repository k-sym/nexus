# Tickets preview pane + Braindump view — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cleaned, readable content-preview pane to the Tickets view (fetching the Jira body lazily on selection), and add a new Braindump view that captures free-form ideas and triages them into projects with the same mechanic Tickets uses.

**Architecture:** Backend gains a pure `cleanAdf()` util (ADF → readable plain text, images stripped, forwarded headers + footers trimmed), two new `tickets` columns to cache the raw ADF, a lazy `GET /api/tickets/:key/description` route, and a `braindump_ideas` table with CRUD routes. Frontend re-arranges `TicketsView` into list + detail + full-width preview strip, extracts the triage control into a shared `TriageToProject` component, adds `BraindumpView`, and registers a new `'braindump'` global view.

**Tech Stack:** TypeScript, Fastify, better-sqlite3, React 18 + Tailwind, Phosphor icons. Backend tests: `node:test` via `tsx --test` (files in `src/backend/test/`). Frontend tests: vitest + Testing Library (colocated `*.test.tsx`).

**Note on a spec refinement:** the design doc said the preview renders "markdown". During planning we confirmed the frontend has **no** markdown renderer and renders all rich text as plain `whitespace-pre-wrap` (chat messages, memory). To match house style and avoid a new dependency, the cleaning pipeline emits **readable plain text** (paragraphs separated by blank lines, list items as `• …`) rendered with `whitespace-pre-wrap`. Everything else in the spec is unchanged.

---

## File structure

Backend:
- `src/backend/tickets/cleanAdf.ts` — NEW. Pure ADF→text + boilerplate-trim util.
- `src/backend/jira/client.ts` — MODIFY. Add `fetchJiraIssueDescription()`.
- `src/backend/routes/tickets.ts` — MODIFY. Add `GET /api/tickets/:key/description`.
- `src/backend/routes/braindump.ts` — NEW. CRUD for ideas.
- `src/backend/db.ts` — MODIFY. `tickets` columns + `braindump_ideas` table.
- `src/backend/index.ts` — MODIFY. Register braindump routes.
- `src/backend/config.ts` — READ ONLY (used by the description route via `loadConfig`).

Shared:
- `src/shared/index.ts` — MODIFY. Add `TicketDescription`, `BraindumpIdea` types.

Frontend:
- `src/frontend/src/api.ts` — MODIFY. `tickets.description()`, `braindump.*`.
- `src/frontend/src/components/TriageToProject.tsx` — NEW. Shared triage control.
- `src/frontend/src/components/TicketsView.tsx` — MODIFY. Three-pane + preview strip; use `TriageToProject`.
- `src/frontend/src/components/BraindumpView.tsx` — NEW.
- `src/frontend/src/components/TopBar.tsx` — MODIFY. Braindump nav button.
- `src/frontend/src/App.tsx` — MODIFY. `'braindump'` view, render case, command, handlers.

Tests:
- `src/backend/test/clean-adf.test.ts` — NEW.
- `src/backend/test/braindump-routes.test.ts` — NEW (integration, `app.inject`).
- `src/backend/test/tickets-description-route.test.ts` — NEW (integration, `app.inject`).
- `src/frontend/src/components/TriageToProject.test.tsx` — NEW.
- `src/frontend/src/components/BraindumpView.test.tsx` — NEW.

---

## Task 1: Shared types

**Files:**
- Modify: `src/shared/index.ts` (after the `Ticket` interface, ~line 59)

- [ ] **Step 1: Add the new types**

Add directly after the `Ticket` interface (after line 59):

```typescript
/** Cleaned, display-ready body of a Jira ticket, fetched lazily on selection. */
export interface TicketDescription {
  key: string;
  /** Readable plain text: paragraphs separated by blank lines, list items as "• …". Empty string when the ticket has no description. */
  body: string;
  /** Sections pulled out of the body and offered behind a "show more" fold. */
  trimmed: { kind: 'forwarded' | 'footer'; text: string }[];
  /** ISO timestamp the body was last fetched from Jira; null if never fetched. */
  fetchedAt: string | null;
  /** True when Jira returned no description content for this ticket. */
  empty: boolean;
}

/** A free-form idea captured in the Braindump view before it becomes a project task. */
export interface BraindumpIdea {
  id: string;
  title: string;
  body: string;
  status: 'active' | 'triaged';
  /** Set when triaged into a project. */
  project_id: string | null;
  /** The task created on triage. */
  task_id: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/shared build`
Expected: PASS (compiles, emits dist).

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add TicketDescription and BraindumpIdea types"
```

---

## Task 2: ADF → text (`adfToText`), images stripped

**Files:**
- Create: `src/backend/tickets/cleanAdf.ts`
- Test: `src/backend/test/clean-adf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/clean-adf.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adfToText } from '../tickets/cleanAdf';

test('adfToText renders paragraphs separated by blank lines', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello there.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Second para.' }] },
    ],
  };
  assert.equal(adfToText(doc), 'Hello there.\n\nSecond para.');
});

test('adfToText drops all media/image nodes', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x', type: 'file' } }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Real content.' }] },
      { type: 'mediaInline', attrs: { id: 'y' } },
    ],
  };
  assert.equal(adfToText(doc), 'Real content.');
});

test('adfToText renders bullet list items with bullets', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ],
    }],
  };
  assert.equal(adfToText(doc), '• one\n• two');
});

test('adfToText keeps link text, falling back to href when text is empty', () => {
  const doc = {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'the docs', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
        { type: 'text', text: ' or ' },
        { type: 'text', text: '', marks: [{ type: 'link', attrs: { href: 'https://bare.test' } }] },
      ],
    }],
  };
  assert.equal(adfToText(doc), 'See the docs or https://bare.test');
});

test('adfToText returns empty string for null/empty docs', () => {
  assert.equal(adfToText(null), '');
  assert.equal(adfToText({ type: 'doc', content: [] }), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: FAIL — `Cannot find module '../tickets/cleanAdf'`.

- [ ] **Step 3: Implement `adfToText`**

Create `src/backend/tickets/cleanAdf.ts`:

```typescript
/**
 * Turn a Jira ADF (Atlassian Document Format) description into readable plain
 * text for the Tickets preview pane. Images/media are dropped entirely (Jira
 * stays canonical — the user can "Open in Jira" for the rare ticket where a
 * screenshot matters). The frontend renders the result with `whitespace-pre-wrap`.
 *
 * Raw ADF is cached in the DB, so these rules can be revised later (e.g. keep
 * attachment-sized images) without re-fetching from Jira.
 */

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

const MEDIA_TYPES = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);

/** Render inline content (text nodes with marks) of a block node to a string. */
function renderInline(nodes: AdfNode[] | undefined): string {
  if (!nodes) return '';
  let out = '';
  for (const node of nodes) {
    if (MEDIA_TYPES.has(node.type)) continue;
    if (node.type === 'hardBreak') { out += '\n'; continue; }
    if (node.type === 'text') {
      const link = node.marks?.find((m) => m.type === 'link');
      if (link) {
        const href = String((link.attrs as { href?: string } | undefined)?.href ?? '');
        out += node.text && node.text.length > 0 ? node.text : href;
      } else {
        out += node.text ?? '';
      }
      continue;
    }
    // Unknown inline node: fall back to its nested text.
    out += renderInline(node.content);
  }
  return out;
}

/** Render a list (bullet or ordered), one line per item prefixed with a marker. */
function renderList(node: AdfNode, ordered: boolean): string {
  const items = node.content ?? [];
  return items
    .map((item, i) => {
      const marker = ordered ? `${i + 1}. ` : '• ';
      // A listItem's children are usually a single paragraph; flatten them.
      const text = (item.content ?? []).map(renderBlock).filter(Boolean).join(' ');
      return marker + text;
    })
    .join('\n');
}

/** Render a single block node to text (no trailing separator). */
function renderBlock(node: AdfNode): string {
  if (MEDIA_TYPES.has(node.type)) return '';
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return renderInline(node.content);
    case 'blockquote':
    case 'panel':
      return (node.content ?? []).map(renderBlock).filter(Boolean).join('\n');
    case 'bulletList':
      return renderList(node, false);
    case 'orderedList':
      return renderList(node, true);
    case 'codeBlock':
      return renderInline(node.content);
    case 'rule':
      return '';
    case 'table': {
      const rows = node.content ?? [];
      return rows
        .map((row) => (row.content ?? []).map((cell) => renderInline(cell.content)).join('  '))
        .join('\n');
    }
    default:
      return node.content ? (node.content).map(renderBlock).filter(Boolean).join('\n') : (node.text ?? '');
  }
}

/** Top-level: ADF doc → plain text, blocks separated by blank lines. */
export function adfToText(doc: AdfNode | null | undefined): string {
  if (!doc || !doc.content) return '';
  return doc.content
    .map(renderBlock)
    .map((s) => s.replace(/[ \t]+\n/g, '\n').trim())
    .filter((s) => s.length > 0)
    .join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/tickets/cleanAdf.ts src/backend/test/clean-adf.test.ts
git commit -m "feat(tickets): adfToText — ADF to readable text, images stripped"
```

---

## Task 3: Trim boilerplate (`trimBoilerplate`, `cleanAdf`)

**Files:**
- Modify: `src/backend/tickets/cleanAdf.ts`
- Test: `src/backend/test/clean-adf.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/backend/test/clean-adf.test.ts`:

```typescript
import { trimBoilerplate, cleanAdf } from '../tickets/cleanAdf';

test('trimBoilerplate pulls out a forwarded-header block', () => {
  const text = [
    'FYI please action this.',
    '',
    'From: AWS <no-reply@aws.test>',
    'Sent: 01 May 2026',
    'To: Support',
    'Subject: Action required',
    '',
    'The real body starts here.',
  ].join('\n');
  const result = trimBoilerplate(text);
  assert.match(result.body, /FYI please action this\./);
  assert.match(result.body, /The real body starts here\./);
  assert.doesNotMatch(result.body, /no-reply@aws\.test/);
  assert.ok(result.trimmed.some((t) => t.kind === 'forwarded' && /From: AWS/.test(t.text)));
});

test('trimBoilerplate folds a trailing signature/footer block', () => {
  const text = [
    'Here is the actual content of the ticket.',
    '',
    '--',
    'Jane Smith',
    'Follow us on LinkedIn',
    'Unsubscribe here',
  ].join('\n');
  const result = trimBoilerplate(text);
  assert.equal(result.body, 'Here is the actual content of the ticket.');
  assert.ok(result.trimmed.some((t) => t.kind === 'footer' && /Jane Smith/.test(t.text)));
});

test('trimBoilerplate leaves clean bodies untouched', () => {
  const text = 'Just a normal ticket body with no email cruft.';
  const result = trimBoilerplate(text);
  assert.equal(result.body, text);
  assert.deepEqual(result.trimmed, []);
});

test('cleanAdf composes adfToText + trimBoilerplate', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Body line.' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '--' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Unsubscribe here' }] },
    ],
  };
  const result = cleanAdf(doc);
  assert.equal(result.body, 'Body line.');
  assert.ok(result.trimmed.some((t) => t.kind === 'footer'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: FAIL — `trimBoilerplate`/`cleanAdf` not exported.

- [ ] **Step 3: Implement `trimBoilerplate` and `cleanAdf`**

Append to `src/backend/tickets/cleanAdf.ts`:

```typescript
export interface CleanedBody {
  body: string;
  trimmed: { kind: 'forwarded' | 'footer'; text: string }[];
}

const HEADER_LINE = /^(From|Sent|To|Cc|Bcc|Subject|Date|Reply-To)\s*:\s/i;
const FOOTER_DELIM = /^--\s*$/;
const FOOTER_KEYWORD = /(unsubscribe|follow us|view (this|in) (email|browser)|all rights reserved|©|privacy policy|manage (your )?preferences)/i;

/**
 * Conservative best-effort cleanup of forwarded-email cruft. Favours
 * under-trimming over eating real content.
 */
export function trimBoilerplate(text: string): CleanedBody {
  const trimmed: { kind: 'forwarded' | 'footer'; text: string }[] = [];
  let lines = text.split('\n');

  // 1) Forwarded-header blocks: a run of lines (blanks allowed between) where
  //    at least two lines match the header pattern. Pull the whole run out.
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADER_LINE.test(lines[i])) {
      let j = i;
      const block: string[] = [];
      let headerCount = 0;
      while (j < lines.length && (HEADER_LINE.test(lines[j]) || lines[j].trim() === '')) {
        if (HEADER_LINE.test(lines[j])) headerCount++;
        block.push(lines[j]);
        j++;
      }
      if (headerCount >= 2) {
        trimmed.push({ kind: 'forwarded', text: block.join('\n').trim() });
        i = j - 1;
        continue;
      }
    }
    kept.push(lines[i]);
  }
  lines = kept;

  // 2) Footer block: from the first signature delimiter / footer keyword to the
  //    end — but only if there's real body above it (index > 0).
  let footerStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (FOOTER_DELIM.test(lines[i]) || FOOTER_KEYWORD.test(lines[i])) {
      if (i > 0) { footerStart = i; break; }
    }
  }
  if (footerStart >= 0) {
    const footer = lines.slice(footerStart).join('\n').trim();
    if (footer.length > 0) trimmed.push({ kind: 'footer', text: footer });
    lines = lines.slice(0, footerStart);
  }

  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { body, trimmed };
}

/** Fetch-to-display pipeline: raw ADF → cleaned, trimmed plain text. */
export function cleanAdf(doc: AdfNode | null | undefined): CleanedBody {
  return trimBoilerplate(adfToText(doc));
}
```

- [ ] **Step 4: Run all clean-adf tests**

Run: `cd src/backend && npx tsx --test test/clean-adf.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/tickets/cleanAdf.ts src/backend/test/clean-adf.test.ts
git commit -m "feat(tickets): trimBoilerplate — fold forwarded headers and footers"
```

---

## Task 4: DB migrations (tickets columns + braindump_ideas table)

**Files:**
- Modify: `src/backend/db.ts`
- Test: `src/backend/test/db.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/backend/test/db.test.ts` (it already imports `getDb`; if the helper `freshDb` isn't present, use the inline form below):

```typescript
test('migrations add ticket description columns', () => {
  const base = join(tmpdir(), `nexus-dbmig-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  const cols = (db.pragma('table_info(tickets)') as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('description_adf'));
  assert.ok(cols.includes('description_fetched_at'));
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
});

test('migrations create braindump_ideas table', () => {
  const base = join(tmpdir(), `nexus-dbmig2-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = getDb(base);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='braindump_ideas'").get();
  assert.ok(row, 'braindump_ideas table should exist');
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
});
```

(If `db.test.ts` lacks the imports, add at the top: `import { tmpdir } from 'os'; import { join } from 'path'; import fs from 'fs';`)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/db.test.ts`
Expected: FAIL — columns/table missing.

- [ ] **Step 3: Add the table to the CREATE block**

In `src/backend/db.ts`, inside the big `db.exec(\`…\`)` block, add after the `tickets` table definition (after line 122, before `notifications`):

```sql
    CREATE TABLE IF NOT EXISTS braindump_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      project_id TEXT,
      task_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
```

And add an index alongside the other `CREATE INDEX` lines (near line 140):

```sql
    CREATE INDEX IF NOT EXISTS idx_braindump_status ON braindump_ideas(status);
```

- [ ] **Step 4: Add the guarded ALTER for ticket columns**

In `src/backend/db.ts`, near the other guarded migrations (e.g. after the `chat_messages` attachments migration, ~line 149), add:

```typescript
  const ticketCols = db.pragma('table_info(tickets)') as { name: string }[];
  if (!ticketCols.some((c) => c.name === 'description_adf')) {
    db.exec('ALTER TABLE tickets ADD COLUMN description_adf TEXT');
  }
  if (!ticketCols.some((c) => c.name === 'description_fetched_at')) {
    db.exec('ALTER TABLE tickets ADD COLUMN description_fetched_at TEXT');
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backend/db.ts src/backend/test/db.test.ts
git commit -m "feat(db): ticket description columns + braindump_ideas table"
```

---

## Task 5: Jira client — fetch a single issue's description

**Files:**
- Modify: `src/backend/jira/client.ts`
- Test: `src/backend/test/clean-adf.test.ts` is unrelated; add a small unit test file `src/backend/test/jira-description.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/jira-description.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJiraIssueDescription } from '../jira/client';

test('fetchJiraIssueDescription requests the description field and returns raw ADF', async () => {
  let calledUrl = '';
  const fakeFetch = (async (url: string) => {
    calledUrl = String(url);
    return {
      ok: true,
      json: async () => ({ fields: { description: { type: 'doc', content: [] } } }),
    } as Response;
  }) as unknown as typeof fetch;

  const adf = await fetchJiraIssueDescription(
    { user: 'me@x.test', instance: 'acme.atlassian.net', project: 'SUP' },
    'token',
    'SUP-42',
    fakeFetch,
  );
  assert.match(calledUrl, /\/rest\/api\/3\/issue\/SUP-42\?fields=description/);
  assert.deepEqual(adf, { type: 'doc', content: [] });
});

test('fetchJiraIssueDescription returns null when Jira omits the field', async () => {
  const fakeFetch = (async () => ({ ok: true, json: async () => ({ fields: {} }) } as Response)) as unknown as typeof fetch;
  const adf = await fetchJiraIssueDescription(
    { user: 'me@x.test', instance: 'acme.atlassian.net', project: 'SUP' }, 'token', 'SUP-1', fakeFetch,
  );
  assert.equal(adf, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/jira-description.test.ts`
Expected: FAIL — `fetchJiraIssueDescription` not exported.

- [ ] **Step 3: Implement the helper**

Append to `src/backend/jira/client.ts` (after `fetchJiraTickets`):

```typescript
/**
 * Fetch a single issue's description (raw ADF). Returns null when the issue has
 * no description. `fetchImpl` is injectable for tests.
 */
export async function fetchJiraIssueDescription(
  cfg: JiraQueryConfig,
  token: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown | null> {
  const instance = normalizeInstance(cfg.instance);
  const url = `https://${instance}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`;
  const auth = Buffer.from(`${cfg.user}:${token}`).toString('base64');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Basic ${auth}`, accept: 'application/json' },
    });
  } catch (err) {
    throw new JiraError(`Jira request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).trim().replace(/\s+/g, ' ').slice(0, 300);
    throw new JiraError(`Jira ${cfg.instance} -> HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`, res.status, snippet || undefined);
  }
  const json = (await res.json()) as { fields?: { description?: unknown } };
  return json.fields?.description ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/jira-description.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/jira/client.ts src/backend/test/jira-description.test.ts
git commit -m "feat(jira): fetchJiraIssueDescription for a single issue"
```

---

## Task 6: `GET /api/tickets/:key/description` route (lazy fetch + cache)

**Files:**
- Modify: `src/backend/routes/tickets.ts`
- Test: `src/backend/test/tickets-description-route.test.ts`

Behaviour:
- If the ticket row has cached `description_adf` and `?refresh` is absent → clean and return the cache (no Jira call).
- If no cache (or `?refresh=1`) → if Jira is configured + `JIRA_TOKEN` set, fetch the ADF, store it + timestamp, return cleaned. If Jira is not configured → return `{ empty: true, body: '' }` rather than erroring.
- 404 if the ticket key is unknown.

- [ ] **Step 1: Write the failing test (cache-hit + unknown-key paths)**

Create `src/backend/test/tickets-description-route.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerTicketRoutes } from '../routes/tickets';

function appWithDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-desc-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerTicketRoutes);
  return { app, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('GET description returns cleaned text from cached ADF without calling Jira', async () => {
  const { app, db, cleanup } = appWithDb();
  const adf = JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cached body.' }] }],
  });
  db.prepare("INSERT INTO tickets (key, summary, synced_at, description_adf, description_fetched_at) VALUES (?, ?, ?, ?, ?)")
    .run('SUP-9', 'sum', new Date().toISOString(), adf, '2026-06-15T00:00:00.000Z');

  const res = await app.inject({ method: 'GET', url: '/api/tickets/SUP-9/description' });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.key, 'SUP-9');
  assert.equal(json.body, 'Cached body.');
  assert.equal(json.empty, false);
  await app.close();
  cleanup();
});

test('GET description 404s for an unknown ticket', async () => {
  const { app, cleanup } = appWithDb();
  const res = await app.inject({ method: 'GET', url: '/api/tickets/NOPE-1/description' });
  assert.equal(res.statusCode, 404);
  await app.close();
  cleanup();
});

test('GET description returns empty (not error) when no cache and Jira is unconfigured', async () => {
  const { app, db, cleanup } = appWithDb();
  db.prepare("INSERT INTO tickets (key, summary, synced_at) VALUES (?, ?, ?)")
    .run('SUP-5', 'sum', new Date().toISOString());
  const res = await app.inject({ method: 'GET', url: '/api/tickets/SUP-5/description' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().empty, true);
  await app.close();
  cleanup();
});
```

> The third test depends on Jira being unconfigured in the test environment. `loadConfig()` defaults `jira.enabled` to false, and `JIRA_TOKEN` is unset under test, so the route takes the "unconfigured" branch. Do not set those env vars in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/tickets-description-route.test.ts`
Expected: FAIL — route returns 404 for `/SUP-9/description` (route not defined).

- [ ] **Step 3: Implement the route**

In `src/backend/routes/tickets.ts`, update the imports and add the route. Replace the file's import block top with:

```typescript
import { FastifyInstance } from 'fastify';
import { syncTickets, type IncomingTicket } from '../tickets/sync.js';
import { cleanAdf, type AdfNode } from '../tickets/cleanAdf.js';
import { fetchJiraIssueDescription } from '../jira/client.js';
import { loadConfig } from '../config.js';
```

Then add inside `registerTicketRoutes`, after the existing `GET /api/tickets` handler:

```typescript
  fastify.get('/api/tickets/:key/description', async (request, reply) => {
    const { key } = request.params as { key: string };
    const refresh = (request.query as { refresh?: string }).refresh != null;

    const row = db.prepare('SELECT key, description_adf, description_fetched_at FROM tickets WHERE key = ?')
      .get(key) as { key: string; description_adf: string | null; description_fetched_at: string | null } | undefined;
    if (!row) {
      const err = new Error('Ticket not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const respond = (adfJson: string | null, fetchedAt: string | null) => {
      if (!adfJson) return { key, body: '', trimmed: [], fetchedAt, empty: true };
      let adf: AdfNode | null = null;
      try { adf = JSON.parse(adfJson) as AdfNode; } catch { adf = null; }
      const cleaned = cleanAdf(adf);
      return { key, body: cleaned.body, trimmed: cleaned.trimmed, fetchedAt, empty: cleaned.body.length === 0 };
    };

    if (row.description_adf && !refresh) {
      return respond(row.description_adf, row.description_fetched_at);
    }

    const config = loadConfig();
    const token = process.env.JIRA_TOKEN;
    if (!config.jira.enabled || !config.jira.user || !config.jira.instance || !token) {
      // Not configured to fetch — return cache if any, else empty.
      return respond(row.description_adf, row.description_fetched_at);
    }

    try {
      const adf = await fetchJiraIssueDescription(
        { user: config.jira.user, instance: config.jira.instance, project: config.jira.project },
        token,
        key,
      );
      const adfJson = adf ? JSON.stringify(adf) : null;
      const fetchedAt = new Date().toISOString();
      db.prepare('UPDATE tickets SET description_adf = ?, description_fetched_at = ? WHERE key = ?')
        .run(adfJson, fetchedAt, key);
      return respond(adfJson, fetchedAt);
    } catch (err) {
      reply.status(502);
      return { key, body: '', trimmed: [], fetchedAt: row.description_fetched_at, empty: true, error: (err as Error).message };
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/tickets-description-route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/tickets.ts src/backend/test/tickets-description-route.test.ts
git commit -m "feat(tickets): GET /api/tickets/:key/description (lazy fetch + cache)"
```

---

## Task 7: Braindump CRUD routes

**Files:**
- Create: `src/backend/routes/braindump.ts`
- Modify: `src/backend/index.ts`
- Test: `src/backend/test/braindump-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/braindump-routes.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getDb } from '../db';
import { registerBraindumpRoutes } from '../routes/braindump';

function appWithDb() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-brain-'));
  const db = getDb(join(dir, 'test.db'));
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.register(registerBraindumpRoutes);
  return { app, db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('create, list, edit, and triage-removal of ideas', async () => {
  const { app, cleanup } = appWithDb();

  const created = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: 'Idea one' } });
  assert.equal(created.statusCode, 200);
  const id = created.json().id;
  assert.equal(created.json().status, 'active');

  const listed = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(listed.json().length, 1);

  const edited = await app.inject({ method: 'PATCH', url: `/api/braindump/${id}`, payload: { body: 'more detail' } });
  assert.equal(edited.json().body, 'more detail');

  // Triaged ideas drop out of the active list.
  await app.inject({ method: 'PATCH', url: `/api/braindump/${id}`, payload: { status: 'triaged', project_id: 'p1', task_id: 't1' } });
  const afterTriage = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(afterTriage.json().length, 0);

  await app.close();
  cleanup();
});

test('delete removes an idea', async () => {
  const { app, cleanup } = appWithDb();
  const created = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: 'Doomed' } });
  const id = created.json().id;
  const del = await app.inject({ method: 'DELETE', url: `/api/braindump/${id}` });
  assert.equal(del.statusCode, 200);
  const listed = await app.inject({ method: 'GET', url: '/api/braindump' });
  assert.equal(listed.json().length, 0);
  await app.close();
  cleanup();
});

test('POST rejects an empty title', async () => {
  const { app, cleanup } = appWithDb();
  const res = await app.inject({ method: 'POST', url: '/api/braindump', payload: { title: '   ' } });
  assert.equal(res.statusCode, 400);
  await app.close();
  cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && npx tsx --test test/braindump-routes.test.ts`
Expected: FAIL — `Cannot find module '../routes/braindump'`.

- [ ] **Step 3: Implement the routes**

Create `src/backend/routes/braindump.ts`:

```typescript
/**
 * Braindump — free-form ideas captured before they become project tasks.
 * Mirrors the Tickets triage mechanic: an idea is triaged into a project
 * (creating a Kanban task via the existing projects route), then the idea is
 * PATCHed to status='triaged' and drops out of the active list. Triaged rows
 * are retained (not deleted) so a future "triaged history" stays possible.
 */
import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { BraindumpIdea } from '@nexus/shared';

export async function registerBraindumpRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/braindump', async () => {
    return db.prepare("SELECT * FROM braindump_ideas WHERE status = 'active' ORDER BY datetime(created_at) DESC").all() as BraindumpIdea[];
  });

  fastify.post('/api/braindump', async (request) => {
    const body = request.body as { title?: string; body?: string };
    const title = (body.title ?? '').trim();
    if (!title) {
      const err = new Error('title is required') as any;
      err.statusCode = 400;
      throw err;
    }
    const now = new Date().toISOString();
    const idea: BraindumpIdea = {
      id: uuid(),
      title,
      body: body.body ?? '',
      status: 'active',
      project_id: null,
      task_id: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare('INSERT INTO braindump_ideas (id, title, body, status, project_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(idea.id, idea.title, idea.body, idea.status, idea.project_id, idea.task_id, idea.created_at, idea.updated_at);
    return idea;
  });

  fastify.patch('/api/braindump/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; body?: string; status?: 'active' | 'triaged'; project_id?: string; task_id?: string };

    const existing = db.prepare('SELECT * FROM braindump_ideas WHERE id = ?').get(id) as BraindumpIdea | undefined;
    if (!existing) {
      const err = new Error('Idea not found') as any;
      err.statusCode = 404;
      throw err;
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE braindump_ideas SET title = COALESCE(?, title), body = COALESCE(?, body), status = COALESCE(?, status), project_id = COALESCE(?, project_id), task_id = COALESCE(?, task_id), updated_at = ? WHERE id = ?')
      .run(body.title ?? null, body.body ?? null, body.status ?? null, body.project_id ?? null, body.task_id ?? null, now, id);
    return db.prepare('SELECT * FROM braindump_ideas WHERE id = ?').get(id) as BraindumpIdea;
  });

  fastify.delete('/api/braindump/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM braindump_ideas WHERE id = ?').run(id);
    return { success: true };
  });
}
```

- [ ] **Step 4: Register the routes**

In `src/backend/index.ts`, add the import alongside the other route imports (after line 21):

```typescript
import { registerBraindumpRoutes } from './routes/braindump.js';
```

And register it alongside the others (after `app.register(registerTicketRoutes);`, line 70):

```typescript
  app.register(registerBraindumpRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd src/backend && npx tsx --test test/braindump-routes.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/backend/routes/braindump.ts src/backend/index.ts src/backend/test/braindump-routes.test.ts
git commit -m "feat(braindump): CRUD routes for ideas"
```

---

## Task 8: Frontend API client methods

**Files:**
- Modify: `src/frontend/src/api.ts`

- [ ] **Step 1: Add imports and methods**

In `src/frontend/src/api.ts`, extend the shared import (line 8):

```typescript
import { Project, Task, ChatThread, Ticket, TicketDescription, BraindumpIdea } from '@nexus/shared';
```

Replace the `tickets` block (lines 119-121) with:

```typescript
  tickets: {
    list: () => fetchJson<Ticket[]>(`/api/tickets`),
    description: (key: string, refresh = false) =>
      fetchJson<TicketDescription>(`/api/tickets/${encodeURIComponent(key)}/description${refresh ? '?refresh=1' : ''}`),
  },
  braindump: {
    list: () => fetchJson<BraindumpIdea[]>(`/api/braindump`),
    create: (data: { title: string; body?: string }) =>
      fetchJson<BraindumpIdea>(`/api/braindump`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Pick<BraindumpIdea, 'title' | 'body' | 'status' | 'project_id' | 'task_id'>>) =>
      fetchJson<BraindumpIdea>(`/api/braindump/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => fetchJson<void>(`/api/braindump/${id}`, { method: 'DELETE' }),
  },
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/api.ts
git commit -m "feat(frontend): api client for ticket description + braindump"
```

---

## Task 9: Extract `TriageToProject` shared component

**Files:**
- Create: `src/frontend/src/components/TriageToProject.tsx`
- Test: `src/frontend/src/components/TriageToProject.test.tsx`

This is the project-dropdown + "Create task" + feedback control, currently inline in `TicketsView`. It takes the project list and an `onCreate(projectId)` callback; the caller decides what the task becomes and what happens after.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/components/TriageToProject.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TriageToProject from './TriageToProject';
import type { Project } from '@nexus/shared';

const projects = [
  { id: 'p1', name: 'Alpha' },
  { id: 'p2', name: 'Beta' },
] as Project[];

describe('TriageToProject', () => {
  it('prompts to create a project when none exist', () => {
    render(<TriageToProject projects={[]} onCreate={vi.fn()} />);
    expect(screen.getByText(/create a project first/i)).toBeInTheDocument();
  });

  it('calls onCreate with the selected project and shows success', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<TriageToProject projects={projects} onCreate={onCreate} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p2' } });
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('p2'));
    expect(await screen.findByText(/created in beta/i)).toBeInTheDocument();
  });

  it('shows an error message when onCreate rejects', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('boom'));
    render(<TriageToProject projects={projects} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));
    expect(await screen.findByText(/failed to create task/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/frontend test -- TriageToProject`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/frontend/src/components/TriageToProject.tsx`:

```tsx
import { useState, useEffect } from 'react';
import { Project } from '@nexus/shared';

interface TriageToProjectProps {
  projects: Project[];
  /** Create a task in the chosen project; resolves when done. */
  onCreate: (projectId: string) => Promise<void>;
  /** Reset the success/error message — bump this key when the selected source item changes. */
  resetKey?: string;
}

export default function TriageToProject({ projects, onCreate, resetKey }: TriageToProjectProps) {
  const [targetProject, setTargetProject] = useState<string>('');
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!targetProject && projects.length > 0) setTargetProject(projects[0].id);
  }, [projects, targetProject]);

  useEffect(() => { setMsg(null); }, [resetKey]);

  const handleCreate = async () => {
    if (!targetProject) return;
    setCreating(true);
    setMsg(null);
    try {
      await onCreate(targetProject);
      const name = projects.find(p => p.id === targetProject)?.name ?? 'project';
      setMsg(`Created in ${name}`);
    } catch (err) {
      console.error('Failed to create task:', err);
      setMsg('Failed to create task');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="border-t border-zinc-800 pt-4 space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium">Triage → create task</div>
      {projects.length === 0 ? (
        <p className="text-xs text-zinc-600">Create a project first to triage this into a Kanban task.</p>
      ) : (
        <>
          <select
            value={targetProject}
            onChange={e => setTargetProject(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-2 py-2 text-sm text-zinc-200 focus:outline-none"
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={handleCreate}
            disabled={creating}
            className="w-full px-3 py-2 text-sm bg-indigo-500 text-ink rounded-md hover:bg-indigo-600 disabled:opacity-40 transition-colors"
          >
            {creating ? 'Creating…' : 'Create task'}
          </button>
          {msg && (
            <p className={`text-xs text-center ${msg.startsWith('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</p>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run --workspace=src/frontend test -- TriageToProject`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/TriageToProject.tsx src/frontend/src/components/TriageToProject.test.tsx
git commit -m "feat(frontend): extract shared TriageToProject control"
```

---

## Task 10: Rework `TicketsView` — three-pane + preview strip

**Files:**
- Modify: `src/frontend/src/components/TicketsView.tsx`

The list (left) + detail (right) row stays on top; a full-width preview strip is added below, with empty/loading/error/content states, a refresh icon, and "show more" folds for trimmed sections. The inline triage block is replaced with `<TriageToProject>`.

- [ ] **Step 1: Replace the component**

Replace the entire contents of `src/frontend/src/components/TicketsView.tsx` with:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Ticket as TicketIcon, ArrowClockwise, Eye } from '@phosphor-icons/react';
import { Project, Ticket, TicketDescription } from '@nexus/shared';
import { api } from '../api';
import TriageToProject from './TriageToProject';

const STATUS_ORDER = ['Waiting for support', 'In Progress', 'Waiting for customer'];

const PRIORITY_COLOR: Record<string, string> = {
  Urgent: 'text-red-400',
  High: 'text-orange-400',
  Medium: 'text-amber-400',
  Low: 'text-zinc-400',
};

function groupByStatus(tickets: Ticket[]): [string, Ticket[]][] {
  const groups = new Map<string, Ticket[]>();
  for (const t of tickets) {
    const s = t.status || 'Other';
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(t);
  }
  return [...groups.entries()].sort((a, b) => {
    const ia = STATUS_ORDER.indexOf(a[0]);
    const ib = STATUS_ORDER.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

interface TicketsViewProps {
  projects: Project[];
  onCreateTask: (projectId: string, ticket: Ticket) => Promise<void>;
}

export default function TicketsView({ projects, onCreateTask }: TicketsViewProps) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Ticket | null>(null);

  const [desc, setDesc] = useState<TicketDescription | null>(null);
  const [descLoading, setDescLoading] = useState(false);
  const [descError, setDescError] = useState(false);
  const [showTrimmed, setShowTrimmed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.tickets.list();
      setTickets(data);
      setSelected(prev => (prev ? data.find(t => t.key === prev.key) ?? null : null));
    } catch (err) {
      console.error('Failed to load tickets:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDescription = useCallback(async (key: string, refresh = false) => {
    setDescLoading(true);
    setDescError(false);
    setShowTrimmed(false);
    try {
      setDesc(await api.tickets.description(key, refresh));
    } catch (err) {
      console.error('Failed to load ticket description:', err);
      setDescError(true);
      setDesc(null);
    } finally {
      setDescLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selected) loadDescription(selected.key);
    else { setDesc(null); setDescError(false); }
  }, [selected, loadDescription]);

  const groups = groupByStatus(tickets);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top row: list + detail */}
      <div className="flex min-h-0 flex-1">
        {/* List */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 shrink-0">
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2"><TicketIcon size={22} weight="fill" /> Tickets</h1>
              <p className="text-xs text-zinc-500">Jira tickets assigned to you ({tickets.length}). Synced in; Jira stays canonical.</p>
            </div>
            <button
              onClick={load}
              className="px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-100 border border-zinc-800 rounded-md hover:border-zinc-700 transition-colors"
            >
              {loading ? 'Refreshing…' : '↻ Refresh'}
            </button>
          </header>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
            {tickets.length === 0 && (
              <div className="text-sm text-zinc-600 text-center py-10">
                No tickets synced yet. They arrive from the Jira-sync cron (POST /api/jira/sync).
              </div>
            )}
            {groups.map(([statusName, group]) => (
              <div key={statusName}>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-2">
                  {statusName} ({group.length})
                </div>
                <div className="space-y-1.5">
                  {group.map(t => (
                    <button
                      key={t.key}
                      onClick={() => setSelected(t)}
                      className={`w-full text-left bg-zinc-900 border rounded-md px-4 py-2.5 transition-colors ${
                        selected?.key === t.key ? 'border-indigo-500/60' : 'border-zinc-800 hover:border-zinc-700'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-indigo-400/80 shrink-0">{t.key}</span>
                        <span className="text-sm text-zinc-200 truncate flex-1">{t.summary}</span>
                        <span className={`text-[11px] shrink-0 ${PRIORITY_COLOR[t.priority] ?? 'text-zinc-400'}`}>{t.priority}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="w-96 border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0 overflow-y-auto">
          {selected ? (
            <div className="p-5 space-y-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-indigo-400/80">{selected.key}</span>
                  <span className="text-[11px] text-zinc-500">{selected.status}</span>
                </div>
                <h2 className="text-base font-semibold text-zinc-100 leading-snug">{selected.summary}</h2>
              </div>

              <dl className="text-xs text-zinc-400 space-y-1.5">
                <div className="flex justify-between"><dt className="text-zinc-500">Priority</dt><dd className={PRIORITY_COLOR[selected.priority] ?? ''}>{selected.priority}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Assignee</dt><dd>{selected.assignee ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Created</dt><dd>{selected.created ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-zinc-500">Updated</dt><dd>{selected.updated ?? '—'}</dd></div>
              </dl>

              {selected.url && (
                <a
                  href={selected.url}
                  target="_blank"
                  rel="noreferrer"
                  className="block text-center text-sm text-indigo-400 hover:text-indigo-300 border border-zinc-800 rounded-md py-2 transition-colors"
                >
                  Open in Jira ↗
                </a>
              )}

              <TriageToProject
                projects={projects}
                resetKey={selected.key}
                onCreate={(projectId) => onCreateTask(projectId, selected)}
              />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-sm text-zinc-600 text-center">Select a ticket to view details and triage it into a project.</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-width preview strip */}
      {selected && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 shrink-0 max-h-[45%] flex flex-col">
          <div className="flex items-center justify-between px-6 py-2 border-b border-zinc-800/60 shrink-0">
            <span className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium flex items-center gap-1.5">
              <Eye size={14} /> Content preview
            </span>
            <button
              onClick={() => loadDescription(selected.key, true)}
              title="Re-fetch from Jira"
              className="text-zinc-500 hover:text-zinc-200 transition-colors"
            >
              <ArrowClockwise size={14} className={descLoading ? 'animate-spin' : ''} />
            </button>
          </div>
          <div className="overflow-y-auto px-6 py-4 text-sm text-zinc-300 leading-relaxed">
            {descLoading && <p className="text-zinc-600">Loading…</p>}
            {!descLoading && descError && (
              <p className="text-red-400">Couldn’t load the description. <button onClick={() => loadDescription(selected.key, true)} className="underline">Retry</button></p>
            )}
            {!descLoading && !descError && desc && desc.empty && (
              <p className="text-zinc-600">No description on this ticket. Open it in Jira for full context.</p>
            )}
            {!descLoading && !descError && desc && !desc.empty && (
              <>
                <p className="whitespace-pre-wrap">{desc.body}</p>
                {desc.trimmed.length > 0 && (
                  <div className="mt-3">
                    <button
                      onClick={() => setShowTrimmed(v => !v)}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300 underline"
                    >
                      {showTrimmed ? 'Hide' : `Show ${desc.trimmed.length} trimmed section${desc.trimmed.length > 1 ? 's' : ''}`} (headers / footers)
                    </button>
                    {showTrimmed && (
                      <div className="mt-2 space-y-2 border-l-2 border-zinc-800 pl-3">
                        {desc.trimmed.map((t, i) => (
                          <p key={i} className="whitespace-pre-wrap text-xs text-zinc-500">{t.text}</p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 3: Verify existing ticket-related tests still pass**

Run: `npm run --workspace=src/frontend test -- TicketsView TriageToProject`
Expected: PASS (TriageToProject suite; no TicketsView test file yet — that's fine).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/TicketsView.tsx
git commit -m "feat(tickets): three-pane layout with cleaned content preview strip"
```

---

## Task 11: `BraindumpView` component

**Files:**
- Create: `src/frontend/src/components/BraindumpView.tsx`
- Test: `src/frontend/src/components/BraindumpView.test.tsx`

Layout mirrors Tickets: quick-add input + idea list (left), detail with editable title/body (right), full-width body preview strip, and `TriageToProject`. On successful triage the idea is PATCHed to `triaged` and removed from the list.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/components/BraindumpView.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BraindumpView from './BraindumpView';
import type { Project } from '@nexus/shared';
import { api } from '../api';

vi.mock('../api', () => ({
  api: {
    braindump: {
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

const projects = [{ id: 'p1', name: 'Alpha' }] as Project[];

beforeEach(() => {
  vi.clearAllMocks();
  (api.braindump.list as any).mockResolvedValue([]);
});

describe('BraindumpView', () => {
  it('renders the quick-add input', async () => {
    render(<BraindumpView projects={projects} onTriage={vi.fn()} />);
    expect(await screen.findByPlaceholderText(/capture an idea/i)).toBeInTheDocument();
  });

  it('creates an idea from the quick-add input', async () => {
    (api.braindump.create as any).mockResolvedValue({ id: 'i1', title: 'New idea', body: '', status: 'active', project_id: null, task_id: null, created_at: '', updated_at: '' });
    render(<BraindumpView projects={projects} onTriage={vi.fn()} />);
    const input = await screen.findByPlaceholderText(/capture an idea/i);
    fireEvent.change(input, { target: { value: 'New idea' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.braindump.create).toHaveBeenCalledWith({ title: 'New idea' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run --workspace=src/frontend test -- BraindumpView`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

Create `src/frontend/src/components/BraindumpView.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react';
import { Brain, Trash } from '@phosphor-icons/react';
import { Project, BraindumpIdea } from '@nexus/shared';
import { api } from '../api';
import TriageToProject from './TriageToProject';

interface BraindumpViewProps {
  projects: Project[];
  /** Create a task in the chosen project from an idea; resolves to the created task id. */
  onTriage: (projectId: string, idea: BraindumpIdea) => Promise<string>;
}

export default function BraindumpView({ projects, onTriage }: BraindumpViewProps) {
  const [ideas, setIdeas] = useState<BraindumpIdea[]>([]);
  const [selected, setSelected] = useState<BraindumpIdea | null>(null);
  const [draft, setDraft] = useState('');
  const [bodyDraft, setBodyDraft] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api.braindump.list();
      setIdeas(data);
      setSelected(prev => (prev ? data.find(i => i.id === prev.id) ?? null : null));
    } catch (err) {
      console.error('Failed to load ideas:', err);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setBodyDraft(selected?.body ?? ''); }, [selected]);

  const handleAdd = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft('');
    const idea = await api.braindump.create({ title });
    await load();
    setSelected(idea);
  };

  const handleSaveBody = async () => {
    if (!selected || bodyDraft === selected.body) return;
    const updated = await api.braindump.update(selected.id, { body: bodyDraft });
    setSelected(updated);
    setIdeas(prev => prev.map(i => (i.id === updated.id ? updated : i)));
  };

  const handleDelete = async (id: string) => {
    await api.braindump.delete(id);
    if (selected?.id === id) setSelected(null);
    await load();
  };

  const handleTriage = async (projectId: string) => {
    if (!selected) return;
    const taskId = await onTriage(projectId, selected);
    await api.braindump.update(selected.id, { status: 'triaged', project_id: projectId, task_id: taskId });
    setSelected(null);
    await load();
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex min-h-0 flex-1">
        {/* List + quick add */}
        <div className="flex-1 flex flex-col min-w-0">
          <header className="px-6 py-4 border-b border-zinc-800 shrink-0">
            <h1 className="text-xl font-semibold flex items-center gap-2"><Brain size={22} weight="fill" /> Braindump</h1>
            <p className="text-xs text-zinc-500">Capture ideas, then triage them into a project ({ideas.length}).</p>
          </header>

          <div className="px-6 py-3 border-b border-zinc-800/60 shrink-0">
            <input
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
              placeholder="Capture an idea and press Enter…"
              className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/60"
            />
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-1.5">
            {ideas.length === 0 && (
              <div className="text-sm text-zinc-600 text-center py-10">No ideas yet. Capture one above.</div>
            )}
            {ideas.map(idea => (
              <button
                key={idea.id}
                onClick={() => setSelected(idea)}
                className={`group w-full text-left bg-zinc-900 border rounded-md px-4 py-2.5 transition-colors ${
                  selected?.id === idea.id ? 'border-indigo-500/60' : 'border-zinc-800 hover:border-zinc-700'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm text-zinc-200 truncate flex-1">{idea.title}</span>
                  <Trash
                    size={14}
                    className="text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400"
                    onClick={(e) => { e.stopPropagation(); handleDelete(idea.id); }}
                  />
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail */}
        <div className="w-96 border-l border-zinc-800 bg-zinc-900/50 flex flex-col shrink-0 overflow-y-auto">
          {selected ? (
            <div className="p-5 space-y-4">
              <h2 className="text-base font-semibold text-zinc-100 leading-snug">{selected.title}</h2>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500/60 font-medium mb-1">Notes</div>
                <textarea
                  value={bodyDraft}
                  onChange={e => setBodyDraft(e.target.value)}
                  onBlur={handleSaveBody}
                  rows={6}
                  placeholder="Flesh out the idea…"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-indigo-500/60 resize-none"
                />
              </div>
              <TriageToProject projects={projects} resetKey={selected.id} onCreate={handleTriage} />
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-sm text-zinc-600 text-center">Select an idea to flesh it out and triage it into a project.</p>
            </div>
          )}
        </div>
      </div>

      {/* Full-width body preview */}
      {selected && (
        <div className="border-t border-zinc-800 bg-zinc-950/40 shrink-0 max-h-[40%] overflow-y-auto px-6 py-4">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500 font-medium mb-2">Preview</div>
          {bodyDraft.trim()
            ? <p className="whitespace-pre-wrap text-sm text-zinc-300 leading-relaxed">{bodyDraft}</p>
            : <p className="text-sm text-zinc-600">Add notes to see them previewed here.</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run --workspace=src/frontend test -- BraindumpView`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/BraindumpView.tsx src/frontend/src/components/BraindumpView.test.tsx
git commit -m "feat(braindump): BraindumpView with capture, edit, and triage"
```

---

## Task 12: Wire Braindump into navigation

**Files:**
- Modify: `src/frontend/src/components/TopBar.tsx`
- Modify: `src/frontend/src/App.tsx`

- [ ] **Step 1: Add the TopBar button**

In `src/frontend/src/components/TopBar.tsx`:

Update the icon import (line 1):

```tsx
import { Gauge, Ticket, Gear, Brain } from '@phosphor-icons/react';
```

Update the exported type (line 3):

```tsx
export type GlobalView = 'dashboard' | 'tickets' | 'braindump';
```

Add the button after the Tickets button (after line 39):

```tsx
      <button onClick={() => onSelectGlobal('braindump')} className={item(view === 'braindump')}><Brain size={16} weight={view === 'braindump' ? 'fill' : 'regular'} /> Braindump</button>
```

- [ ] **Step 2: Wire App.tsx — type, import, handlers, render, command**

In `src/frontend/src/App.tsx`:

(a) Add the import (after line 8):

```tsx
import BraindumpView from './components/BraindumpView';
```

(b) Extend `GlobalView` (line 20):

```tsx
type GlobalView = 'dashboard' | 'tickets' | 'braindump' | 'settings';
```

(c) Add a triage handler next to `handleCreateTaskFromTicket` (after line 326). It must return the created task id so `BraindumpView` can record it:

```tsx
  const handleTriageIdea = async (projectId: string, idea: { title: string; body: string }): Promise<string> => {
    const task = await api.projects.createTask(projectId, {
      title: idea.title,
      description: idea.body || '',
      status: 'triage',
      priority: 'medium',
    });
    if (projectId === activeProjectId) await loadTasks(projectId);
    return task.id;
  };
```

(d) Add a command-palette entry (in the `cmds` array, after the `view-tickets` line ~380):

```tsx
      { id: 'view-braindump', label: 'Braindump', hint: 'View', keywords: 'ideas capture', run: () => selectGlobal('braindump') },
```

(e) Add the render case in `renderMain` (after the tickets case, ~line 402):

```tsx
    if (globalView === 'braindump')
      return <BraindumpView projects={projects} onTriage={handleTriageIdea} />;
```

- [ ] **Step 3: Typecheck**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

> Note: `BraindumpView`'s `onTriage` prop is typed `(projectId: string, idea: BraindumpIdea) => Promise<string>`. `handleTriageIdea` accepts `{ title, body }`, which `BraindumpIdea` structurally satisfies. If the typecheck complains, widen `handleTriageIdea`'s second param to `BraindumpIdea` and import the type in `App.tsx`.

- [ ] **Step 4: Run the full frontend test suite**

Run: `npm run --workspace=src/frontend test`
Expected: PASS (all suites, including the new TriageToProject + BraindumpView).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/TopBar.tsx src/frontend/src/App.tsx
git commit -m "feat(braindump): register Braindump global view + triage handler"
```

---

## Task 13: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `cd src/backend && npm test`
Expected: PASS (all `test/*.test.ts` + `test/integration/*.test.ts`, including the 3 new suites).

- [ ] **Step 2: Frontend tests**

Run: `npm run --workspace=src/frontend test`
Expected: PASS.

- [ ] **Step 3: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS (shared + backend + frontend).

- [ ] **Step 4: Manual smoke (dev server)**

Run: `npm run dev` (or `npm run web`), then:
- Open Tickets → select a forwarded-email ticket → confirm the preview strip shows cleaned text, images gone, and "show more" reveals trimmed headers/footers. Hit the refresh icon → confirm re-fetch.
- Open Braindump → capture an idea → add notes → triage into a project → confirm the idea disappears from the list and a task appears in that project's Triage column.

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore: tickets preview + braindump verification cleanup"
```

---

## Self-review notes

- **Spec coverage:** §1a lazy fetch → Tasks 4–6; §1b cleaning → Tasks 2–3; §1c layout → Task 10; §2a data → Task 4; §2b routes → Task 7; §2c UI → Task 11; §2d nav → Task 12; shared TriageToProject → Task 9. Known-tradeoff (raw ADF retained) honoured by storing `description_adf` and cleaning at read time (Task 6).
- **Type consistency:** `TicketDescription` / `BraindumpIdea` (Task 1) are used identically in the API client (Task 8), routes (Tasks 6–7), and components (Tasks 10–11). `cleanAdf` returns `{ body, trimmed }`; the route maps that to `TicketDescription` adding `key`, `fetchedAt`, `empty`.
- **Markdown deviation:** documented at the top — plain text + `whitespace-pre-wrap`, no new dependency.
