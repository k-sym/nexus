# Hermes Remote Session Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show filtered Hermes API sessions in the Assistant left rail and let a user click a remote session to adopt it into Nexus and resume the conversation.

**Architecture:** Keep Nexus local-first. `assistant_sessions` remains the UI index and source for Nexus-owned transcripts, while Hermes `GET /api/sessions` is used only to discover filtered remote sessions that can be adopted. Clicking a remote-only row imports metadata and messages into local tables, stores `remote_session_id`, and future sends use the existing `session.remote_session_id ?? session.id` path.

**Tech Stack:** Fastify, better-sqlite3, TypeScript, React 19, Vitest, Node test runner, Hermes REST API.

## Global Constraints

- This plan is versioned in `intent/`; the spec and other documentation live in Dropbox `project_docs/` (git-ignored, never staged); do not create root `docs/`.
- Do not expose Assistant API keys or raw bearer tokens in frontend responses.
- Do not list Hermes cron/jobs in the Assistant rail; `/api/jobs` remains separate and out of scope.
- Do not replace the local Assistant session list with an unfiltered remote list.
- The Assistant rail stays dense and operational, matching the current Nexus dark UI.
- Remote-only rows must use stable keys and visible disabled/error states.
- If Hermes listing is unavailable, keep rendering local Nexus sessions and surface a non-blocking sync error only where useful.

---

## File Structure

- Modify `src/backend/hermes/client.ts`: add typed session-list and message-history methods.
- Modify `src/backend/test/hermes-client.test.ts`: cover `GET /api/sessions` and `GET /api/sessions/:id/messages` URL/query/header behavior.
- Modify `src/backend/routes/assistant.ts`: merge local sessions with filtered Hermes sessions and add an import/adopt route.
- Modify `src/backend/test/routes-assistant.test.ts`: cover filtering, local/remote merge, import, message persistence, and resume sends.
- Modify `src/frontend/src/hooks/useAssistantStream.ts`: represent remote-only sessions and import them before loading.
- Modify `src/frontend/src/components/AssistantView.tsx`: render remote-only rows in the same rail with a compact marker and loading/error states.
- Modify `src/frontend/src/components/AssistantView.test.tsx`: cover remote rows, click-to-adopt, and send-after-adopt.
- Modify `README.md`: document that the Assistant rail can include filtered adoptable Hermes API sessions.
- Modify `project_docs/specs/2026-07-01-hermes-assistant-sessions.md`: add built notes and testing instructions for remote adoption.

## Task 1: Hermes Session Listing Client

**Files:**
- Modify: `src/backend/hermes/client.ts`
- Modify: `src/backend/test/hermes-client.test.ts`

**Interfaces:**
- Produces:
  - `HermesListedSession`
  - `HermesSessionMessage`
  - `HermesClient.listSessions(input?: HermesListSessionsInput): Promise<HermesListSessionsResult>`
  - `HermesClient.getSessionMessages(sessionId: string): Promise<HermesSessionMessage[]>`

- [ ] Add failing tests to `src/backend/test/hermes-client.test.ts`.

```ts
test('listSessions calls Hermes sessions API with source filtering', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: HermesFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      sessions: [
        { id: 'remote-api-1', title: 'API run', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
      ],
      next_offset: null,
    });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642/v1', key: 'secret', fetchImpl });
  const result = await client.listSessions({ limit: 50, offset: 0, source: 'api_server', includeChildren: false });

  assert.equal(calls[0].url, 'http://127.0.0.1:8642/api/sessions?limit=50&offset=0&source=api_server&include_children=false');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.deepEqual(result.sessions, [
    { id: 'remote-api-1', title: 'API run', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
  ]);
  assert.equal(result.nextOffset, null);
});

test('getSessionMessages maps Hermes message history', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8642/api/sessions/remote-api-1/messages');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    return jsonResponse({
      messages: [
        { id: 'hm1', role: 'user', content: 'resume this', created_at: '2026-07-02T10:01:00.000Z' },
        { id: 'hm2', role: 'assistant', content: 'ready', created_at: '2026-07-02T10:02:00.000Z' },
      ],
    });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  assert.deepEqual(await client.getSessionMessages('remote-api-1'), [
    { id: 'hm1', role: 'user', content: 'resume this', created_at: '2026-07-02T10:01:00.000Z' },
    { id: 'hm2', role: 'assistant', content: 'ready', created_at: '2026-07-02T10:02:00.000Z' },
  ]);
});
```

- [ ] Run the focused Hermes client tests and confirm they fail because the methods do not exist.

```bash
npm run --workspace=src/backend test -- test/hermes-client.test.ts
```

Expected: TypeScript compile failure for `listSessions` and `getSessionMessages`.

- [ ] Add the client types and methods.

```ts
export interface HermesListSessionsInput {
  limit?: number;
  offset?: number;
  source?: string;
  includeChildren?: boolean;
}

export interface HermesListedSession {
  id: string;
  title?: string;
  source?: string;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  end_reason?: string | null;
}

export interface HermesListSessionsResult {
  sessions: HermesListedSession[];
  nextOffset: number | null;
}

export interface HermesSessionMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at?: string;
}
```

Implementation details:
- Build query strings with `URLSearchParams`.
- Always send bearer auth through the existing `requestJson` helper.
- Accept both `next_offset` and `nextOffset`.
- Accept both `{ sessions: [...] }` and bare array responses to tolerate Hermes patch-level differences.

- [ ] Re-run the focused tests.

```bash
npm run --workspace=src/backend test -- test/hermes-client.test.ts
```

Expected: all `hermes-client.test.ts` tests pass.

## Task 2: Backend Merge and Adopt Routes

**Files:**
- Modify: `src/backend/routes/assistant.ts`
- Modify: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/assistant/sessions` returns local sessions plus remote-only Hermes sessions with `remoteOnly: true`.
  - `POST /api/assistant/sessions/import` with `{ remoteSessionId: string }` creates or updates a local session and imports messages.

- [ ] Add a route test that remote API sessions are shown but cron/job-like sessions are filtered out.

```ts
test('Assistant session list includes filtered remote Hermes API sessions only', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).includes('/api/sessions?')) {
      assert.match(String(url), /source=api_server/);
      return new Response(JSON.stringify({
        sessions: [
          { id: 'remote-api-1', title: 'Remote API session', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
          { id: 'remote-cron-1', title: 'Cron work', source: 'cron', updated_at: '2026-07-02T09:00:00.000Z' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.equal(list.statusCode, 200);
    assert.deepEqual(list.json().sessions.map((session: any) => ({
      id: session.id,
      title: session.title,
      remoteOnly: session.remoteOnly,
      remote_session_id: session.remote_session_id,
    })), [
      {
        id: 'remote:remote-api-1',
        title: 'Remote API session',
        remoteOnly: true,
        remote_session_id: 'remote-api-1',
      },
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] Add a route test that a remote session already mapped locally is not duplicated.

```ts
test('Assistant session list merges remote sessions that already have local rows', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    if (String(url).includes('/api/sessions?')) {
      return new Response(JSON.stringify({
        sessions: [{ id: 'remote-api-1', title: 'Remote title', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    db.prepare(
      `INSERT INTO assistant_sessions (id, title, remote_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?)`,
    ).run('local-1', 'Local title', 'remote-api-1', '2026-07-02T08:00:00.000Z', '2026-07-02T08:00:00.000Z');

    const list = await app.inject({ method: 'GET', url: '/api/assistant/sessions' });
    assert.deepEqual(list.json().sessions.map((session: any) => session.id), ['local-1']);
    assert.equal(list.json().sessions[0].remoteOnly, false);
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] Add an import route test.

```ts
test('Assistant import route adopts a remote Hermes session and imports messages', async () => {
  const fetchImpl: HermesFetch = async (url) => {
    const requestUrl = String(url);
    if (requestUrl.endsWith('/api/sessions/remote-api-1')) {
      return new Response(JSON.stringify({
        session: { id: 'remote-api-1', title: 'Remote API session', source: 'api_server', updated_at: '2026-07-02T10:00:00.000Z' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (requestUrl.endsWith('/api/sessions/remote-api-1/messages')) {
      return new Response(JSON.stringify({
        messages: [
          { id: 'hm1', role: 'user', content: 'continue this', created_at: '2026-07-02T10:01:00.000Z' },
          { id: 'hm2', role: 'assistant', content: 'I can continue.', created_at: '2026-07-02T10:02:00.000Z' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected Hermes request ${requestUrl}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    const imported = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/import',
      payload: { remoteSessionId: 'remote-api-1' },
    });
    assert.equal(imported.statusCode, 200);
    assert.equal(imported.json().session.remote_session_id, 'remote-api-1');
    assert.deepEqual(imported.json().messages.map((message: any) => [message.role, message.content]), [
      ['user', 'continue this'],
      ['assistant', 'I can continue.'],
    ]);
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] Implement backend helpers inside `assistant.ts`.

```ts
const HERMES_ASSISTANT_SOURCE = 'api_server';

function remoteSyntheticId(remoteSessionId: string): string {
  return `remote:${remoteSessionId}`;
}

function publicRemoteSession(remote: HermesListedSession) {
  return {
    id: remoteSyntheticId(remote.id),
    title: remote.title?.trim() || 'Remote Hermes Session',
    remote_session_id: remote.id,
    status: 'remote',
    remoteOnly: true,
    source: remote.source ?? null,
    created_at: remote.created_at,
    updated_at: remote.updated_at,
    archived_at: null,
    latestRun: null,
  };
}
```

Implementation details:
- `GET /api/assistant/sessions` should fetch local sessions first.
- If Assistant config is missing or Hermes list fails, return local sessions as before.
- Call `hermes.listSessions({ limit: 100, offset: 0, source: HERMES_ASSISTANT_SOURCE, includeChildren: false })`.
- Filter the returned remote list again in Nexus: accept only `remote.source === undefined || remote.source === 'api_server'`; reject `cron`, `job`, `scheduled`, `cli`, and `dashboard`.
- Exclude remote IDs that already match a local `id` or `remote_session_id`.
- Sort merged rows by `updated_at` descending, preserving local `latestRun`.
- `POST /api/assistant/sessions/import` should upsert by `remote_session_id`, import messages with `INSERT OR IGNORE`, and return the same payload shape as `GET /api/assistant/sessions/:id`.

- [ ] Re-run the focused Assistant route tests.

```bash
npm run --workspace=src/backend test -- test/routes-assistant.test.ts
```

Expected: all `routes-assistant.test.ts` tests pass.

## Task 3: Resume Sends Through Adopted Remote Sessions

**Files:**
- Modify: `src/backend/routes/assistant.ts`
- Modify: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- Consumes: imported local session with `remote_session_id`.
- Produces: future foreground/background sends use the remote Hermes session ID.

- [ ] Add a regression test proving sends use the adopted remote ID.

```ts
test('Assistant foreground send resumes an adopted remote Hermes session', async () => {
  let runBody: any = null;
  const fetchImpl: HermesFetch = async (url, init) => {
    if (String(url).endsWith('/v1/runs') && init?.method === 'POST') {
      runBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ run_id: 'remote-run-resume', status: 'started' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/v1/runs/remote-run-resume')) {
      return new Response(JSON.stringify({ run_id: 'remote-run-resume', status: 'completed', output: 'resumed' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected Hermes request ${String(url)}`);
  };
  const { app, db, dir } = makeApp({ fetchImpl });
  try {
    db.prepare(
      `INSERT INTO assistant_sessions (id, title, remote_session_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'idle', ?, ?)`,
    ).run('local-adopted', 'Adopted', 'remote-api-1', '2026-07-02T08:00:00.000Z', '2026-07-02T08:00:00.000Z');

    const response = await app.inject({
      method: 'POST',
      url: '/api/assistant/sessions/local-adopted/messages/stream',
      payload: { content: 'keep going' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(runBody.session_id, 'remote-api-1');
  } finally {
    await cleanup(app, db, dir);
  }
});
```

- [ ] Verify the current `streamSessionTurn` and background-run path already use `session.remote_session_id ?? session.id`. If the test fails, keep the implementation scoped to preserving that expression.

```ts
sessionId: session.remote_session_id ?? session.id,
sessionKey: `nexus:assistant:${session.id}`,
```

- [ ] Re-run the route tests.

```bash
npm run --workspace=src/backend test -- test/routes-assistant.test.ts
```

Expected: the resume regression passes.

## Task 4: Frontend Hook Adoption Flow

**Files:**
- Modify: `src/frontend/src/hooks/useAssistantStream.ts`
- Modify: `src/frontend/src/components/AssistantView.test.tsx`

**Interfaces:**
- Produces:
  - `AssistantSession.remoteOnly?: boolean`
  - `AssistantSession.source?: string | null`
  - `loadSession(sessionId)` imports remote-only IDs before loading local detail.

- [ ] Add frontend tests for remote rows and click-to-adopt.

```ts
it('renders remote Hermes sessions in the Assistant rail and imports on click', async () => {
  apiFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/assistant/sessions') {
      return { ok: true, json: async () => ({ sessions: [
        { id: 'remote:remote-api-1', title: 'Remote API session', status: 'remote', remoteOnly: true, remote_session_id: 'remote-api-1', updated_at: '2026-07-02T10:00:00.000Z' },
      ] }) } as Response;
    }
    if (url === '/api/assistant/sessions/import') {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ remoteSessionId: 'remote-api-1' });
      return { ok: true, json: async () => ({
        session: { id: 'local-imported', title: 'Remote API session', status: 'idle', remote_session_id: 'remote-api-1' },
        messages: [{ id: 'm1', role: 'assistant', content: 'imported transcript', created_at: '2026-07-02T10:02:00.000Z' }],
        latestRun: null,
      }) } as Response;
    }
    if (url === '/api/assistant/sessions/local-imported') {
      return { ok: true, json: async () => ({
        session: { id: 'local-imported', title: 'Remote API session', status: 'idle', remote_session_id: 'remote-api-1' },
        messages: [{ id: 'm1', role: 'assistant', content: 'imported transcript', created_at: '2026-07-02T10:02:00.000Z' }],
        latestRun: null,
      }) } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  });

  render(<AssistantView />);

  fireEvent.click(await screen.findByRole('button', { name: /Remote API session/i }));
  expect(await screen.findByText('imported transcript')).toBeInTheDocument();
});
```

- [ ] Extend `AssistantSession`.

```ts
export interface AssistantSession {
  id: string;
  title: string;
  status: AssistantSessionStatus;
  remote_session_id?: string | null;
  remote_conversation_key?: string | null;
  last_run_id?: string | null;
  created_at?: string;
  updated_at?: string;
  archived_at?: string | null;
  latestRun?: AssistantRun | null;
  remoteOnly?: boolean;
  source?: string | null;
}
```

- [ ] Add an import helper in `useAssistantStream`.

```ts
const importRemoteSession = useCallback(async (session: AssistantSession): Promise<boolean> => {
  const remoteSessionId = session.remote_session_id ?? session.id.replace(/^remote:/, '');
  const res = await apiFetch('/api/assistant/sessions/import', {
    method: 'POST',
    body: JSON.stringify({ remoteSessionId }),
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    setError(await responseError(res));
    return false;
  }
  const data = (await res.json()) as {
    session: AssistantSession;
    messages?: AssistantMessage[];
    latestRun?: AssistantRun | null;
  };
  const run = data.latestRun ?? null;
  setSelectedSessionId(data.session.id);
  setMessages(data.messages ?? []);
  setLatestRun(run);
  setIsRunning(isActiveRunStatus(run?.status));
  setSessions((current) => [
    { ...data.session, remoteOnly: false, latestRun: run },
    ...current.filter((item) => item.id !== session.id && item.id !== data.session.id),
  ]);
  return true;
}, []);
```

- [ ] Update `loadSession` so remote-only rows call `importRemoteSession`.

```ts
const remoteCandidate = sessions.find((session) => session.id === sessionId && session.remoteOnly);
if (remoteCandidate) return importRemoteSession(remoteCandidate);
```

Implementation detail: avoid stale `sessions` closure problems by keeping `sessionsRef.current = sessions` in an effect, then looking up remote candidates from the ref.

- [ ] Run the focused frontend tests.

```bash
npm run --workspace=src/frontend test -- AssistantView.test.tsx
```

Expected: all `AssistantView` tests pass.

## Task 5: Assistant Rail UI States

**Files:**
- Modify: `src/frontend/src/components/AssistantView.tsx`
- Modify: `src/frontend/src/components/AssistantView.test.tsx`

**Interfaces:**
- Consumes: `AssistantSession.remoteOnly`.
- Produces: compact remote marker and import-in-progress feedback without changing the main layout.

- [ ] Add a UI test for the remote marker.

```ts
it('marks remote-only Hermes sessions without changing local session controls', async () => {
  apiFetchMock.mockImplementation(async (url: string) => {
    if (url === '/api/assistant/sessions') {
      return { ok: true, json: async () => ({ sessions: [
        { id: 'remote:remote-api-1', title: 'Remote API session', status: 'remote', remoteOnly: true, remote_session_id: 'remote-api-1' },
      ] }) } as Response;
    }
    return { ok: true, json: async () => ({ session: null, messages: [], latestRun: null }) } as Response;
  });

  render(<AssistantView />);

  const row = await screen.findByRole('button', { name: /Remote API session/i });
  expect(within(row).getByText('Remote')).toBeInTheDocument();
});
```

- [ ] Update `SessionRow`.

```tsx
function SessionRow({ session, selected, onSelect }: { session: AssistantSession; selected: boolean; onSelect: () => void }) {
  const active = session.status === 'running' || session.latestRun?.status === 'running';
  return (
    <button type="button" onClick={onSelect} className={...}>
      <div className="flex items-center gap-2 min-w-0">
        <span className={`h-2 w-2 rounded-full shrink-0 ${active ? 'bg-emerald-400' : 'bg-[var(--border-strong)]'}`} aria-hidden="true" />
        <span className="text-sm font-medium truncate">{session.title}</span>
        {session.remoteOnly && (
          <span className="ml-auto rounded border border-subtle px-1.5 py-0.5 text-[10px] uppercase text-faint">
            Remote
          </span>
        )}
      </div>
      {session.updated_at && <div className="text-[11px] text-faint mt-1 truncate">{relativeUpdatedAt(session.updated_at)}</div>}
    </button>
  );
}
```

UI details:
- Do not add a second sidebar or modal for remote discovery.
- Keep the marker small; the session title remains the first scan target.
- Keep icon-only header controls unchanged.
- If import fails, show the existing `error` alert and leave the remote row in the rail.

- [ ] Run the focused frontend tests.

```bash
npm run --workspace=src/frontend test -- AssistantView.test.tsx
```

Expected: all `AssistantView` tests pass.

## Task 6: Docs and Verification

**Files:**
- Modify: `README.md`
- Modify: `project_docs/specs/2026-07-01-hermes-assistant-sessions.md`

**Interfaces:**
- Produces clear built notes for the testing agent.

- [ ] Update the README Assistant section with one sentence:

```md
When Hermes exposes session listing, the Assistant rail can also show filtered remote API sessions; selecting one adopts it into Nexus, imports message history, and resumes future turns against the mapped Hermes `remote_session_id`.
```

- [ ] Update the existing Hermes Assistant Sessions design doc built notes with:

```md
- Added filtered Hermes remote session discovery using `GET /api/sessions?source=api_server`, merging remote-only rows into the Assistant rail without listing `/api/jobs` scheduled work.
- Added click-to-adopt behavior for remote-only sessions: Nexus creates or reuses a local `assistant_sessions` row, stores `remote_session_id`, imports Hermes messages, and resumes future runs against the remote session.

Testing agent should verify:
- Local sessions still render when Hermes session listing is unavailable.
- Remote-only API sessions appear once, with no duplicates for sessions already mapped locally.
- Cron/job/dashboard sessions do not appear in the Assistant rail.
- Clicking a remote-only row imports its transcript and subsequent sends use the Hermes session ID.
```

- [ ] Run backend, frontend, and typecheck verification.

```bash
npm run --workspace=src/backend test -- test/hermes-client.test.ts test/routes-assistant.test.ts
npm run --workspace=src/frontend test -- AssistantView.test.tsx
npm run typecheck
```

Expected:
- Backend focused tests pass.
- Frontend focused tests pass.
- Typecheck passes.

- [ ] Inspect git status.

```bash
git status --short
```

Expected:
- Only files from this plan are modified, plus any pre-existing unrelated local changes remain untouched.

## Self-Review

- Spec coverage: the plan covers Hermes listing, filtering, merge, adoption, resume sends, Assistant rail UI, docs, and verification.
- Scope control: scheduled jobs and a full Hermes dashboard are explicitly out of scope.
- Type consistency: `remoteOnly`, `remote_session_id`, `HermesListedSession`, and `HermesSessionMessage` are used consistently across backend and frontend tasks.
- UX consistency: the plan keeps the current two-pane Assistant surface, stable list keys, compact markers, and existing alert path.
