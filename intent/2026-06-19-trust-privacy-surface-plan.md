# Trust and Privacy Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an accurate Trust & Privacy Settings surface and README section, with safe controls to rebuild the disposable memory index and permanently clear only `nexus`-namespace memory.

**Architecture:** The memory daemon remains the only vault/index writer and exposes serialized maintenance operations. The backend adds a dedicated, read-only trust snapshot and proxies maintenance calls; the frontend renders the snapshot separately from mutable settings. No API response contains credential values.

**Tech Stack:** TypeScript, Fastify 5, better-sqlite3/sqlite-vec, React 19, Vitest/Testing Library, Node test runner, Markdown.

## Global Constraints

- `Clear Nexus memory` deletes canonical files only where the indexed namespace is exactly `nexus`; every other namespace and unrelated vault file is preserved.
- Clearing requires the exact phrase `CLEAR NEXUS MEMORY` at both backend and daemon boundaries.
- Rebuilding preserves canonical Markdown and forcibly regenerates derived FTS, chunk, vector, and knowledge-graph state.
- Only one daemon maintenance operation runs at a time; overlap returns HTTP `409`.
- Trust APIs expose paths, status, and source labels but never raw secrets, token fields, file contents, or authorization headers.
- Do not claim third-party providers collect no telemetry; state only that Nexus has no application analytics/telemetry integration.
- Do not add dependencies or a standalone About view.

---

### Task 1: Forced reindex and Nexus-only clear domain operations

**Files:**
- Modify: `src/memory-daemon/src/sync/ingest.ts`
- Modify: `src/memory-daemon/src/sync/reindex.ts`
- Create: `src/memory-daemon/src/maintenance.ts`
- Create: `src/memory-daemon/test/maintenance.test.ts`

**Interfaces:**
- Produces: `ingestFile(ctx, filePath, { force?: boolean })`.
- Produces: `reindexAll(ctx, { force?: boolean }) -> Promise<ReindexStats>` where stats adds `reindexed` and `queued`.
- Produces: `clearNexusMemory(ctx) -> ClearNexusResult`.

- [ ] **Step 1: Write failing domain tests**

Create fixture helpers in `maintenance.test.ts` using `mkdtempSync`, `openDb`, a stub `ModelClient`, and `storeMemory`. Assert:

```ts
test('forced rebuild preserves markdown and refreshes unchanged memory', async () => {
  const before = readFileSync(nexusPath, 'utf8');
  const stats = await reindexAll(ctx, { force: true });
  assert.equal(readFileSync(nexusPath, 'utf8'), before);
  assert.equal(stats.reindexed, 1);
  assert.ok(stats.queued >= 1);
});

test('clear removes only nexus canonical memory', async () => {
  const result = clearNexusMemory(ctx);
  assert.equal(result.deleted, 1);
  assert.equal(existsSync(nexusPath), false);
  assert.equal(existsSync(globalPath), true);
  assert.equal(existsSync(unrelatedPath), true);
  assert.equal(liveCount(ctx, 'nexus'), 0);
  assert.equal(liveCount(ctx, 'global'), 1);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd src/memory-daemon && npx tsx --test --test-name-pattern='forced rebuild|clear removes' test/maintenance.test.ts`

Expected: FAIL because `maintenance.ts`, force options, and new stats do not exist.

- [ ] **Step 3: Add force-aware ingestion**

Change the signature and unchanged-content guard:

```ts
export async function ingestFile(
  ctx: AppContext,
  filePath: string,
  options: { force?: boolean } = {},
): Promise<IngestResult | null> {
  // existing read/parse logic
  if (!options.force && existing && existing.content_hash === hash && existing.deleted_at === null) {
    return { id, action: 'noop' };
  }
  // existing upsert + buildSegments + embedPending + enqueue
}
```

Keep the action as `update` for forced existing rows so all existing cleanup/build behavior is reused.

- [ ] **Step 4: Extend full reindex stats**

Implement:

```ts
export interface ReindexStats {
  scanned: number;
  inserted: number;
  updated: number;
  noop: number;
  removed: number;
  reindexed: number;
  queued: number;
}

export async function reindexAll(
  ctx: AppContext,
  options: { force?: boolean } = {},
): Promise<ReindexStats> {
  // walk as today; call ingestFile(ctx, file, options)
  // increment reindexed when options.force && action !== 'insert'
  // calculate queued from PENDING jobs before/after the scan
  // retain stale-file reconciliation and oplog entry
}
```

- [ ] **Step 5: Implement namespace-scoped clearing**

In `maintenance.ts`:

```ts
export interface ClearNexusFailure { path: string; error: string }
export interface ClearNexusResult {
  namespace: 'nexus';
  deleted: number;
  failed: number;
  paths: string[];
  failures: ClearNexusFailure[];
}

export function clearNexusMemory(ctx: AppContext): ClearNexusResult {
  const rows = ctx.db.prepare(
    "SELECT file_path FROM memories WHERE namespace = 'nexus' AND deleted_at IS NULL ORDER BY file_path",
  ).all() as Array<{ file_path: string }>;
  // For each row: unlinkSync, then removeFile. Report relative(ctx.cfg.vaultPath, file_path).
  // On unlink failure, retain the live row and add a safe error containing no absolute path.
}
```

Do not accept a namespace argument. After successful unlink, use existing `removeFile` so FTS/vectors/chunks/sentences are removed consistently.

- [ ] **Step 6: Run domain tests**

Run: `cd src/memory-daemon && npx tsx --test --test-name-pattern='forced rebuild|clear removes' test/maintenance.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/memory-daemon/src/sync/ingest.ts src/memory-daemon/src/sync/reindex.ts src/memory-daemon/src/maintenance.ts src/memory-daemon/test/maintenance.test.ts
git commit -m "feat(memory): add rebuild and scoped clear operations"
```

### Task 2: Serialized daemon maintenance HTTP surface

**Files:**
- Create: `src/memory-daemon/src/routes/operations.ts`
- Modify: `src/memory-daemon/src/server.ts`
- Modify: `src/memory-daemon/src/client.ts`
- Modify: `src/memory-daemon/test/maintenance.test.ts`

**Interfaces:**
- Consumes: `reindexAll(ctx, { force: true })`, `clearNexusMemory(ctx)`.
- Produces: `POST /operations/rebuild-index`, `POST /operations/clear-nexus`.
- Produces: `OperationDependencies` injection for deterministic route tests.
- Produces: `MemoryClient.rebuildIndex()` and `MemoryClient.clearNexusMemory(confirmation)`.

- [ ] **Step 1: Add failing route tests**

```ts
test('maintenance routes validate confirmation and reject overlap', async () => {
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const blocked = new Promise<ReindexStats>((resolve) => {
    release = () => resolve({ scanned: 0, inserted: 0, updated: 0, noop: 0, removed: 0, reindexed: 0, queued: 0 });
  });
  const app = buildServer(ctx, {
    rebuild: async () => { markStarted(); return blocked; },
    clearNexus: () => ({ namespace: 'nexus', deleted: 0, failed: 0, paths: [], failures: [] }),
    reconcile: () => reindexAll(ctx),
  });
  const bad = await app.inject({ method: 'POST', url: '/operations/clear-nexus', payload: { confirmation: 'wrong' } });
  assert.equal(bad.statusCode, 400);

  const first = app.inject({ method: 'POST', url: '/operations/rebuild-index' });
  await started;
  const conflict = await app.inject({ method: 'POST', url: '/operations/rebuild-index' });
  assert.equal(conflict.statusCode, 409);
  release();
  assert.equal((await first).statusCode, 200);
});
```

Also test successful clear returns relative paths and successful rebuild returns stats.

- [ ] **Step 2: Verify route tests fail**

Run: `cd src/memory-daemon && npx tsx --test --test-name-pattern='maintenance routes' test/maintenance.test.ts`

Expected: FAIL with route `404`.

- [ ] **Step 3: Implement a per-server maintenance gate and routes**

```ts
export interface OperationDependencies {
  rebuild: () => Promise<ReindexStats>;
  clearNexus: () => ClearNexusResult;
  reconcile: () => Promise<ReindexStats>;
}

export function registerOperationRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  dependencies: OperationDependencies = {
    rebuild: () => reindexAll(ctx, { force: true }),
    clearNexus: () => clearNexusMemory(ctx),
    reconcile: () => reindexAll(ctx),
  },
): void {
  let running: 'rebuild' | 'clear' | null = null;
  const runExclusive = async <T>(name: 'rebuild' | 'clear', work: () => Promise<T> | T, reply: FastifyReply) => {
    if (running) return reply.code(409).send({ error: `Memory maintenance already running: ${running}` });
    running = name;
    try { return await work(); } finally { running = null; }
  };

  app.post('/operations/rebuild-index', (_req, reply) =>
    runExclusive('rebuild', dependencies.rebuild, reply));
  app.post('/operations/clear-nexus', (req, reply) => {
    if ((req.body as { confirmation?: string })?.confirmation !== 'CLEAR NEXUS MEMORY') {
      return reply.code(400).send({ error: 'Exact confirmation phrase required' });
    }
    return runExclusive('clear', async () => {
      const result = dependencies.clearNexus();
      const reconciliation = await dependencies.reconcile();
      return { ...result, reconciliation, ok: result.failed === 0 };
    }, reply);
  });
}
```

Allow `buildServer(ctx, operationDependencies?)` to pass the optional dependencies to `registerOperationRoutes`; production continues to call `buildServer(ctx)`.

- [ ] **Step 4: Add typed client methods**

```ts
rebuildIndex(): Promise<ReindexStats> {
  return this.req('POST', '/operations/rebuild-index');
}

clearNexusMemory(confirmation: string): Promise<ClearNexusResult> {
  return this.req('POST', '/operations/clear-nexus', { confirmation });
}
```

- [ ] **Step 5: Run daemon tests and typecheck**

Run: `npm --prefix src/memory-daemon test && npm --prefix src/memory-daemon run typecheck`

Expected: all tests PASS; TypeScript exits `0`.

- [ ] **Step 6: Commit**

```bash
git add src/memory-daemon/src/routes/operations.ts src/memory-daemon/src/server.ts src/memory-daemon/src/client.ts src/memory-daemon/test/maintenance.test.ts
git commit -m "feat(memory): expose safe maintenance endpoints"
```

### Task 3: Read-only backend trust snapshot and maintenance proxy

**Files:**
- Create: `src/backend/trust/snapshot.ts`
- Create: `src/backend/routes/trust.ts`
- Create: `src/backend/test/routes-trust.test.ts`
- Modify: `src/backend/memory/client.ts`
- Modify: `src/backend/github/token.ts`
- Modify: `src/backend/test/github-token.test.ts`
- Modify: `src/backend/index.ts`

**Interfaces:**
- Produces: `TrustSnapshot`, `buildTrustSnapshot(config, pi, dependencies)`.
- Produces: `resolveGitHubTokenStatus() -> { configured: boolean; source: 'environment' | 'gh-cli' | 'absent' }` without returning the token.
- Produces: `GET /api/trust`, `POST /api/trust/memory/rebuild`, `POST /api/trust/memory/clear-nexus`.

- [ ] **Step 1: Write failing trust-route tests**

Create a Fastify fixture with a temporary `PiRuntime`, register the route, and inject a fake daemon client. Cover:

```ts
test('trust snapshot labels sources without serializing secrets', async () => {
  process.env.JIRA_TOKEN = 'jira-secret';
  process.env.GITHUB_TOKEN = 'github-secret';
  const response = await app.inject({ method: 'GET', url: '/api/trust' });
  const serialized = response.body;
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().secrets.jira.source, 'environment');
  assert.equal(serialized.includes('jira-secret'), false);
  assert.equal(serialized.includes('github-secret'), false);
});

test('clear proxy requires exact confirmation', async () => {
  const response = await app.inject({ method: 'POST', url: '/api/trust/memory/clear-nexus', payload: { confirmation: 'wrong' } });
  assert.equal(response.statusCode, 400);
});
```

Also cover config env reference vs literal labels, Pi auth file/type status, GitHub CLI fallback, `503` daemon failure, and `409` passthrough.

- [ ] **Step 2: Verify backend tests fail**

Run: `cd src/backend && npx tsx --test --test-name-pattern='trust snapshot|clear proxy' test/routes-trust.test.ts`

Expected: FAIL because trust modules/routes do not exist.

- [ ] **Step 3: Implement snapshot types and pure source classification**

First extend the existing GitHub resolver without duplicating its precedence logic:

```ts
export async function resolveGitHubTokenStatus(runGh: GhRunner = defaultRunGh): Promise<{
  configured: boolean;
  source: 'environment' | 'gh-cli' | 'absent';
}> {
  if (typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.length > 0) {
    return { configured: true, source: 'environment' };
  }
  const token = await resolveViaGhCached(runGh);
  return token
    ? { configured: true, source: 'gh-cli' }
    : { configured: false, source: 'absent' };
}
```

Refactor `resolveGitHubToken` to use the same cached helper. Extend `github-token.test.ts` to prove env precedence, CLI fallback, and absent status without asserting or returning a raw token from the status function.

Then implement the snapshot types and classifiers.

Use explicit fields rather than returning config fragments:

```ts
export type SecretSource = 'environment' | 'config-env-reference' | 'config-literal' | 'pi-auth-file' | 'gh-cli' | 'absent' | 'unknown';
export interface TrustSecret { configured: boolean; source: SecretSource; location?: string; credentialType?: 'api_key' | 'oauth' }
export interface TrustSnapshot {
  services: Array<{ name: string; url: string; loopback: boolean }>;
  storage: Array<{ name: string; path: string; role: 'canonical' | 'rebuildable' | 'application' | 'credentials' | 'configuration' }>;
  secrets: Record<string, TrustSecret>;
  memory: { namespaces: string[]; autoInject: { enabled: boolean; maxMemories: number; tokenBudget: number }; archive: { mode: 'manual'; destination: string; removesHotThreadAfterSuccess: true } };
  outbound: Array<{ name: string; destination: string; sends: string[]; enabled: boolean }>;
  telemetry: { applicationTelemetry: false; statement: string };
}
```

`buildTrustSnapshot` reads only config strings, `process.env` presence, `pi.auth.list()/get()`, `pi.paths.authFile`, and injected GitHub source metadata. Never spread config or credential objects into the response.

- [ ] **Step 4: Extend the backend daemon client with status-aware errors**

```ts
export class DaemonRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

rebuildIndex() { return req<ReindexStats>('POST', '/operations/rebuild-index'); },
clearNexusMemory(confirmation: string) {
  return req<ClearNexusResult>('POST', '/operations/clear-nexus', { confirmation });
},
```

Update `req` to throw `DaemonRequestError(res.status, safeMessage)` so the route can preserve `400`/`409` and map connection failures to `503`.

- [ ] **Step 5: Add and register backend routes**

```ts
fastify.get('/api/trust', async () => buildTrustSnapshot(loadConfig(), fastify.pi, dependencies));
fastify.post('/api/trust/memory/rebuild', async (_request, reply) => proxy(reply, () => daemon.rebuildIndex()));
fastify.post('/api/trust/memory/clear-nexus', async (request, reply) => {
  const confirmation = (request.body as { confirmation?: string })?.confirmation;
  if (confirmation !== 'CLEAR NEXUS MEMORY') return reply.code(400).send({ error: 'Exact confirmation phrase required' });
  return proxy(reply, () => daemon.clearNexusMemory(confirmation));
});
```

Register `registerTrustRoutes` in `src/backend/index.ts`.

- [ ] **Step 6: Run backend tests and typecheck**

Run: `cd src/backend && npx tsx --test --test-name-pattern='trust snapshot|trust route|clear proxy' test/routes-trust.test.ts && npm run typecheck`

Expected: focused tests PASS; TypeScript exits `0`.

- [ ] **Step 7: Commit**

```bash
git add src/backend/trust/snapshot.ts src/backend/routes/trust.ts src/backend/test/routes-trust.test.ts src/backend/memory/client.ts src/backend/github/token.ts src/backend/test/github-token.test.ts src/backend/index.ts
git commit -m "feat: add trust snapshot and memory maintenance proxy"
```

### Task 4: Trust & Privacy Settings UI

**Files:**
- Modify: `src/frontend/src/api.ts`
- Create: `src/frontend/src/components/TrustPrivacySection.tsx`
- Create: `src/frontend/src/components/TrustPrivacySection.test.tsx`
- Modify: `src/frontend/src/components/SettingsPage.tsx`
- Modify: `src/frontend/src/components/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: backend `TrustSnapshot` and maintenance routes.
- Produces: `api.trust.get()`, `api.trust.rebuildMemory()`, `api.trust.clearNexusMemory(confirmation)`.

- [ ] **Step 1: Write failing component tests**

Mock `api.trust` and assert:

```tsx
it('renders boundaries without displaying secret values', async () => {
  render(<TrustPrivacySection />);
  expect(await screen.findByText('No application telemetry')).toBeInTheDocument();
  expect(screen.getByText('~/.nexus/auth.json')).toBeInTheDocument();
  expect(screen.queryByText('raw-secret')).not.toBeInTheDocument();
});

it('requires exact confirmation before clear', async () => {
  render(<TrustPrivacySection />);
  const clear = await screen.findByRole('button', { name: 'Clear Nexus memory' });
  expect(clear).toBeDisabled();
  await userEvent.type(screen.getByLabelText('Confirmation phrase'), 'CLEAR NEXUS MEMORY');
  expect(clear).toBeEnabled();
  await userEvent.click(clear);
  expect(api.trust.clearNexusMemory).toHaveBeenCalledWith('CLEAR NEXUS MEMORY');
});
```

Cover loading, partial-unavailable/error, rebuild success/failure, disabling both buttons during operations, and refresh/reset after clear.

- [ ] **Step 2: Verify frontend tests fail**

Run: `npm test --workspace=src/frontend -- TrustPrivacySection.test.tsx`

Expected: FAIL because the component and API methods do not exist.

- [ ] **Step 3: Add typed API methods**

Mirror the backend response type in `api.ts` and add:

```ts
trust: {
  get: () => fetchJson<TrustSnapshot>('/api/trust'),
  rebuildMemory: () => fetchJson<ReindexResult>('/api/trust/memory/rebuild', { method: 'POST' }),
  clearNexusMemory: (confirmation: string) => fetchJson<ClearNexusResult>('/api/trust/memory/clear-nexus', {
    method: 'POST', body: JSON.stringify({ confirmation }),
  }),
},
```

- [ ] **Step 4: Implement the focused component**

`TrustPrivacySection` owns its own snapshot/loading/error/operation/confirmation state. Render compact subsections titled `Local services`, `Storage`, `Secrets`, `Memory boundaries`, `Data sent to providers`, and `Telemetry`. Status copy must say `No application telemetry` and explain that configured providers receive required requests.

Use this exact clear guard:

```tsx
const CLEAR_PHRASE = 'CLEAR NEXUS MEMORY';
const canClear = confirmation === CLEAR_PHRASE && operation === null;
```

After either successful operation, call `load()` again. After clear, also call `setConfirmation('')`.

- [ ] **Step 5: Mount it separately from mutable settings**

Add `<TrustPrivacySection />` after the GitHub section inside `SettingsPage`; do not place trust data inside `config`, `update()`, or the Save Changes payload. Extend the Settings test mock with `api.trust` and assert the Trust & Privacy heading renders.

- [ ] **Step 6: Run frontend tests and typecheck**

Run: `npm test --workspace=src/frontend -- TrustPrivacySection.test.tsx SettingsPage.test.tsx && npm run --workspace=src/frontend typecheck`

Expected: all selected tests PASS; TypeScript exits `0`.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/api.ts src/frontend/src/components/TrustPrivacySection.tsx src/frontend/src/components/TrustPrivacySection.test.tsx src/frontend/src/components/SettingsPage.tsx src/frontend/src/components/SettingsPage.test.tsx
git commit -m "feat(settings): add trust and privacy surface"
```

### Task 5: Accurate README trust model

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: final API/UI terminology and actual config defaults from Tasks 1–4.
- Produces: user-facing trust documentation.

- [ ] **Step 1: Add the Trust and privacy section and TOC entry**

Document these exact facts:

```markdown
## Trust and privacy

Nexus has no application analytics or telemetry integration. It runs the backend and memory services on loopback by default. Configured model, assistant, Jira, and GitHub providers still receive the request content required to perform their service.

| Data | Location | Role |
|---|---|---|
| Projects, tasks, hot chat sessions, tickets | `~/.nexus/nexus.db` | Local application state |
| Memories and archived sessions | configured Obsidian vault | Canonical Markdown |
| Memory search/vector/KG data | `<vault>/.index/nexus-memory.db` | Disposable, rebuildable index |
| Pi API keys and OAuth credentials | `~/.nexus/auth.json` | Local credential store |
| Nexus configuration | `~/.nexus/config.yaml` | May contain env references or literal keys entered in Settings |
```

Include default ports `4173`, `5173` (development only), `4100`, and `4001`–`4003`; secret-source details; outbound payload categories; namespaces; auto-injection; manual archival; disable; rebuild; and Nexus-only clear semantics. Correct the stale automatic 48-hour archival claim: current archive actions summarize into `nexus` memory and delete the hot thread only after storage succeeds.

- [ ] **Step 2: Correct contradictory secret text**

Replace the sentence claiming secrets are never written to config with accurate copy: env interpolation is preferred, but literal OpenRouter/local-model/assistant keys entered in Settings are masked on read and persist in `config.yaml`; Pi credentials persist in `auth.json`; Jira and GitHub use their documented environment/CLI sources.

- [ ] **Step 3: Verify documentation consistency**

Run: `rg -n "never (stored|written)|telemetry|auth.json|Trust and privacy|CLEAR NEXUS MEMORY|4001|4002|4003|4100|4173|5173" README.md`

Expected: one coherent trust section; no remaining blanket claim that all secrets are never persisted.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document Nexus trust and privacy model"
```

### Task 6: Full verification and acceptance audit

**Files:**
- Modify only files required to fix failures introduced by Tasks 1–5.

**Interfaces:**
- Consumes all prior deliverables.
- Produces a release-ready, evidence-backed implementation.

- [ ] **Step 1: Run all relevant test suites**

Run:

```bash
npm --prefix src/memory-daemon test
npm test --workspace=src/backend
npm test --workspace=src/frontend
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run all typechecks and build**

Run:

```bash
npm run typecheck
npm --prefix src/memory-daemon run typecheck
npm run build
```

Expected: every command exits `0`.

- [ ] **Step 3: Audit secret non-disclosure and git hygiene**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: no whitespace errors; only intended feature files are changed; the user's pre-existing untracked diff-review spec/plan remain untouched.

- [ ] **Step 4: Manually verify acceptance behavior**

Start Nexus, open Settings → Trust & Privacy, and confirm:

- effective paths/ports and credential source labels render without values;
- rebuild preserves a sampled Nexus Markdown file and refreshes counts;
- wrong clear text keeps the button disabled;
- exact clear confirmation deletes Nexus namespace memory only;
- a sampled non-Nexus memory and unrelated vault Markdown survive;
- provider and telemetry copy matches README.

- [ ] **Step 5: Resolve any verification failure at its owning task**

If a command or manual check fails, return to the task that introduced that behavior, add a regression test demonstrating the failure, implement the focused fix, rerun that task's focused checks, and repeat Steps 1–4. Do not create a catch-all verification commit.
