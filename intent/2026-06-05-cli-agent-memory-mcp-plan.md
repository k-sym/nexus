# CLI/Terminal Agent Memory via MCP (Phase 4, local) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let CLI/terminal agents read the shared project memory by reusing the daemon's existing MCP server — env-scoped to the current project and recall-only for v1 — with Nexus terminal threads auto-scoped and a small behavior skill nudging recall.

**Architecture:** Enhance the daemon's stdio MCP server to read `NEXUS_MEMORY_PROJECT` / `NEXUS_MEMORY_READONLY` from its env (default the project filter; register only read tools when readonly). Nexus terminal threads inject those env vars at PTY spawn (extends Phase 2's launch). A user-level `nexus-memory` skill supplies the "recall at task start" behavior. Registration per CLI and the remote/cloud path are documented, not automated.

**Tech Stack:** memory-daemon (TypeScript, ESM NodeNext, `@modelcontextprotocol/sdk`, run via `tsx`; **outside the npm workspaces** — build/test via `npm --prefix src/memory-daemon`), Nexus backend (Fastify, `node:test`), Phase 2 PTY (`node-pty`).

**Builds on:** Phase 2 terminal threads (the PTY launch we extend) and the merged better-sqlite3 ABI guard.

---

## File Structure

**Daemon (`src/memory-daemon/`)**
- Create: `src/mcp/scope.ts` — pure env-defaults + scope-merge helpers.
- Create: `test/scope.test.ts` — unit tests for the helpers.
- Modify: `src/mcp/server.ts` — apply env defaults to read tools; gate write tools on readonly.
- Modify: `src/mcp/stdio.ts` — read env, pass defaults to the server, log scope.
- Modify: `package.json` — add a `test` script (`tsx --test`).
- Create: `skills/nexus-memory/SKILL.md` — recall-only behavior skill.
- Create: `docs/cli-agent-memory-setup.md` — per-CLI registration + skill install + caveats.

**Backend (`src/backend/`)**
- Create: `pty/env.ts` — pure PTY-env builder (strip `npm_config_*` + apply overrides).
- Create: `test/pty-env.test.ts` — unit tests.
- Modify: `pty/node-pty-adapter.ts` — use `buildPtyEnv` (replaces the inline strip).
- Modify: `pty/manager.ts` — add `env?` to `SpawnCtx`.
- Modify: `routes/pty.ts` — set `NEXUS_MEMORY_PROJECT` (= project slug) + `NEXUS_MEMORY_READONLY=1` for terminal threads.

No frontend or shared changes.

---

## Task 1: Daemon — env-defaults + scope-merge helpers (TDD)

**Files:**
- Modify: `src/memory-daemon/package.json`
- Create: `src/memory-daemon/src/mcp/scope.ts`
- Test: `src/memory-daemon/test/scope.test.ts`

- [ ] **Step 1: Add a `test` script to the daemon**

In `src/memory-daemon/package.json`, add to `scripts` (after `"typecheck"`):

```json
    "test": "tsx --test test/*.test.ts",
```

- [ ] **Step 2: Write the failing test**

Create `src/memory-daemon/test/scope.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpEnvDefaults, mergeScope } from "../src/mcp/scope.js";

test("mcpEnvDefaults: project pins nexus namespace + isolated scope", () => {
  assert.deepEqual(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "baker-internal" }), {
    namespace: "nexus", project: "baker-internal", scope: "isolated", readonly: false,
  });
});

test("mcpEnvDefaults: readonly flag (1 or true)", () => {
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x", NEXUS_MEMORY_READONLY: "1" }).readonly, true);
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x", NEXUS_MEMORY_READONLY: "true" }).readonly, true);
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "x" }).readonly, false);
});

test("mcpEnvDefaults: no project → only readonly flag, no scope defaults", () => {
  assert.deepEqual(mcpEnvDefaults({}), { readonly: false });
  assert.deepEqual(mcpEnvDefaults({ NEXUS_MEMORY_READONLY: "1" }), { readonly: true });
});

test("mcpEnvDefaults: trims the project slug", () => {
  assert.equal(mcpEnvDefaults({ NEXUS_MEMORY_PROJECT: "  baker-internal  " }).project, "baker-internal");
});

test("mergeScope: explicit args override env defaults", () => {
  const d = { namespace: "nexus", project: "a", scope: "isolated" as const, readonly: false };
  assert.deepEqual(mergeScope({ project: "b", scope: "cross" }, d), { namespace: "nexus", project: "b", scope: "cross" });
});

test("mergeScope: defaults fill gaps when args omit them", () => {
  const d = { namespace: "nexus", project: "a", scope: "isolated" as const, readonly: false };
  assert.deepEqual(mergeScope({}, d), { namespace: "nexus", project: "a", scope: "isolated" });
});

test("mergeScope: no defaults → passes args through (undefined stays undefined)", () => {
  assert.deepEqual(mergeScope({ project: "b" }, { readonly: false }), { namespace: undefined, project: "b", scope: undefined });
});
```

- [ ] **Step 3: Run the test, confirm it FAILS**

Run: `npm --prefix src/memory-daemon test`
Expected: FAIL — cannot find module `../src/mcp/scope.js`.
(If it fails because `tsx` is missing, run `npm --prefix src/memory-daemon install --no-workspaces` first — the daemon installs outside the workspaces.)

- [ ] **Step 4: Implement the helpers**

Create `src/memory-daemon/src/mcp/scope.ts`:

```ts
import type { ScopeFilter } from "../retrieval/types.js";

export interface McpEnvDefaults {
  namespace?: string;
  project?: string;
  scope?: "isolated" | "cross";
  readonly: boolean;
}

/**
 * Read MCP scoping + readonly defaults from the environment.
 * NEXUS_MEMORY_PROJECT pins the nexus namespace + isolated scope to that project slug.
 * NEXUS_MEMORY_READONLY (=1/true) hides the write tools.
 */
export function mcpEnvDefaults(env: NodeJS.ProcessEnv): McpEnvDefaults {
  const readonly = env.NEXUS_MEMORY_READONLY === "1" || env.NEXUS_MEMORY_READONLY === "true";
  const project = env.NEXUS_MEMORY_PROJECT?.trim();
  if (!project) return { readonly };
  return { namespace: "nexus", project, scope: "isolated", readonly };
}

/** Merge explicit tool args over env defaults — args always win. */
export function mergeScope(
  args: { namespace?: string; project?: string; scope?: "isolated" | "cross" },
  defaults: McpEnvDefaults,
): ScopeFilter {
  return {
    namespace: args.namespace ?? defaults.namespace,
    project: args.project ?? defaults.project,
    scope: args.scope ?? defaults.scope,
  };
}
```

- [ ] **Step 5: Run the test, confirm it PASSES**

Run: `npm --prefix src/memory-daemon test`
Expected: PASS (all scope tests green).

- [ ] **Step 6: Commit**

```bash
git add src/memory-daemon/package.json src/memory-daemon/src/mcp/scope.ts src/memory-daemon/test/scope.test.ts
git commit -m "feat(memory-daemon): MCP env-scope + readonly helpers (TDD)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Daemon — wire env scoping + recall-only into the MCP server

**Files:**
- Modify: `src/memory-daemon/src/mcp/server.ts`
- Modify: `src/memory-daemon/src/mcp/stdio.ts`

- [ ] **Step 1: Apply defaults + gate write tools in `server.ts`**

Edit `src/memory-daemon/src/mcp/server.ts`:

1. Add the import near the top:
```ts
import { mergeScope, type McpEnvDefaults } from "./scope.js";
```
2. Remove the now-unused `toFilter` helper (lines 18–22) — `mergeScope` replaces it.
3. Change the signature and apply defaults:
```ts
export function buildMcpServer(client: MemoryClient, opts?: { defaults?: McpEnvDefaults }): McpServer {
  const defaults: McpEnvDefaults = opts?.defaults ?? { readonly: false };
  const server = new McpServer({ name: "nexus-memory", version: "0.1.0" });
```
4. In the `memory_recall`, `memory_search`, and `memory_list` handlers, replace each `toFilter(a)` call with `mergeScope(a, defaults)`.
5. Gate the two write tools. Wrap the `memory_store` registration **and** the `memory_prune` registration in:
```ts
  if (!defaults.readonly) {
    server.tool("memory_store", /* …unchanged… */);
    server.tool("memory_prune", /* …unchanged… */);
  }
```
Leave `memory_recall`, `memory_search`, `memory_get`, `memory_list` always registered. Keep the `memory_get` registration as-is (no scope filter; it's id-based).

- [ ] **Step 2: Read env + pass defaults in `stdio.ts`**

Edit `src/memory-daemon/src/mcp/stdio.ts`:

1. Add import:
```ts
import { mcpEnvDefaults } from "./scope.js";
```
2. In `main()`, after building the client:
```ts
  const defaults = mcpEnvDefaults(process.env);
  const server = buildMcpServer(client, { defaults });
```
3. Update the connect log line to:
```ts
  console.error(`[nexus-memory-mcp] connected; daemon=${baseUrl}; project=${defaults.project ?? "(all)"}; readonly=${defaults.readonly}`);
```

- [ ] **Step 3: Verify typecheck + build + tests**

Run: `npm --prefix src/memory-daemon run typecheck && npm --prefix src/memory-daemon run build && npm --prefix src/memory-daemon test`
Expected: all PASS. (The build refreshes `dist/src/mcp/stdio.js` — the file CLIs actually run.)

> Note: the env→filter logic and the readonly decision are unit-tested in Task 1; this task is the wiring, verified by typecheck/build + the manual pass in Task 7 (the MCP SDK doesn't expose a stable way to introspect registered tools, so tool-surface gating is confirmed manually).

- [ ] **Step 4: Commit**

```bash
git add src/memory-daemon/src/mcp/server.ts src/memory-daemon/src/mcp/stdio.ts
git commit -m "feat(memory-daemon): env-scoped + recall-only MCP server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Backend — pure PTY-env builder (TDD)

Extract the env construction (currently inline in `node-pty-adapter.ts`) into a pure, testable helper that also applies per-thread overrides.

**Files:**
- Create: `src/backend/pty/env.ts`
- Test: `src/backend/test/pty-env.test.ts`
- Modify: `src/backend/pty/node-pty-adapter.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/pty-env.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPtyEnv } from '../pty/env';

test('strips npm_config_* keys (any case)', () => {
  const out = buildPtyEnv({ PATH: '/bin', npm_config_prefix: '/x', NPM_CONFIG_FOO: 'y' });
  assert.equal(out.PATH, '/bin');
  assert.ok(!('npm_config_prefix' in out));
  assert.ok(!('NPM_CONFIG_FOO' in out));
});

test('applies extra overrides over the base env', () => {
  const out = buildPtyEnv({ PATH: '/bin', NEXUS_MEMORY_PROJECT: 'old' }, { NEXUS_MEMORY_PROJECT: 'new', NEXUS_MEMORY_READONLY: '1' });
  assert.equal(out.NEXUS_MEMORY_PROJECT, 'new');
  assert.equal(out.NEXUS_MEMORY_READONLY, '1');
});

test('skips undefined base values', () => {
  const out = buildPtyEnv({ PATH: '/bin', UNDEF: undefined });
  assert.ok(!('UNDEF' in out));
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `npm --workspace=src/backend test`
Expected: FAIL — cannot find module `../pty/env`.

- [ ] **Step 3: Implement**

Create `src/backend/pty/env.ts`:

```ts
/**
 * Build the environment for a PTY shell: start from `base`, drop `npm_config_*`
 * (Hermes' npm_config_prefix breaks nvm so node CLIs don't resolve), then apply
 * `extra` overrides (e.g. per-thread NEXUS_MEMORY_* scoping).
 */
export function buildPtyEnv(base: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (k.toLowerCase().startsWith('npm_config_')) continue;
    env[k] = v;
  }
  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
```

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `npm --workspace=src/backend test`
Expected: PASS.

- [ ] **Step 5: Use the helper in the adapter**

In `src/backend/pty/node-pty-adapter.ts`, replace the inline env-stripping block with the helper. The spawn call's `env` becomes `buildPtyEnv(process.env, ctx.env)`. Concretely:

1. Add import at top: `import { buildPtyEnv } from './env';`
2. Replace the existing `const env = {}; for (...) {...}` strip loop with:
```ts
  const env = buildPtyEnv(process.env, ctx.env);
```
3. Ensure `nodePty.spawn(SHELL, [], { name: 'xterm-color', cwd, cols, rows, env })` uses that `env`.

(`ctx.env` is added to the type in Task 4 Step 1; if you do this task first, TypeScript will flag it — that's expected and fixed in Task 4.)

- [ ] **Step 6: Commit**

```bash
git add src/backend/pty/env.ts src/backend/test/pty-env.test.ts src/backend/pty/node-pty-adapter.ts
git commit -m "refactor(backend): extract buildPtyEnv (pure, testable) + per-thread overrides

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Backend — scope terminal threads to project memory

**Files:**
- Modify: `src/backend/pty/manager.ts`
- Modify: `src/backend/routes/pty.ts`

- [ ] **Step 1: Add `env` to `SpawnCtx`**

In `src/backend/pty/manager.ts`, add an optional field to the `SpawnCtx` interface:

```ts
export interface SpawnCtx {
  cwd: string;
  cols: number;
  rows: number;
  launchCommand: string;
  /** Extra env vars merged over the sanitized base env at spawn (e.g. NEXUS_MEMORY_*). */
  env?: Record<string, string>;
}
```

(No other manager change — `open()` already passes the whole `ctx` to `spawn`.)

- [ ] **Step 2: Set the memory env when opening a terminal thread**

In `src/backend/routes/pty.ts`:

1. Add import: `import { projectSlug } from '../memory';`
2. Where the route resolves the thread + project and builds the `manager.open(threadId, { cwd, cols, rows, launchCommand })` call, compute the memory env and pass it:
```ts
  const slug = projectSlug(db, thread.project_id);
  const memoryEnv: Record<string, string> = {};
  if (slug) {
    memoryEnv.NEXUS_MEMORY_PROJECT = slug;
    memoryEnv.NEXUS_MEMORY_READONLY = '1';
  }
  manager.open(threadId, { cwd, cols, rows, launchCommand, env: memoryEnv });
```
Keep `cwd`, `cols`, `rows`, and the existing `launchCommand` (with its auto-run `\r`) exactly as they are — only add the `env` field. `projectSlug(db, projectId)` returns the project's `slug` (the identifier the daemon scopes nexus memories by) or `null`.

- [ ] **Step 3: Verify typecheck + tests**

Run: `npm run --workspace=src/backend typecheck && npm --workspace=src/backend test`
Expected: PASS (full backend suite stays green; new `pty-env` tests included).

- [ ] **Step 4: Commit**

```bash
git add src/backend/pty/manager.ts src/backend/routes/pty.ts
git commit -m "feat(backend): scope terminal threads to project memory via NEXUS_MEMORY_* env

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: The recall-only behavior skill

**Files:**
- Create: `src/memory-daemon/skills/nexus-memory/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `src/memory-daemon/skills/nexus-memory/SKILL.md`:

```markdown
---
name: nexus-memory
description: Recall this project's stored memories (decisions, context, conventions) before acting.
when_to_use: At the start of a task, or whenever prior project context would inform a decision.
---

# Nexus project memory

This project has a shared memory of prior decisions, conventions, and context, exposed through the
`memory_recall` tool (from the `nexus-memory` MCP server).

**At the start of a task**, call `memory_recall` with a short description of what you're about to do,
to ground yourself in relevant prior decisions before you act. Recall again whenever you reach a
decision that past context might inform.

Memory is automatically scoped to the current project — you do **not** need to pass a project name.

This is **read-only**: use `memory_recall` (and `memory_search` for structured hits). Do not attempt
to write or delete memories from here.
```

- [ ] **Step 2: Verify frontmatter is well-formed**

Run: `node -e "const m=require('gray-matter'); console.log(m(require('fs').readFileSync('src/memory-daemon/skills/nexus-memory/SKILL.md','utf8')).data)"`
Expected: prints `{ name: 'nexus-memory', description: '...', when_to_use: '...' }` with no parse error. (`gray-matter` is already a daemon dependency.)

- [ ] **Step 3: Commit**

```bash
git add src/memory-daemon/skills/nexus-memory/SKILL.md
git commit -m "feat(memory-daemon): recall-only nexus-memory behavior skill

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Setup documentation (per-CLI registration + caveats)

**Files:**
- Create: `src/memory-daemon/docs/cli-agent-memory-setup.md`

- [ ] **Step 1: Write the setup doc**

Create `src/memory-daemon/docs/cli-agent-memory-setup.md`:

```markdown
# Giving CLI agents access to Nexus memory (read-only)

CLI agents (Claude Code, OpenCode, Codex) read shared project memory through the `nexus-memory` MCP
server (`dist/src/mcp/stdio.js`), which talks to the daemon over HTTP. Build the daemon first:
`npm --prefix src/memory-daemon run build`.

## Scoping
The MCP server reads two env vars:
- `NEXUS_MEMORY_PROJECT=<project-slug>` — pins recall to that project (nexus namespace, isolated scope).
- `NEXUS_MEMORY_READONLY=1` — registers only the read tools (recall/search/get/list).

Nexus terminal threads set both automatically (scoped to the thread's project). For an external CLI
session, set them yourself, e.g. `export NEXUS_MEMORY_PROJECT=baker-internal NEXUS_MEMORY_READONLY=1`.

## Register the MCP server (one-time, per CLI)
Replace `<ABS>` with the absolute repo path.

- **Claude Code:** `claude mcp add nexus-memory -- node <ABS>/src/memory-daemon/dist/src/mcp/stdio.js`
- **OpenCode** (`~/.config/opencode/opencode.json`):
  ```json
  { "mcp": { "nexus-memory": { "type": "local", "command": ["node", "<ABS>/src/memory-daemon/dist/src/mcp/stdio.js"] } } }
  ```
- **Codex** (`~/.codex/config.toml`):
  ```toml
  [mcp_servers.nexus_memory]
  command = "node"
  args = ["<ABS>/src/memory-daemon/dist/src/mcp/stdio.js"]
  ```

## Install the behavior skill
Copy or symlink the skill so each CLI discovers it:
```bash
mkdir -p ~/.claude/skills ~/.agents/skills
ln -sf <ABS>/src/memory-daemon/skills/nexus-memory ~/.claude/skills/nexus-memory   # Claude Code + OpenCode read this
ln -sf <ABS>/src/memory-daemon/skills/nexus-memory ~/.agents/skills/nexus-memory   # Codex
```

## Caveats
- **Codex sandbox:** Codex's default `workspace-write` sandbox denies outbound network, which can block
  the MCP server's localhost call to the daemon. Grant network/approval for the daemon call (and test).
  OpenCode and Claude Code are not affected by default.
- Memory writes are intentionally disabled from CLIs in this phase (recall-only).

## Future: remote / cloud agents
Cloud-hosted agents (e.g. Claude Cloud) cannot reach a loopback stdio server. Serving them later means
adding a Streamable-HTTP transport to the same MCP server, fronted by auth (bearer/OAuth) + TLS via a
tunnel (Tailscale/Cloudflare). Not built in this phase; the server is kept transport-agnostic so it's additive.
```

- [ ] **Step 2: Commit**

```bash
git add src/memory-daemon/docs/cli-agent-memory-setup.md
git commit -m "docs(memory-daemon): CLI agent memory setup (registration + caveats)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: End-to-end verification

- [ ] **Step 1: Automated**

Run:
```bash
npm --prefix src/memory-daemon run typecheck && npm --prefix src/memory-daemon run build && npm --prefix src/memory-daemon test
npm run --workspace=src/backend typecheck && npm --workspace=src/backend test
```
Expected: daemon scope tests pass + build clean; backend suite green (incl. `pty-env`).

- [ ] **Step 2: Manual smoke (needs the daemon + model stack running)**

1. Build the daemon (Step 1) and ensure it's running (`:4100`).
2. Register the MCP for one CLI per `docs/cli-agent-memory-setup.md` (start with Claude Code) and install the skill.
3. In Nexus, open a **terminal** thread in a project that has memories; in the agent session call (or let the skill prompt) `memory_recall` for something in that project.
   - Confirm it returns **that project's** memories.
   - Confirm **write tools are absent** (`memory_store`/`memory_prune` not listed).
   - Confirm a **different** project's memories don't appear (isolation).
4. Repeat for OpenCode and Codex. For **Codex**, confirm the sandbox permits the daemon call (adjust network/approval if recall fails with a connection error).

- [ ] **Step 3: Final commit (if any stragglers)**

```bash
git add -A && git commit -m "chore: phase-4 cli-memory verification fixes"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** Component 1 env-scope + readonly (T1+T2), Component 2 per-thread env at PTY launch (T3+T4), Component 3 behavior skill (T5), Component 4 setup docs (T6), Component 5 remote path (documented in T6's doc; server kept transport-agnostic in T2). Recall-only enforced (T2 gates write tools; T4 sets READONLY). Daemon-outside-workspaces handled (all daemon commands use `npm --prefix src/memory-daemon`).
- **Type consistency:** `McpEnvDefaults` / `mcpEnvDefaults` / `mergeScope` consistent across T1–T2; `buildPtyEnv(base, extra)` consistent T3→T4; `SpawnCtx.env` added (T4) and consumed (T3 adapter) — note the cross-task dependency called out in T3 Step 5.
- **Known caveat:** Codex sandbox network (documented + tested in T6/T7). MCP tool-surface gating is verified manually (SDK lacks stable introspection); the underlying decision logic is unit-tested in T1.
- **Daemon dist:** the CLIs run `dist/src/mcp/stdio.js`, so the daemon **must be rebuilt** (T2 Step 3 / T7 Step 1) before manual testing.
```
