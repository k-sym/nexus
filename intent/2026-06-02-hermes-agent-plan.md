# Hermes Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `hermes` provider kind (a remote OpenAI-compatible agent over Tailscale), unify the orchestrator's task dispatch onto `runPersona` (so Hermes — and OpenCode — work for Kanban + scheduled tasks), and auto-provision a Hermes provider + persona.

**Architecture:** `hermes` reuses the `openai_compat` HTTP dispatch but probes `/health` for status. The orchestrator stops switching on the legacy `persona.provider` enum and instead resolves `provider_id` → `Provider` via a shared `getProviderById`, then calls `runPersona` (same path chat uses). Seeds/backfills add a Hermes provider (`seed-hermes`, key via `${HERMES_API_KEY}`) and persona, gated by `user_version = 2`.

**Tech Stack:** TypeScript monorepo — `src/shared` (types), `src/backend` (Fastify + better-sqlite3), `src/frontend` (React + Vite). Tests: `node:test` via `tsx --test` (pure functions).

**Spec:** `project_docs/specs/2026-06-02-hermes-agent-design.md`

**Conventions:** This plan is versioned in `intent/`; the spec lives in Dropbox `project_docs/specs/` (git-ignored, never staged). Commit code per task; never `git add` any `dist/` (gitignored) — for shared, `git add src/shared/index.ts` only. Run commands from repo root `/Users/k-sym/Projects/nexus`. Branch for this work: `feat/hermes-agent` (create it before Task 1 if not present).

**Note on adding a union member:** adding `'hermes'` to `ProviderKind` does NOT break other files' typechecks (TS `switch` without an exhaustive `never` check tolerates extra members), so per-task backend typechecks are expected to pass throughout.

---

### Task 1: Shared types — add `hermes` to `ProviderKind`

**Files:**
- Modify: `src/shared/index.ts:91`

- [ ] **Step 1: Add `'hermes'` to the union**

Change line 91:

```ts
export type ProviderKind = 'claude_code' | 'codex' | 'opencode' | 'hermes' | 'openai_compat';
```

- [ ] **Step 2: Rebuild shared**

Run: `npm run --workspace=src/shared build`
Expected: `tsc` completes, no output.

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add hermes ProviderKind"
```

---

### Task 2: Dispatch — `hermes` reuses openai_compat + `hermesHealthUrl` helper (TDD)

**Files:**
- Modify: `src/backend/orchestrator/providers.ts` (share the `openai_compat` case; add `hermesHealthUrl`)
- Test: `src/backend/test/providers.test.ts` (append)

- [ ] **Step 1: Write the failing test for `hermesHealthUrl`**

Append to `src/backend/test/providers.test.ts`:

```ts
import { hermesHealthUrl } from '../orchestrator/providers';

test('hermesHealthUrl derives /health from a /v1 base', () => {
  assert.equal(hermesHealthUrl('http://<tailnet-ip>:8642/v1'), 'http://<tailnet-ip>:8642/health');
  assert.equal(hermesHealthUrl('http://<tailnet-ip>:8642/v1/'), 'http://<tailnet-ip>:8642/health');
  assert.equal(hermesHealthUrl('http://h:8642'), 'http://h:8642/health');
});
```

(The existing `import { splitArgs, buildOpenCodeArgs } from '../orchestrator/providers';` line stays; add `hermesHealthUrl` to a new import line as shown, or merge into the existing import.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run --workspace=src/backend test`
Expected: FAIL — `hermesHealthUrl` is not exported.

- [ ] **Step 3: Add the `hermesHealthUrl` helper**

In `src/backend/orchestrator/providers.ts`, add near the other small exported helpers (e.g. right after `splitArgs`):

```ts
/** Derive Hermes' /health URL from its OpenAI-compatible base (…/v1 → …/health). */
export function hermesHealthUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/health';
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run --workspace=src/backend test`
Expected: PASS (all prior tests + 1 new).

- [ ] **Step 5: Make `hermes` dispatch via the openai_compat branch**

In `src/backend/orchestrator/providers.ts`, in `runPersona`'s `if (provider) { switch (provider.kind) {` block, change the `openai_compat` case label (currently `case 'openai_compat': {`) to also catch `hermes`:

```ts
      case 'openai_compat':
      case 'hermes': {
        const baseUrl = resolveEnvVars(provider.base_url || '');
        const apiKey = resolveEnvVars(provider.api_key || '');
        const headers = /openrouter\.ai/.test(baseUrl) ? { 'HTTP-Referer': 'https://nexus.local', 'X-Title': 'NEXUS' } : undefined;
        return runOpenAICompatible({ ...persona, model }, prompt, { baseUrl, apiKey, headers }, onOutput);
      }
```

- [ ] **Step 6: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/orchestrator/providers.ts src/backend/test/providers.test.ts
git commit -m "feat(backend): hermes dispatch via openai_compat + hermesHealthUrl helper"
```

---

### Task 3: Health & test — probe Hermes via `/health`

**Files:**
- Modify: `src/backend/routes/status.ts` (add `probeHermes` + a `hermes` branch in `probeAgent`)
- Modify: `src/backend/routes/providers.ts` (add a `hermes` branch in `testProvider`)

- [ ] **Step 1: Add the `probeHermes` helper in status.ts**

In `src/backend/routes/status.ts`, add an import at the top (with the other imports):

```ts
import { hermesHealthUrl } from '../orchestrator/providers';
```

Then add this helper next to `probeLocalModels`:

```ts
/** Probe a Hermes agent's /health endpoint. online iff it returns {"status":"ok"}. */
async function probeHermes(baseUrl: string): Promise<{ status: AgentStatus; latencyMs?: number; detail?: string }> {
  if (!baseUrl) return { status: 'offline', detail: 'no base_url' };
  const url = hermesHealthUrl(baseUrl);
  const start = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const body: any = await res.json().catch(() => ({}));
    const ok = res.ok && body?.status === 'ok';
    return { status: ok ? 'online' : 'offline', latencyMs: Date.now() - start, detail: body?.platform || url };
  } catch {
    return { status: 'offline', detail: 'unreachable' };
  }
}
```

- [ ] **Step 2: Add the `hermes` branch in `probeAgent`**

In `src/backend/routes/status.ts`, in `probeAgent`, insert a branch before the CLI branch. Change:

```ts
  if (kind === 'openai_compat') {
    const r = await probeLocalModels(baseUrl, apiKey);
    status = r.status;
    latencyMs = r.latencyMs;
    detail = baseUrl || 'no base_url';
  } else if (kind === 'claude_code' || kind === 'codex' || kind === 'opencode') {
```

to:

```ts
  if (kind === 'openai_compat') {
    const r = await probeLocalModels(baseUrl, apiKey);
    status = r.status;
    latencyMs = r.latencyMs;
    detail = baseUrl || 'no base_url';
  } else if (kind === 'hermes') {
    const r = await probeHermes(baseUrl);
    status = r.status;
    latencyMs = r.latencyMs;
    detail = r.detail;
  } else if (kind === 'claude_code' || kind === 'codex' || kind === 'opencode') {
```

- [ ] **Step 3: Add the `hermes` branch in `testProvider`**

In `src/backend/routes/providers.ts`, add a `hermes` branch at the START of `testProvider` (before the `if (p.kind === 'openai_compat')` block). First add the import (with the existing `import { loadConfig, resolveEnvVars } from '../config';`):

```ts
import { hermesHealthUrl } from '../orchestrator/providers';
```

Then, as the first statement in `testProvider`:

```ts
  if (p.kind === 'hermes') {
    const url = hermesHealthUrl(resolveEnvVars(p.base_url || ''));
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      const body: any = await res.json().catch(() => ({}));
      const ok = res.ok && body?.status === 'ok';
      return { ok, detail: ok ? (body.platform || 'ok') : `HTTP ${res.status}`, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, detail: err.name === 'AbortError' ? 'timed out' : err.message };
    }
  }
```

- [ ] **Step 4: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/status.ts src/backend/routes/providers.ts
git commit -m "feat(backend): hermes /health status probe + provider test"
```

---

### Task 4: Unify orchestrator dispatch onto `runPersona`

**Files:**
- Modify: `src/backend/routes/providers.ts` (export `getProviderById`)
- Modify: `src/backend/routes/chat.ts` (use `getProviderById`)
- Modify: `src/backend/orchestrator/index.ts` (replace the legacy switch)

- [ ] **Step 1: Add `getProviderById` to providers.ts**

In `src/backend/routes/providers.ts`, add right after the `rowToProvider` helper:

```ts
/** Load a provider by id with all columns parsed (models/args included). */
export function getProviderById(db: Database.Database, id: string): Provider | undefined {
  const row = db.prepare(`SELECT ${COLS} FROM providers WHERE id = ?`).get(id);
  return row ? rowToProvider(row) : undefined;
}
```

(`Database` is already imported; `COLS` and `rowToProvider` are already defined above.)

- [ ] **Step 2: Refactor chat.ts to use it (fixes its stale SELECT missing models/args)**

In `src/backend/routes/chat.ts`, add to the imports (it already imports from `./providers`? if not, add this line near the top imports):

```ts
import { getProviderById } from './providers';
```

Then replace lines ~109-112:

```ts
    let provider: Provider | undefined;
    if (persona.provider_id) {
      provider = db.prepare('SELECT id, name, kind, base_url, api_key, default_model, created_at FROM providers WHERE id = ?').get(persona.provider_id) as Provider | undefined;
    }
```

with:

```ts
    const provider: Provider | undefined = persona.provider_id ? getProviderById(db, persona.provider_id) : undefined;
```

(Keep the existing `Provider` import in chat.ts — it's still used by this annotation.)

- [ ] **Step 3: Replace the legacy switch in the orchestrator**

In `src/backend/orchestrator/index.ts`, update imports. Change line 14:

```ts
import { getNexusDir, loadConfig } from '../config';
```

Change line 16:

```ts
import { runPersona } from './providers';
```

Add a new import line (after line 16):

```ts
import { getProviderById } from '../routes/providers';
```

Then replace the entire block from `let result: ProviderResult;` (line ~78) through the end of the `switch (persona.provider) { … }` (the `}` on line ~111) with:

```ts
  const provider = persona.provider_id ? getProviderById(db, persona.provider_id) : undefined;
  console.log(`[orchestrator] Dispatching via ${provider ? `${provider.name} (${provider.kind})` : persona.provider} for task ${taskId}`);
  const result = await runPersona(persona, prompt, workspace, config, appendOutput, provider);
```

- [ ] **Step 4: Record the resolved provider + effective model**

In the same file, update the `completeAgentRun` call (lines ~114-119) to use the resolved provider:

```ts
  const status = result.ok ? 'completed' : 'failed';
  completeAgentRun(db, runId, status, result.output, result.error, {
    provider: provider?.name ?? persona.provider,
    model: persona.model || provider?.default_model || '',
    usage: result.usage,
    durationMs: result.durationMs,
  });
```

- [ ] **Step 5: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS (no unused-import errors — `runClaudeCode`/`runCodex`/`runOpenAICompatible`/`resolveOpenRouterKey`/`resolveEnvVars`/`ProviderResult` are gone from imports because their only uses were in the replaced block).

- [ ] **Step 6: Run backend tests (sanity)**

Run: `npm run --workspace=src/backend test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/providers.ts src/backend/routes/chat.ts src/backend/orchestrator/index.ts
git commit -m "feat(backend): unify orchestrator task dispatch onto runPersona (fixes opencode/hermes in tasks)"
```

---

### Task 5: Seed + backfill the Hermes provider & persona (`user_version = 2`)

**Files:**
- Modify: `src/backend/routes/providers.ts` (`seedProviders` + new `seedHermesPersona`)

- [ ] **Step 1: Add the `seedHermesPersona` helper**

In `src/backend/routes/providers.ts`, add above `seedProviders`:

```ts
/** Auto-provision the Hermes persona (stable id so racing boots can't duplicate). */
function seedHermesPersona(db: Database.Database): void {
  const yaml = [
    'name: Hermes',
    'slug: hermes',
    'provider: openrouter',
    'provider_id: seed-hermes',
    "model: ''",
    "system_prompt: 'You are Hermes, a remote scheduling/automation agent.'",
    'tools: []',
    "workspace: '~/Projects/{project}'",
    'startup_scripts: []',
    'token_budget: 4000',
  ].join('\n') + '\n';
  db.prepare('INSERT OR IGNORE INTO personas (id, name, slug, config_yaml, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('seed-hermes-persona', 'Hermes', 'hermes', yaml, new Date().toISOString());
}
```

- [ ] **Step 2: Add the Hermes provider to the fresh seed + stamp `user_version = 2`**

In `seedProviders`, after the `opencode` const, add the `hermes` const:

```ts
  const hermes = { id: 'seed-hermes', name: 'Hermes', kind: 'hermes', base_url: 'http://<tailnet-ip>:8642/v1', api_key: '${HERMES_API_KEY}', default_model: 'hermes-agent', models: JSON.stringify(['hermes-agent']), args: null, created_at: now };
```

In the `if (n === 0)` branch, add `hermes` to the `seed` array (after `opencode`), then replace the tail of that branch (`db.pragma('user_version = 1'); return;`) with:

```ts
    for (const p of seed) ins.run(p);
    console.log(`[providers] seeded ${seed.length} default providers`);
    seedHermesPersona(db);
    db.pragma('user_version = 2');
    return;
```

- [ ] **Step 3: Turn the backfill into a versioned ladder**

Replace the existing existing-DB backfill tail (from `const uv = db.pragma(...)` to the end of `seedProviders`) with:

```ts
  // Existing DB: one-time backfills, gated by user_version (each runs exactly once).
  const uv = db.pragma('user_version', { simple: true }) as number;
  if (uv >= 2) return;
  const ins = db.prepare(insSql);
  if (uv < 1) {
    ins.run(opencode);
    console.log('[providers] backfilled OpenCode provider (one-time)');
  }
  if (uv < 2) {
    ins.run(hermes);
    seedHermesPersona(db);
    console.log('[providers] backfilled Hermes provider + persona (one-time)');
  }
  db.pragma('user_version = 2');
```

- [ ] **Step 4: Typecheck the backend**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/providers.ts
git commit -m "feat(backend): seed + backfill Hermes provider & persona (user_version=2)"
```

---

### Task 6: Frontend — `hermes` kind in ProvidersSettings

**Files:**
- Modify: `src/frontend/src/components/ProvidersSettings.tsx`

- [ ] **Step 1: Add the kind option**

In `src/frontend/src/components/ProvidersSettings.tsx`, add to the `KINDS` array:

```ts
  { value: 'hermes', label: 'Hermes (remote HTTP agent)' },
```

- [ ] **Step 2: Show base_url + api_key fields for `hermes`**

The base_url/api_key inputs are currently rendered only when `editing.kind === 'openai_compat'`. Change that condition to include `hermes`:

```tsx
          {(editing.kind === 'openai_compat' || editing.kind === 'hermes') && (
```

(Leave the rest of that block — the two inputs — unchanged.)

- [ ] **Step 3: Typecheck the frontend**

Run: `npm run --workspace=src/frontend typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/ProvidersSettings.tsx
git commit -m "feat(frontend): hermes provider kind in ProvidersSettings"
```

---

### Task 7: Full verification — tests, build, live smoke

**Files:** none (verification only)

- [ ] **Step 1: Backend tests + whole-repo typecheck**

Run: `npm run --workspace=src/backend test && npm run typecheck`
Expected: tests PASS; typecheck PASS for shared, backend, frontend.

- [ ] **Step 2: Full build (incl. daemon)**

Run: `npm run build`
Expected: all workspaces + daemon build, no errors.

- [ ] **Step 3: Seed/backfill smoke on a fresh + simulated-existing DB**

Run (compiled backend, throwaway HOME; `sqlite3` required):

```bash
HOME=/tmp/hz node src/backend/dist/index.js >/tmp/hz.log 2>&1 &
npx --no-install wait-on -t 15000 http-get://127.0.0.1:4173/api/health
curl -s http://127.0.0.1:4173/api/providers | python3 -c "import sys,json;ps=json.load(sys.stdin);print('providers',len(ps),'hermes',any(p['kind']=='hermes' for p in ps))"
curl -s http://127.0.0.1:4173/api/personas | python3 -c "import sys,json;ps=json.load(sys.stdin);print('hermes persona', any(p.get('slug')=='hermes' for p in ps))"
lsof -nP -iTCP:4173 -sTCP:LISTEN -t | xargs -r kill -TERM
echo "user_version=$(sqlite3 /tmp/hz/.nexus/nexus.db 'PRAGMA user_version;')"
# simulate a pre-Hermes DB (had OpenCode, uv=1):
sqlite3 /tmp/hz/.nexus/nexus.db "DELETE FROM providers WHERE kind='hermes'; DELETE FROM personas WHERE slug='hermes'; PRAGMA user_version=1;"
HOME=/tmp/hz node src/backend/dist/index.js >/tmp/hz.log 2>&1 &
npx --no-install wait-on -t 15000 http-get://127.0.0.1:4173/api/health
curl -s http://127.0.0.1:4173/api/providers | python3 -c "import sys,json;print('after backfill hermes', any(p['kind']=='hermes' for p in json.load(sys.stdin)))"
lsof -nP -iTCP:4173 -sTCP:LISTEN -t | xargs -r kill -TERM
rm -rf /tmp/hz
```

Expected: fresh → `hermes True`, `hermes persona True`, `user_version=2`; after simulated downgrade+reboot → `after backfill hermes True`.

- [ ] **Step 4: Live Hermes health/test + dispatch (on the tailnet, with the key)**

```bash
export HERMES_API_KEY='<paste the real key>'   # do NOT commit this anywhere
HOME=/tmp/hz2 HERMES_API_KEY="$HERMES_API_KEY" node src/backend/dist/index.js >/tmp/hz2.log 2>&1 &
npx --no-install wait-on -t 15000 http-get://127.0.0.1:4173/api/health
# provider test -> /health
curl -s -X POST http://127.0.0.1:4173/api/providers/seed-hermes/test
# mission control -> hermes online
curl -s http://127.0.0.1:4173/api/mission-control | python3 -c "import sys,json;d=json.load(sys.stdin);print([(a['name'],a['status']) for a in d['agents'] if a['provider'].lower().find('hermes')>=0 or a['name']=='Hermes'])"
lsof -nP -iTCP:4173 -sTCP:LISTEN -t | xargs -r kill -TERM; rm -rf /tmp/hz2
```

Expected: test → `{"ok":true,"detail":"hermes-agent",...}`; Mission Control shows `('Hermes','online')`.

- [ ] **Step 5: (Manual, optional) end-to-end delegation**

With `HERMES_API_KEY` exported and the app running (`npm run web`), create a task (or a schedule) assigned to the **Hermes** agent. Confirm the orchestrator logs `Dispatching via Hermes (hermes)`, the task completes, and `agent_runs` records provider `Hermes`, model `hermes-agent`, with real token usage.

- [ ] **Step 6: README run-note for the env var**

Add a one-line note to `README.md` (near the run instructions) that the Hermes agent requires `HERMES_API_KEY` in the backend's environment. Commit:

```bash
git add README.md
git commit -m "docs: note HERMES_API_KEY env var for the Hermes agent"
```

---

## Self-review notes (author)

- **Spec coverage:** Part A → T1 (kind), T2 (dispatch), T3 (health/test); Part B → T4 (getProviderById + chat refactor + orchestrator unify); Part C → T5 (provider+persona seed/backfill, secret via `${HERMES_API_KEY}`); UI → T6; verification → T7. All covered.
- **Type consistency:** `hermesHealthUrl` (T2) is consumed in T3 (status + providers) with matching signature; `getProviderById(db, id): Provider | undefined` defined in T4 used identically in chat + orchestrator; `seed-hermes` provider id referenced by the persona's `provider_id` and by the `/test` smoke.
- **Known minor redundancy (not fixed — out of scope):** orchestrator tasks pass `buildAgentPrompt` output (which already embeds `System: <system_prompt>`) through `runPersona`, which also prepends/sends the system prompt — so the system prompt may appear twice for task dispatch. Harmless; flagged for a later prompt-shaping pass.
- **Secret:** the literal stored is `${HERMES_API_KEY}`; the real key only ever lives in the env var at runtime and in the operator's shell — never in git.
