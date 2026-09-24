# Anthropic Cutover Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the non-compliant Pi path to Anthropic unreachable while the Claude engine is enabled, drop the OAuth bridge package, and give Settings an honest view of how the Claude engine authenticates.

**Architecture:** `PiEngine` accepts a hide predicate; `index.ts` hides Pi `anthropic/*` models whenever the Claude engine is enabled AND Pi's stored Anthropic credential is OAuth (API-key Anthropic stays usable). A new `GET /api/engines` reports the engine's status (enabled, auth mode, whether `CLAUDE_CODE_OAUTH_TOKEN` resolved, whether Pi's Anthropic OAuth is hidden). Settings gets an "Engines" section and the Provider Auth row for Anthropic explains the hand-over instead of offering subscription login. The chat route's engine-pin guard keys on the model key prefix so a thread started on a now-hidden `anthropic/*` model still counts as Pi.

**Tech Stack:** Fastify routes, `readStoredCredential` from `@earendil-works/pi-coding-agent`, React + vitest/testing-library in `src/frontend`.

## Global Constraints

- Backend ESM, `.js` import suffixes; backend tests `npx tsx --test <file>` from `src/backend`; frontend tests `npx vitest run <file>` from `src/frontend`.
- Hide condition, exactly: `config.engines.claude.enabled === true` AND `readStoredCredential('anthropic', pi.paths.authFile)?.type === 'oauth'`. Never delete the user's stored credential.
- `GET /api/engines` response shape: `{ engines: [{ id: 'claude-code', enabled: boolean, auth: 'subscription' | 'api_key', tokenConfigured: boolean, authSource: 'token' | 'login' | 'api_key', executablePath: string | null, modelCount: number }], piAnthropicOAuthHidden: boolean }`. The token value never leaves the backend.
- `POST /api/auth/start-oauth` with `provider: 'anthropic'` returns 400 `{ ok: false, reason: 'claude_engine_owns_anthropic' }` while the hide condition holds.
- Chat engine-pin guard: previous engine = `last_model_key.startsWith('claude-code/') ? 'claude-code' : 'pi'`; requested engine = `resolved.engine.id`.
- KEEP `@blackbelt-technology/pi-anthropic-messages`: review found it canonicalises tool names for every anthropic-messages session (API key included), so removing it breaks tool calls on the legitimate Anthropic API-key path. The OAuth credential is the non-compliant part, and hiding/refusing it is sufficient.
- Nothing under `project_docs/**` is committed; `src/glasses/package-lock.json` (pre-existing modification) stays out of commits.

---

### Task 1: Backend — hide Pi Anthropic OAuth models, engines status route, guard by prefix, drop the bridge

**Files:**
- Modify: `src/backend/engines/pi-engine.ts`
- Create: `src/backend/engines/claude/status.ts`
- Create: `src/backend/routes/engines.ts`
- Modify: `src/backend/engines/claude/auth.ts` (export `interpolate`)
- Modify: `src/backend/index.ts`, `src/backend/routes/auth.ts`, `src/backend/routes/chat.ts`, `src/backend/pi/runtime.ts`, `src/backend/package.json`, `package-lock.json`
- Test: `src/backend/test/engines-registry.test.ts` (append), `src/backend/test/routes-engines.test.ts` (new), `src/backend/test/routes-chat-engines.test.ts` (append)

**Interfaces:**
- `PiEngine` constructor: `(pi, options?: { isHidden?: (model: EngineModel) => boolean })`; hidden models are excluded from `listModels()` and `findModel()` returns `undefined` for them.
- `src/backend/engines/claude/status.ts`: `claudeEngineStatus(cfg: ClaudeEngineConfig, env?: NodeJS.ProcessEnv): EngineStatus` and `isPiAnthropicOAuthHidden(cfg: ClaudeEngineConfig, authFile: string): boolean`.
- `registerEngineRoutes(fastify)` serving `GET /api/engines`.

- [ ] **Step 1: Tests first**

Append to `src/backend/test/engines-registry.test.ts`:

```ts
test('PiEngine hides models the predicate rejects from both listModels and findModel', () => {
  const all = [
    { provider: 'anthropic', id: 'claude-fable-5', name: 'Fable' },
    { provider: 'openrouter', id: 'a', name: 'A' },
  ];
  const runtime = {
    models: { getAll: () => all, getAvailable: () => all, find: (p: string, id: string) => all.find((m) => m.provider === p && m.id === id) },
    sessionFor: async () => fakeSession, hasSession: () => false, dropSession: () => {},
  };
  const pi = new PiEngine(runtime as any, { isHidden: (m) => m.provider === 'anthropic' });
  assert.deepEqual(pi.listModels().map((m) => m.id), ['a']);
  assert.equal(pi.findModel('anthropic', 'claude-fable-5'), undefined);
  assert.ok(pi.findModel('openrouter', 'a'));
});
```

Create `src/backend/test/routes-engines.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerEngineRoutes } from '../routes/engines.js';
import { claudeEngineStatus, isPiAnthropicOAuthHidden } from '../engines/claude/status.js';

const enabled = { enabled: true, auth: 'subscription' as const, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}', executable_path: '' };

test('claudeEngineStatus reports token, login and api_key modes without leaking the token', () => {
  assert.deepEqual(claudeEngineStatus(enabled, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' }), {
    id: 'claude-code', enabled: true, auth: 'subscription', tokenConfigured: true, authSource: 'token', executablePath: null, modelCount: 5,
  });
  assert.equal(claudeEngineStatus(enabled, {}).authSource, 'login');
  assert.equal(claudeEngineStatus({ ...enabled, auth: 'api_key' }, {}).authSource, 'api_key');
  assert.equal(claudeEngineStatus({ ...enabled, executable_path: '/opt/claude' }, {}).executablePath, '/opt/claude');
  assert.ok(!JSON.stringify(claudeEngineStatus(enabled, { CLAUDE_CODE_OAUTH_TOKEN: 'secret' })).includes('secret'));
});

test('isPiAnthropicOAuthHidden is true only for an enabled engine plus a stored OAuth credential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-'));
  try {
    const authFile = join(dir, 'auth.json');
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'oauth', access: 'x', refresh: 'y', expires: 0 } }));
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), true);
    assert.equal(isPiAnthropicOAuthHidden({ ...enabled, enabled: false }, authFile), false);
    writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'api_key', key: 'sk' } }));
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), false);
    writeFileSync(authFile, '{}');
    assert.equal(isPiAnthropicOAuthHidden(enabled, authFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/engines returns the status and the hidden flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-'));
  const authFile = join(dir, 'auth.json');
  writeFileSync(authFile, JSON.stringify({ anthropic: { type: 'oauth', access: 'x', refresh: 'y', expires: 0 } }));
  const app = Fastify({ logger: false });
  app.decorate('pi', { paths: { authFile } } as any);
  app.register(registerEngineRoutes, { config: () => enabled, env: { CLAUDE_CODE_OAUTH_TOKEN: 't' } });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/engines' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.engines[0].authSource, 'token');
    assert.equal(body.piAnthropicOAuthHidden, true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Append to `src/backend/test/routes-chat-engines.test.ts` (inside the existing `makeApp`, insert a thread whose `last_model_key` is `anthropic/old`; or update it in the test):

```ts
test('a thread last used on a now-hidden anthropic/* model still counts as the pi engine', async () => {
  const { app, db, dir } = await makeApp();
  try {
    db.prepare('UPDATE chat_threads SET last_model_key = ? WHERE id = ?').run('anthropic/claude-fable-5', 'thread-1');
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'claude-code/m1' } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().kind, 'engine_mismatch');
    const ok = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'openrouter/m1' } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await app.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
```

Run all three files; expect failures for the new tests.

- [ ] **Step 2: `PiEngine` hide predicate** (`src/backend/engines/pi-engine.ts`)

```ts
export interface PiEngineOptions {
  /** Models to withhold from the catalog and from lookup (e.g. Pi's Anthropic
   *  OAuth models while the Claude engine owns Anthropic). Read per call. */
  isHidden?: (model: EngineModel) => boolean;
}
```

Constructor `constructor(private readonly pi: PiRuntimeSurface, private readonly options: PiEngineOptions = {})`. In `listModels()` filter out `this.options.isHidden?.(m)`; in `findModel()` return `undefined` when the found model is hidden.

- [ ] **Step 3: Status helpers** (`src/backend/engines/claude/status.ts`; export `interpolate` from `auth.ts`)

```ts
import { readStoredCredential } from '@earendil-works/pi-coding-agent';
import { CLAUDE_CODE_MODELS } from './models.js';
import { interpolate, type ClaudeEngineConfig } from './auth.js';

export interface EngineStatus {
  id: 'claude-code';
  enabled: boolean;
  auth: 'subscription' | 'api_key';
  tokenConfigured: boolean;
  authSource: 'token' | 'login' | 'api_key';
  executablePath: string | null;
  modelCount: number;
}

export function claudeEngineStatus(cfg: ClaudeEngineConfig, env: NodeJS.ProcessEnv = process.env): EngineStatus {
  const tokenConfigured = interpolate(cfg.oauth_token || '', env).trim().length > 0;
  return {
    id: 'claude-code',
    enabled: cfg.enabled === true,
    auth: cfg.auth === 'api_key' ? 'api_key' : 'subscription',
    tokenConfigured,
    authSource: cfg.auth === 'api_key' ? 'api_key' : tokenConfigured ? 'token' : 'login',
    executablePath: cfg.executable_path?.trim() || null,
    modelCount: CLAUDE_CODE_MODELS.length,
  };
}

/** Pi's Anthropic OAuth path is the non-compliant one; hide it whenever the
 *  Claude engine is on. An API-key credential for `anthropic` is untouched. */
export function isPiAnthropicOAuthHidden(cfg: ClaudeEngineConfig, authFile: string): boolean {
  if (cfg.enabled !== true) return false;
  try {
    return readStoredCredential('anthropic', authFile)?.type === 'oauth';
  } catch {
    return false;
  }
}
```

If `readStoredCredential`'s `Credential` type has no `type` field, inspect `node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.d.ts` and use the discriminant it does have; the on-disk shape is `{ type: 'oauth' | 'api_key', ... }` per `~/.nexus/auth.json`.

- [ ] **Step 4: Route** (`src/backend/routes/engines.ts`)

```ts
import type { FastifyInstance } from 'fastify';
import type { ClaudeEngineConfig } from '../engines/claude/auth.js';
import { claudeEngineStatus, isPiAnthropicOAuthHidden } from '../engines/claude/status.js';
import { loadConfig } from '../config.js';

export interface RegisterEngineRoutesOptions {
  config?: () => ClaudeEngineConfig;
  env?: NodeJS.ProcessEnv;
}

export async function registerEngineRoutes(fastify: FastifyInstance, options: RegisterEngineRoutesOptions = {}) {
  const config = options.config ?? (() => loadConfig().engines.claude);
  const env = options.env ?? process.env;
  fastify.get('/api/engines', async () => {
    const cfg = config();
    return {
      engines: [claudeEngineStatus(cfg, env)],
      piAnthropicOAuthHidden: isPiAnthropicOAuthHidden(cfg, fastify.pi.paths.authFile),
    };
  });
}
```

- [ ] **Step 5: Wire** (`src/backend/index.ts`) — build the Pi engine with the predicate and register the route:

```ts
const claudeConfig = () => { try { return loadConfig().engines.claude; } catch { return { enabled: false, auth: 'subscription' as const, oauth_token: '', executable_path: '' }; } };
const piEngine = new PiEngine(pi, {
  isHidden: (model) => model.provider === 'anthropic' && isPiAnthropicOAuthHidden(claudeConfig(), pi.paths.authFile),
});
const claudeEngine = new ClaudeEngine({ pi, config: claudeConfig });
const engines = new EngineRegistry([piEngine, claudeEngine]);
```

(replace the existing `ClaudeEngine`/`EngineRegistry` construction) and `app.register(registerEngineRoutes);` next to `registerPiRoutes`.

- [ ] **Step 6: Auth route** (`src/backend/routes/auth.ts`) — in `POST /api/auth/start-oauth`, before starting the flow:

```ts
if (body.provider === 'anthropic') {
  let cfg; try { cfg = loadConfig().engines.claude; } catch { cfg = undefined; }
  if (cfg && isPiAnthropicOAuthHidden(cfg, fastify.pi.paths.authFile)) {
    reply.code(400);
    return { ok: false, reason: 'claude_engine_owns_anthropic' };
  }
}
```

Also block it when the engine is enabled and there is no stored credential yet (otherwise the user could create a new OAuth credential): use `cfg?.enabled === true` as the condition instead of the hidden helper — i.e. while the Claude engine is enabled, Anthropic subscription login through Pi is refused outright. Adjust the plan constraint accordingly: refuse when `enabled`.

- [ ] **Step 7: Chat guard by prefix** (`src/backend/routes/chat.ts`) — replace the resolve-based lookup of the previous engine with `const previousEngineId = lastKey.startsWith('claude-code/') ? 'claude-code' : 'pi';` keeping the 409 body unchanged.

- [ ] **Step 8: Drop the bridge** — remove the import and the `anthropicMessagesBridge` entry in `buildResourceLoaderOptions` (`src/backend/pi/runtime.ts`), then `npm uninstall --workspace=src/backend @blackbelt-technology/pi-anthropic-messages`. Confirm `grep -rn pi-anthropic-messages src package-lock.json` is empty.

- [ ] **Step 9: Verify** — the three test files, then `npm run --workspace=src/backend test` (known env-dependent orientation-block failure only) and `npm run --workspace=src/backend typecheck`. Commit: `feat(engines): hide Pi Anthropic OAuth while the Claude engine is on; /api/engines status; drop the OAuth bridge`.

---

### Task 2: Frontend — Engines section and Provider Auth hand-over

**Files:**
- Create: `src/frontend/src/components/EnginesSection.tsx`, `src/frontend/src/components/EnginesSection.test.tsx`
- Modify: `src/frontend/src/components/PiAuthSection.tsx`, `src/frontend/src/components/PiAuthSection.test.tsx`, `src/frontend/src/components/SettingsPage.tsx`

**Interfaces:**
- `EnginesSection` fetches `GET /api/engines` via `apiFetch` from `../api-base` and renders the Claude engine card.
- `PiAuthSection` gains an optional prop `claudeEngineEnabled?: boolean` (default false). `SettingsPage` fetches `/api/engines` once and passes `engines[0].enabled`.

- [ ] **Step 1: Tests first**

`EnginesSection.test.tsx` (same fetch-mock pattern as `PiAuthSection.test.tsx`): renders "Claude Code" with "Enabled"; for `authSource: 'token'` shows the text `CLAUDE_CODE_OAUTH_TOKEN is set in the backend environment`; for `'login'` shows `Using this machine's claude login`; for `'api_key'` shows `API key mode`; when `piAnthropicOAuthHidden` is true shows `Anthropic subscription models via Pi are hidden while this engine is on`.

`PiAuthSection.test.tsx`: with `claudeEngineEnabled` and `/api/auth/status` returning `{ providers: [{ id: 'anthropic', type: 'oauth' }] }`, the Anthropic row shows `Handled by the Claude Code engine` and a `Remove` button, and no `Subscription login Anthropic (Claude)` button; without the prop the old behaviour holds (existing tests).

- [ ] **Step 2: `EnginesSection.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { apiFetch } from '../api-base';

interface EngineStatus {
  id: string; enabled: boolean; auth: 'subscription' | 'api_key';
  tokenConfigured: boolean; authSource: 'token' | 'login' | 'api_key';
  executablePath: string | null; modelCount: number;
}
interface EnginesResponse { engines: EngineStatus[]; piAnthropicOAuthHidden: boolean }

const AUTH_TEXT: Record<EngineStatus['authSource'], string> = {
  token: 'CLAUDE_CODE_OAUTH_TOKEN is set in the backend environment (from claude setup-token).',
  login: "Using this machine's claude login (no CLAUDE_CODE_OAUTH_TOKEN configured).",
  api_key: 'API key mode: ANTHROPIC_API_KEY from the backend environment is used, not a subscription.',
};

export function EnginesSection() {
  const [data, setData] = useState<EnginesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/engines').then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as EnginesResponse;
      if (!cancelled) setData(body);
    }).catch((err) => { if (!cancelled) setError(err?.message ?? 'failed'); });
    return () => { cancelled = true; };
  }, []);
  if (error) return <div className="text-xs text-red-300">Engine status unavailable: {error}</div>;
  if (!data) return <div className="text-xs text-zinc-500">Loading engine status…</div>;
  const claude = data.engines.find((e) => e.id === 'claude-code');
  if (!claude) return null;
  return (
    <div className="space-y-2 text-xs text-zinc-300">
      <div className="flex items-center gap-2">
        <span className="text-sm text-zinc-200 w-40">Claude Code</span>
        <span className={claude.enabled ? 'text-green-400' : 'text-zinc-500'}>{claude.enabled ? '✓ Enabled' : 'Disabled'}</span>
        <span className="text-zinc-500">· {claude.modelCount} models as claude-code/*</span>
      </div>
      <p className="text-zinc-400">{AUTH_TEXT[claude.authSource]}</p>
      {claude.executablePath && <p className="text-zinc-500">Executable: <span className="font-mono">{claude.executablePath}</span></p>}
      {data.piAnthropicOAuthHidden && (
        <p className="text-amber-300/90">Anthropic subscription models via Pi are hidden while this engine is on. Remove the Pi Anthropic login under Provider Auth to tidy up; an Anthropic API key is unaffected.</p>
      )}
      <p className="text-zinc-500">Configure in <span className="font-mono">~/.nexus/config.yaml</span> under <span className="font-mono">engines.claude</span>; the token itself lives in the backend's <span className="font-mono">.env</span>.</p>
    </div>
  );
}
```

- [ ] **Step 3: `PiAuthSection` hand-over** — add the prop; in the provider map, when `p.id === 'anthropic' && claudeEngineEnabled`: render the label, then if `configured` → `<span className="text-xs text-amber-300">Handled by the Claude Code engine</span>` plus the existing Remove button (so the OAuth credential can be cleaned up); if not configured → the same amber text and the API-key input/Save (an API key stays legitimate) but NO subscription-login button.

- [ ] **Step 4: `SettingsPage`** — add `const [claudeEngineEnabled, setClaudeEngineEnabled] = useState(false);` with a `useEffect` calling `apiFetch('/api/engines')` (ignore failures), render `<Section title="Engines"><EnginesSection /></Section>` directly above the "Provider Auth" section, and pass `claudeEngineEnabled` to `<PiAuthSection />`. Check `SettingsPage.test.tsx` mocks fetch by URL and add `/api/engines` to its mock if it throws on unexpected URLs.

- [ ] **Step 5: Verify** — `npx vitest run src/components/EnginesSection.test.tsx src/components/PiAuthSection.test.tsx src/components/SettingsPage.test.tsx` from `src/frontend`, then `npm run --workspace=src/frontend typecheck`. Commit: `feat(settings): Engines section and Anthropic hand-over in Provider Auth`.

---

### Task 3: Docs and verification

- README "Engines" section: state that while the Claude engine is enabled, Anthropic subscription login through Pi is refused and existing Pi Anthropic OAuth models are hidden; Anthropic via API key is unaffected; the bridge package is gone. Handoff doc: append a "Follow-up 2026-09-03" note. Plan Known limits updated.
- Full verification: `npm run typecheck`, backend and frontend suites, `npm run build`.
- Push the branch, open a PR against `main` with the summary and the constraint list above.
