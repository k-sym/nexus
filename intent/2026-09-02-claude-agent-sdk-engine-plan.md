# Claude Agent SDK Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat engine pluggable and add a second engine that runs Claude models through the official Claude Agent SDK (the Claude Code harness), so a Claude Max/Pro login is used through Anthropic's own harness instead of the third-party OAuth bridge Pi uses today.

**Architecture:** Pi's event vocabulary (`AgentSessionEvent`) and Pi's `SessionManager` JSONL stay the Nexus contract: the NDJSON stream, `flattenEntries`, `usePiStream`, the iOS client, archive and the approval/question brokers are untouched. An engine is anything that can hand the chat route an `EngineSession` for a `(threadId, cwd)` that speaks that vocabulary and writes Pi-shaped entries into the thread's JSONL. The Claude engine maps SDK messages to Pi events, routes every tool call through the existing tool policy and `ApprovalBroker` via `canUseTool`, and exposes the Nexus tools (`question`, `memory_recall`, Docker, browser, Monday, helpers) to Claude as an in-process MCP server built from the same Pi extension factories. Model keys select the engine by provider prefix: `claude-code/<model>` → Claude engine, everything else → Pi.

**Tech Stack:** Node 22 / TypeScript 7, Fastify, `@anthropic-ai/claude-agent-sdk` 0.3.258 (bundles the Claude Code binary), `@earendil-works/pi-coding-agent` 0.84.x (SessionManager + event types), zod 4 (`z.fromJSONSchema` turns TypeBox tool schemas into SDK tool shapes), `node:test` via `tsx --test`.

## Global Constraints

- Backend is ESM (`"type": "module"`); source imports use `.js` suffixes; tests import without suffix (tsx).
- Tests: `npm run --workspace=src/backend test` (`tsx --test test/*.test.ts test/integration/*.test.ts`). Typecheck: `npm run --workspace=src/backend typecheck`. Build `@nexus/shared` first when its types change: `npm run --workspace=src/shared build`.
- Pin `@anthropic-ai/claude-agent-sdk` to exact `0.3.258`. Its peers (`zod ^4`, `@anthropic-ai/sdk >=0.93`, `@modelcontextprotocol/sdk ^1.29`) are installed by npm; declare `zod` explicitly in the backend because we import it.
- Do not change Pi's event vocabulary, `src/frontend/src/chat/agent-run-*.ts`, `usePiStream.ts`, or `runLabels.ts`. Those files belong to the parallel spec `2026-09-02-pi-session-chat-reliability.md`; the Claude engine emits `compaction_start/end` and `auto_retry_start/end` in Pi's shape so that spec's frontend work covers both engines.
- Claude engine provider id is exactly `claude-code`; model keys look like `claude-code/claude-opus-5`.
- Auth is subscription-first: the SDK child process gets `CLAUDE_CODE_OAUTH_TOKEN` when configured (env-referenced, never a literal in config.yaml) and otherwise inherits this machine's `claude` login. `ANTHROPIC_API_KEY` is stripped from the child env unless `engines.claude.auth` is `api_key`.
- Nexus tool names shown to users stay the Pi names (`question`, `memory_recall`, `docker_service`, …); Claude built-ins keep their Claude names (`Bash`, `Read`, `Edit`, `Write`) which `runLabels.ts` already understands. Policy and audit use the lowercase policy names (`bash`, `edit`, …).
- The glasses gateway in this repo never starts runs (glasses live in `baker-internal` on the API), so it needs no engine routing.
- Commit after every task; conventional-commit messages; `project_docs/**` is a Dropbox symlink — verify `git status` shows no phantom deletes before `git add`.

## Design decisions (read before Task 1)

1. **Pi's wire format is the contract, not a new neutral one.** Adding a neutral event model would mean adapting Pi, the frontend, iOS and archive at once. Mapping SDK → Pi events is one bounded module with fixture tests.
2. **One `query()` per turn.** Each `prompt()` spawns the SDK query with `resume: <sdk session id>`. Cost: ~1–2 s process start per turn. Follow-up (not in this plan): keep a long-lived streaming-input query per session.
3. **SDK session id lives in the thread JSONL** as a custom entry (`nexus.engine_session`). Pi's delete/tombstone/archive semantics carry it for free. `PiRuntime.readMessages` already filters it out of history.
4. **Tool gating reuses the approval path.** `decideToolCall()` is extracted from `createApprovalExtension` and called from both Pi's `tool_call` hook and the SDK's `canUseTool`.
5. **Nexus tools reach Claude over an in-process MCP server** generated from the same extension factories Pi sessions get, so a tool added for Pi is automatically available to Claude. Claude's own `AskUserQuestion` is disallowed in favour of Nexus's `question`, so the existing question UI, broker and iOS flow keep working.
6. **Tool-call ids are Claude's `tool_use_id`.** A `PreToolUse` hook records `(tool_name, tool_use_id, input)`; the MCP handler claims the matching id so `question` gates register under the id the frontend answers with.

## File structure

```
src/shared/engine-session.ts              ENGINE_SESSION_CUSTOM_TYPE + EngineSessionRecord (exported from index.ts)
src/shared/index.ts                       NexusConfig.engines block
src/backend/config.ts                     defaults for engines.claude
src/backend/fastify.d.ts                  engines: EngineRegistry
src/backend/engines/types.ts              EngineModel, EngineSession, ChatEngine, EngineId
src/backend/engines/pi-engine.ts          PiEngine adapter over PiRuntime
src/backend/engines/registry.ts           EngineRegistry (resolveModel / listModels / dropSession)
src/backend/engines/claude/models.ts      static claude-code catalog + thinking → SDK effort mapping
src/backend/engines/claude/tool-names.ts  policy/display name mapping, MCP prefix
src/backend/engines/claude/tool-use-correlator.ts
src/backend/engines/claude/pi-tools-bridge.ts   collectPiTools + buildNexusToolDefinitions + createNexusMcpServer
src/backend/engines/claude/events.ts      SdkEventMapper: SDK messages → Pi events + persisted messages
src/backend/engines/claude/auth.ts        resolveClaudeAuthEnv(config)
src/backend/engines/claude/session.ts     ClaudeEngineSession (EngineSession over query())
src/backend/engines/claude/engine.ts      ClaudeEngine (session cache, drop listener)
src/backend/pi/runtime.ts                 extensionFactoriesFor, systemPromptAppendixFor, onSessionDropped, openSessionManagerFor, audit getter
src/backend/pi/approvals.ts               decideToolCall() extracted
src/backend/routes/chat.ts                resolve model + session via engines
src/backend/routes/pi.ts                  catalog from engines
src/backend/index.ts                      build + decorate engines
src/backend/test/*.test.ts                one test file per new module (named below)
src/backend/test/live/claude-engine.test.ts  real SDK round trip, skips without auth
README.md                                 Engines section
```

---

### Task 1: Dependencies, config block, shared custom entry type

**Files:**
- Modify: `src/backend/package.json`
- Create: `src/shared/engine-session.ts`
- Modify: `src/shared/index.ts` (export + `NexusConfig.engines`)
- Modify: `src/backend/config.ts` (`defaultConfig()` engines block)
- Test: `src/backend/test/config-engines.test.ts`

**Interfaces:**
- Produces: `ENGINE_SESSION_CUSTOM_TYPE = 'nexus.engine_session'`, `EngineSessionRecord { engine: 'claude-code'; sessionId: string; recordedAt: string }`, `NexusConfig['engines']['claude']` = `{ enabled: boolean; auth: 'subscription' | 'api_key'; oauth_token: string; executable_path: string }`.

- [ ] **Step 1: Install the SDK and zod into the backend workspace**

```bash
cd /Users/k-sym/Projects/nexus && npm install --workspace=src/backend --save-exact @anthropic-ai/claude-agent-sdk@0.3.258 && npm install --workspace=src/backend zod@^4.4.3
```

Expected: `src/backend/package.json` gains `"@anthropic-ai/claude-agent-sdk": "0.3.258"` and `"zod": "^4.4.3"`; `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64` exists (bundled binary). Verify:

```bash
/bin/ls node_modules/@anthropic-ai/ | grep claude-agent-sdk && node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(typeof m.query, typeof m.createSdkMcpServer, typeof m.tool))"
```

Expected: `function function function`.

- [ ] **Step 2: Write the failing config test**

`src/backend/test/config-engines.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE_SESSION_CUSTOM_TYPE } from '@nexus/shared';
import { defaultConfigForTests } from '../config';

test('default config has a subscription-first claude engine block', () => {
  const config = defaultConfigForTests();
  assert.deepEqual(config.engines, {
    claude: {
      enabled: true,
      auth: 'subscription',
      oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}',
      executable_path: '',
    },
  });
});

test('engine session custom entry type is namespaced like the run entries', () => {
  assert.equal(ENGINE_SESSION_CUSTOM_TYPE, 'nexus.engine_session');
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/config-engines.test.ts
```

Expected: FAIL (`defaultConfigForTests` / `ENGINE_SESSION_CUSTOM_TYPE` not exported).

- [ ] **Step 4: Add the shared type file and export it**

`src/shared/engine-session.ts`:

```ts
/**
 * Session entry written by non-Pi engines into the thread's JSONL so a later
 * turn can resume the engine's own conversation. Stored beside the messages
 * (not in nexus.db) so drop/tombstone/archive semantics carry it for free.
 * `PiRuntime.readMessages` filters custom entries other than run markers, so
 * this never reaches `flattenEntries`.
 */
export const ENGINE_SESSION_CUSTOM_TYPE = 'nexus.engine_session' as const;

export interface EngineSessionRecord {
  engine: 'claude-code';
  /** The engine's own session id (for the Claude Agent SDK, the `session_id` from its `init` message). */
  sessionId: string;
  recordedAt: string;
}
```

In `src/shared/index.ts`, next to `export * from './agent-run.js';` (line 703) add:

```ts
export * from './engine-session.js';
```

- [ ] **Step 5: Add the config block to `NexusConfig`**

In `src/shared/index.ts`, inside `export interface NexusConfig` directly after the `docker: { ... };` block (the one starting at line 486), add:

```ts
  /** Chat engines beside the Pi runtime. Model keys pick the engine by provider prefix. */
  engines: {
    /**
     * Claude through the official Claude Agent SDK (the Claude Code harness).
     * This is how a Claude Pro/Max login is used inside Nexus in the way
     * Anthropic's terms permit — through Anthropic's own harness — rather than
     * a third-party OAuth bridge.
     */
    claude: {
      /** When false no `claude-code/*` model is listed. Default true. */
      enabled: boolean;
      /** `subscription` strips ANTHROPIC_API_KEY from the child process so the
       *  login is used; `api_key` leaves the environment alone. */
      auth: 'subscription' | 'api_key';
      /** Optional long-lived token from `claude setup-token` (env-referenced).
       *  Empty ⇒ the bundled Claude Code uses this machine's existing login. */
      oauth_token: string;
      /** Optional path to a Claude Code executable instead of the SDK's bundled one. */
      executable_path: string;
    };
  };
```

- [ ] **Step 6: Add defaults and a test-only accessor in `src/backend/config.ts`**

In `defaultConfig()` after the `docker: { enabled: false, },` entry add:

```ts
    engines: {
      claude: {
        enabled: true,
        auth: 'subscription',
        oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}',
        executable_path: '',
      },
    },
```

After the `defaultConfig` function add:

```ts
/** The built-in defaults, for tests that assert on shape without touching ~/.nexus. */
export function defaultConfigForTests(): NexusConfig {
  return defaultConfig();
}
```

`deepMerge` backfills the block onto existing config.yaml files, so no migration is needed.

- [ ] **Step 7: Rebuild shared, run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus && npm run --workspace=src/shared build && cd src/backend && npx tsx --test test/config-engines.test.ts && npm run typecheck
```

Expected: 2 passing; typecheck clean (every `NexusConfig` literal in tests that spreads `defaultConfig` compiles; if a test builds a full `NexusConfig` by hand, add the `engines` block to it).

- [ ] **Step 8: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git status --short && git add src/backend/package.json package-lock.json src/shared/engine-session.ts src/shared/index.ts src/backend/config.ts src/backend/test/config-engines.test.ts && git commit -m "feat(engines): add Claude Agent SDK dependency, engine config block and session entry type"
```

---

### Task 2: Engine contracts, Pi adapter and registry

**Files:**
- Create: `src/backend/engines/types.ts`
- Create: `src/backend/engines/pi-engine.ts`
- Create: `src/backend/engines/registry.ts`
- Test: `src/backend/test/engines-registry.test.ts`

**Interfaces:**
- Produces:
  - `type EngineId = 'pi' | 'claude-code'`
  - `interface EngineModel { provider: string; id: string; name: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: Array<'text' | 'image'>; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>; configured?: boolean }`
  - `type EngineSession` (the chat route's session surface, see code)
  - `interface ChatEngine { readonly id: EngineId; listModels(): EngineModel[]; findModel(provider: string, id: string): EngineModel | undefined; sessionFor(threadId: string, cwd: string): Promise<EngineSession>; hasSession(threadId: string, cwd: string): boolean; dropSession(threadId: string, cwd: string): void }`
  - `class EngineRegistry { constructor(engines: ChatEngine[]); listModels(): EngineModel[]; resolveModel(modelKey: string): { engine: ChatEngine; model: EngineModel } | undefined; get(id: EngineId): ChatEngine | undefined }`
  - `class PiEngine implements ChatEngine` wrapping `Pick<PiRuntime, 'models' | 'sessionFor' | 'hasSession' | 'dropSession'>`.

- [ ] **Step 1: Write the failing registry test**

`src/backend/test/engines-registry.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineRegistry } from '../engines/registry';
import { PiEngine } from '../engines/pi-engine';
import type { ChatEngine, EngineModel, EngineSession } from '../engines/types';

const fakeSession = { subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, setModel: async () => {} } as unknown as EngineSession;

function engine(id: 'pi' | 'claude-code', models: EngineModel[]): ChatEngine & { dropped: string[] } {
  const dropped: string[] = [];
  return {
    id,
    dropped,
    listModels: () => models,
    findModel: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    sessionFor: async () => fakeSession,
    hasSession: () => false,
    dropSession: (threadId, cwd) => { dropped.push(`${threadId}::${cwd}`); },
  };
}

test('resolveModel picks the engine whose catalog owns the provider/id', () => {
  const pi = engine('pi', [{ provider: 'openrouter', id: 'moonshotai/kimi-k2.7-code', name: 'Kimi' }]);
  const claude = engine('claude-code', [{ provider: 'claude-code', id: 'claude-opus-5', name: 'Claude Opus 5' }]);
  const registry = new EngineRegistry([pi, claude]);

  assert.equal(registry.resolveModel('claude-code/claude-opus-5')?.engine.id, 'claude-code');
  assert.equal(registry.resolveModel('openrouter/moonshotai/kimi-k2.7-code')?.engine.id, 'pi');
  assert.equal(registry.resolveModel('openrouter/moonshotai/kimi-k2.7-code')?.model.id, 'moonshotai/kimi-k2.7-code');
  assert.equal(registry.resolveModel('nope'), undefined);
  assert.equal(registry.resolveModel('claude-code/unknown'), undefined);
});

test('listModels concatenates every engine catalog in registration order', () => {
  const pi = engine('pi', [{ provider: 'openrouter', id: 'a', name: 'A' }]);
  const claude = engine('claude-code', [{ provider: 'claude-code', id: 'b', name: 'B' }]);
  assert.deepEqual(new EngineRegistry([pi, claude]).listModels().map((m) => m.id), ['a', 'b']);
});

test('PiEngine exposes the runtime catalog with configured flags from getAvailable', () => {
  const all = [
    { provider: 'openrouter', id: 'a', name: 'A', reasoning: true },
    { provider: 'anthropic', id: 'b', name: 'B' },
  ];
  const runtime = {
    models: { getAll: () => all, getAvailable: () => [all[0]], find: (p: string, id: string) => all.find((m) => m.provider === p && m.id === id) },
    sessionFor: async () => fakeSession,
    hasSession: () => true,
    dropSession: () => {},
  };
  const pi = new PiEngine(runtime as any);
  assert.deepEqual(pi.listModels().map((m) => [m.id, m.configured]), [['a', true], ['b', false]]);
  // findModel returns the runtime's own model object: Pi's setModel needs the real Model instance.
  assert.strictEqual(pi.findModel('openrouter', 'a'), all[0]);
  assert.equal(pi.id, 'pi');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/engines-registry.test.ts
```

Expected: FAIL, cannot find module `../engines/registry`.

- [ ] **Step 3: Write `src/backend/engines/types.ts`**

```ts
/**
 * Engine contracts.
 *
 * An engine produces chat sessions that speak Pi's `AgentSessionEvent`
 * vocabulary and persist Pi-shaped entries into the thread's JSONL via Pi's
 * `SessionManager`. Nothing downstream of the chat route (NDJSON stream,
 * `flattenEntries`, the frontend reducer, iOS, archive) knows which engine
 * produced a turn — that is the whole point of the seam.
 */
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '../pi/thinking.js';

export type EngineId = 'pi' | 'claude-code';

/** Wire-compatible with Pi's session events; engines must emit exactly this shape. */
export type EngineSessionEvent = AgentSessionEvent;

/** The catalog shape the models route, curation and capability resolver consume. */
export interface EngineModel {
  provider: string;
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  /** Pi's per-level override map; `getSupportedThinkingLevels` reads it. */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  /** False when the engine cannot reach this model with the current auth. */
  configured?: boolean;
}

/**
 * What the chat route needs from a session. Pi's `AgentSession` satisfies it
 * structurally; the Claude engine implements it directly. `setModel` takes the
 * engine's own model object (Pi needs its real `Model`, Claude an `EngineModel`).
 */
export type EngineSession = Pick<
  AgentSession,
  'subscribe' | 'prompt' | 'abort' | 'getContextUsage' | 'setThinkingLevel' | 'supportsThinking'
> & {
  setModel(model: any): Promise<void>;
  sessionManager?: Pick<AgentSession['sessionManager'], 'appendCustomEntry' | 'getLeafId' | 'getLeafEntry' | 'getEntries'>;
};

export interface ChatEngine {
  readonly id: EngineId;
  listModels(): EngineModel[];
  findModel(provider: string, id: string): EngineModel | undefined;
  sessionFor(threadId: string, cwd: string): Promise<EngineSession>;
  hasSession(threadId: string, cwd: string): boolean;
  dropSession(threadId: string, cwd: string): void;
}
```

- [ ] **Step 4: Write `src/backend/engines/pi-engine.ts`**

```ts
import type { PiRuntime } from '../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession } from './types.js';

type PiRuntimeSurface = Pick<PiRuntime, 'models' | 'sessionFor' | 'hasSession' | 'dropSession'>;

/** The existing Pi runtime behind the engine contract. Zero behaviour change. */
export class PiEngine implements ChatEngine {
  readonly id = 'pi' as const;

  constructor(private readonly pi: PiRuntimeSurface) {}

  listModels(): EngineModel[] {
    const available = new Set(this.pi.models.getAvailable().map((m) => `${m.provider}/${m.id}`));
    return this.pi.models.getAll().map((m) => ({
      ...(m as unknown as EngineModel),
      configured: available.has(`${m.provider}/${m.id}`),
    }));
  }

  /** Returns Pi's own `Model` object (widened): `AgentSession.setModel` needs the real instance. */
  findModel(provider: string, id: string): EngineModel | undefined {
    return this.pi.models.find(provider, id) as unknown as EngineModel | undefined;
  }

  sessionFor(threadId: string, cwd: string): Promise<EngineSession> {
    return this.pi.sessionFor(threadId, cwd) as Promise<EngineSession>;
  }

  hasSession(threadId: string, cwd: string): boolean {
    return this.pi.hasSession(threadId, cwd);
  }

  dropSession(threadId: string, cwd: string): void {
    this.pi.dropSession(threadId, cwd);
  }
}
```

- [ ] **Step 5: Write `src/backend/engines/registry.ts`**

```ts
import type { ChatEngine, EngineId, EngineModel } from './types.js';

export interface ResolvedModel {
  engine: ChatEngine;
  model: EngineModel;
}

/**
 * Owns every registered engine. Model keys are `provider/id`; the first engine
 * whose catalog knows the pair wins, so providers must not overlap (Pi's
 * `anthropic` vs the Claude engine's `claude-code` are distinct on purpose).
 */
export class EngineRegistry {
  constructor(private readonly engines: ChatEngine[]) {}

  get(id: EngineId): ChatEngine | undefined {
    return this.engines.find((engine) => engine.id === id);
  }

  listModels(): EngineModel[] {
    return this.engines.flatMap((engine) => engine.listModels());
  }

  resolveModel(modelKey: string): ResolvedModel | undefined {
    const sep = modelKey.indexOf('/');
    if (sep <= 0) return undefined;
    const provider = modelKey.slice(0, sep);
    const id = modelKey.slice(sep + 1);
    for (const engine of this.engines) {
      const model = engine.findModel(provider, id);
      if (model) return { engine, model };
    }
    return undefined;
  }
}
```

- [ ] **Step 6: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/engines-registry.test.ts && npm run typecheck
```

Expected: 3 passing; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git add src/backend/engines src/backend/test/engines-registry.test.ts && git commit -m "feat(engines): engine contract, Pi adapter and registry"
```

---

### Task 3: Expose what the Claude engine needs from `PiRuntime`

**Files:**
- Modify: `src/backend/pi/runtime.ts`
- Test: `src/backend/test/pi-runtime.test.ts` (append)

**Interfaces:**
- Produces on `PiRuntime`:
  - `extensionFactoriesFor(threadId: string, cwd: string): ExtensionFactory[]`
  - `systemPromptAppendixFor(threadId: string, cwd: string): string` (orientation block + Monday block, `\n\n`-joined, `''` when both are empty)
  - `onSessionDropped(listener: (threadId: string, cwd: string) => void): () => void` — listeners fire inside `dropSession` **before** files are removed
  - `get auditSink(): ApprovalAudit`
  - exported `openSessionManagerFor(threadId: string, cwd: string, sessionDir: string): Promise<SessionManager>` — the list/open/create logic `createSession` uses today

- [ ] **Step 1: Write the failing tests** (append to `src/backend/test/pi-runtime.test.ts`)

```ts
test('extensionFactoriesFor returns the same factory list a session is built with', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  try {
    const rt = await PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') }, {
      recallMemories: async () => ['remembered'],
    });
    const factories = rt.extensionFactoriesFor('thread-1', '/tmp/example');
    // question + approval + signal filter + memory_recall (no Monday/Docker/browser/helpers deps supplied)
    assert.equal(factories.length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('systemPromptAppendixFor includes the orientation block and the Monday block when present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  try {
    const rt = await PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') }, {
      mondayContext: () => ({ itemId: '1', itemName: 'Card', boardName: 'Board', status: 'Working on it', updates: [] } as any),
    });
    const text = rt.systemPromptAppendixFor('thread-1', '/tmp/example');
    assert.match(text, /Nexus/);
    assert.match(text, /Card/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('onSessionDropped listeners fire before the session files are removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  try {
    const paths = { authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') };
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/example';
    const session = await rt.sessionFor('thread-1', cwd);
    session.sessionManager.appendCustomEntry('probe', { ok: true });
    const seen: boolean[] = [];
    const off = rt.onSessionDropped((threadId) => {
      const files = readdirSync(rt.sessionDirFor(cwd)).filter((name) => name.endsWith(`_${threadId}.jsonl`));
      seen.push(files.length === 1);
    });
    rt.dropSession('thread-1', cwd);
    off();
    assert.deepEqual(seen, [true]);
    assert.equal(readdirSync(rt.sessionDirFor(cwd)).filter((name) => name.endsWith('_thread-1.jsonl')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Add `readdirSync` to the `node:fs` import at the top of the test file. If the Monday context input shape in `pi/monday-context.ts` differs from the literal above, read `MondayContextInput` and use its real required fields; the assertion only needs the item name to appear.

- [ ] **Step 2: Run to verify they fail**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/pi-runtime.test.ts
```

Expected: the three new tests FAIL (`extensionFactoriesFor is not a function`, …).

- [ ] **Step 3: Add the exported session-manager helper**

In `src/backend/pi/runtime.ts`, after `mostRecentlyModifiedSessionForThread`, add:

```ts
/**
 * Open the thread's most recent on-disk session, or create a new one named
 * after the thread. `SessionManager.create(cwd, dir, { id })` always starts a
 * BLANK file — it never reopens — so a naive create after a restart would
 * spawn a second `<timestamp>_<threadId>.jsonl` and lose the conversation.
 * Shared by the Pi session builder and the other engines so every engine's
 * transcript lands in the same file family.
 */
export async function openSessionManagerFor(threadId: string, cwd: string, sessionDir: string) {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  try {
    const infos = await SessionManager.list(cwd, sessionDir);
    const existing = mostRecentlyModifiedSessionForThread(infos, threadId);
    return existing
      ? SessionManager.open(existing.path, sessionDir, cwd)
      : SessionManager.create(cwd, sessionDir, { id: threadId });
  } catch {
    // Listing failed (corrupt/locked dir) — a fresh session beats a blocked turn.
    return SessionManager.create(cwd, sessionDir, { id: threadId });
  }
}
```

- [ ] **Step 4: Add the public methods to `PiRuntime`**

Add these members to the class (after `policyFor`):

```ts
  private readonly dropListeners = new Set<(threadId: string, cwd: string) => void>();

  /** Decision sink the approval path records into. Other engines gate through the same sink. */
  get auditSink(): ApprovalAudit {
    return this.approvalAudit ?? NULL_APPROVAL_AUDIT;
  }

  /**
   * The extension factories a Pi session for this thread is built with.
   * Exposed so other engines can offer the identical Nexus tool set (the
   * Claude engine turns the registered tools into an MCP server).
   */
  extensionFactoriesFor(threadId: string, cwd: string): ExtensionFactory[] {
    return buildSessionExtensionFactories(
      threadId, cwd, this.questions, this.approvals, this.policyFor(threadId, cwd),
      createSignalFilterExtension, this.recallMemories, this.mondayTools, this.dockerTools,
      this.browserTools, this.helpersTools, this.auditSink,
    );
  }

  /**
   * The Nexus-specific system prompt additions for this thread: the orientation
   * block (always) and the Monday context block (when the task has a linked
   * item). Each is guarded independently, exactly as the Pi session builder
   * treats them; an empty string means nothing to append.
   */
  systemPromptAppendixFor(threadId: string, cwd: string): string {
    const parts: string[] = [];
    try {
      parts.push(buildOrientationBlock({
        hasMemory: !!this.recallMemories,
        hasDocker: this.hasDockerFor(threadId, cwd),
        hasBrowser: this.hasBrowserFor(threadId, cwd),
        hasHelpers: this.hasHelpersFor(threadId, cwd),
        hasVision: this.hasVisionFor(threadId, cwd),
      }));
    } catch { /* orientation is a nicety; never fail a session over it */ }
    let mondayContext: MondayContextInput | null = null;
    try {
      mondayContext = this.mondayContext?.(threadId, cwd) ?? null;
    } catch {
      mondayContext = null;
    }
    if (mondayContext) {
      try {
        parts.push(buildMondayContextBlock(mondayContext));
      } catch { /* skip the Monday block, keep the rest */ }
    }
    return parts.join('\n\n');
  }

  /**
   * Observe session drops. Listeners run inside `dropSession` BEFORE the
   * on-disk files go, so an engine can still read its own session id from the
   * JSONL and clean up its side (e.g. the Claude Agent SDK transcript).
   */
  onSessionDropped(listener: (threadId: string, cwd: string) => void): () => void {
    this.dropListeners.add(listener);
    return () => { this.dropListeners.delete(listener); };
  }
```

- [ ] **Step 5: Use the helpers inside `createSession` and `dropSession`**

In `createSession`, replace the `let sessionManager; try { ... } catch { ... }` block with:

```ts
    const sessionManager = await openSessionManagerFor(threadId, cwd, sessionDir);
```

Replace the `extensionFactories: buildSessionExtensionFactories(...)` argument with:

```ts
      extensionFactories: this.extensionFactoriesFor(threadId, cwd),
```

Replace the whole `systemPromptOverride` closure (and the `resolvedMondayContext` / `mondayContext` bindings above it, which become unused) with:

```ts
      systemPromptOverride: (base: string | undefined) => {
        const appendix = this.systemPromptAppendixFor(threadId, cwd);
        return [base, appendix].filter((part) => !!part).join('\n\n');
      },
```

In `dropSession`, as the first statement after `const key = ...`, add:

```ts
    for (const listener of this.dropListeners) {
      // A listener that throws must not stop the drop.
      try { listener(threadId, cwd); } catch { /* best effort */ }
    }
```

- [ ] **Step 6: Run the full runtime test file and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/pi-runtime.test.ts && npm run typecheck
```

Expected: all passing (existing + 3 new). If the unused-variable cleanup left `MondayContextInput` unimported, keep the import (the new method uses it).

- [ ] **Step 7: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git add src/backend/pi/runtime.ts src/backend/test/pi-runtime.test.ts && git commit -m "refactor(pi): expose extension factories, prompt appendix, session opener and drop listeners for other engines"
```

---

### Task 4: Extract the tool gate so both engines share it

**Files:**
- Modify: `src/backend/pi/approvals.ts`
- Test: `src/backend/test/approvals-gate.test.ts`

**Interfaces:**
- Produces: `decideToolCall(input: GateInput): Promise<ApprovalDecision>` where
  `GateInput = { threadId: string; cwd: string; toolName: string; toolCallId: string; input: unknown; signal?: AbortSignal; broker: ApprovalBroker; policy: ToolPolicyResolver; audit?: ApprovalAudit; timeoutMs?: number }`.
  Returns `{ block: false, answeredBy? }` on allow, `{ block: true, reason, answeredBy? }` on deny. `createApprovalExtension` becomes a thin caller.

- [ ] **Step 1: Write the failing test**

`src/backend/test/approvals-gate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalBroker, decideToolCall } from '../pi/approvals';
import { createToolPolicyResolver } from '../pi/tool-policy';
import type { ToolDecisionRecord } from '../approvals/audit';

function recorder() {
  const records: ToolDecisionRecord[] = [];
  return { records, audit: { record: (r: ToolDecisionRecord) => { records.push(r); } } };
}

test('decideToolCall allows read-only tools without touching the broker and records nothing', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const decision = await decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'read', toolCallId: 'c1', input: { path: 'a.ts' },
    broker, policy: createToolPolicyResolver(), audit,
  });
  assert.deepEqual(decision, { block: false });
  assert.equal(broker.pendingCount('t'), 0);
  assert.equal(records.length, 0);
});

test('decideToolCall denies outright when the policy says deny', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const policy = createToolPolicyResolver({ categoryPolicy: () => ({ exec: 'deny' }) });
  const decision = await decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'bash', toolCallId: 'c2', input: { command: 'rm -rf /' },
    broker, policy, audit,
  });
  assert.equal(decision.block, true);
  assert.match(decision.reason ?? '', /Blocked by policy/);
  assert.equal(records[0]?.outcome, 'denied');
  assert.equal(records[0]?.answeredBy, 'policy');
});

test('decideToolCall parks confirm decisions on the broker and records how they settled', async () => {
  const broker = new ApprovalBroker();
  const { records, audit } = recorder();
  const policy = createToolPolicyResolver({ isSupervised: () => true });
  const pending = decideToolCall({
    threadId: 't', cwd: '/repo', toolName: 'bash', toolCallId: 'c3', input: { command: 'ls' },
    broker, policy, audit, timeoutMs: 5_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(broker.pendingCount('t'), 1);
  broker.decide('t', 'c3', 'allow');
  const decision = await pending;
  assert.equal(decision.block, false);
  assert.equal(decision.answeredBy, 'human');
  assert.equal(records[0]?.outcome, 'allowed');
  assert.equal(records[0]?.answeredBy, 'human');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/approvals-gate.test.ts
```

Expected: FAIL, `decideToolCall` is not exported.

- [ ] **Step 3: Extract the gate**

In `src/backend/pi/approvals.ts`, add before `createApprovalExtension`:

```ts
export interface GateInput {
  threadId: string;
  cwd: string;
  /** The POLICY name (Pi's lowercase names: `bash`, `edit`, …). */
  toolName: string;
  toolCallId: string;
  input: unknown;
  signal?: AbortSignal;
  broker: ApprovalBroker;
  policy: ToolPolicyResolver;
  audit?: ApprovalAudit;
  /** Tests pin this; production omits it so gates follow client presence. */
  timeoutMs?: number;
}

/**
 * The tool gate, engine-agnostic. Pi calls it from its `tool_call` hook; the
 * Claude engine calls it from the SDK's `canUseTool`. Both get identical
 * policy resolution, broker parking and audit rows.
 *
 *   - `allow`   → `{ block: false }`. Pays nothing beyond the resolver.
 *   - `confirm` → park on the broker and await a human decision.
 *   - `deny`    → block immediately; no gate registered, nothing waits.
 */
export async function decideToolCall(gate: GateInput): Promise<ApprovalDecision> {
  const audit = gate.audit ?? NULL_APPROVAL_AUDIT;
  const request = { toolName: gate.toolName, input: gate.input };
  // resolveToolDecision owns the fail-closed behaviour: a resolver that throws
  // or returns nonsense degrades to `confirm` for side-effectful tools.
  const decision = resolveToolDecision(gate.policy, request);

  let trace;
  try { trace = gate.policy.explain?.(request); } catch { trace = undefined; }

  const base = {
    threadId: gate.threadId,
    cwd: gate.cwd,
    toolName: gate.toolName,
    category: categorizeTool(gate.toolName),
    inputSummary: summarizeToolInput(gate.input),
    decision,
    source: trace?.source ?? 'default',
    ...(trace?.rule?.tool ? { ruleTool: trace.rule.tool } : {}),
    ...(trace?.rule?.when ? { ruleWhen: trace.rule.when } : {}),
  } satisfies Omit<ToolDecisionRecord, 'outcome' | 'answeredBy'>;

  // A plain allow of a read-only tool with no rule is not worth a row.
  const worthRecording = decision !== 'allow' || trace?.source === 'rule' || isSideEffectful(gate.toolName);

  if (decision === 'allow') {
    if (worthRecording) audit.record({ ...base, outcome: 'allowed', answeredBy: 'policy' });
    return { block: false };
  }
  if (decision === 'deny') {
    audit.record({ ...base, outcome: 'denied', answeredBy: 'policy' });
    return { block: true, reason: `Blocked by policy: \`${gate.toolName}\` is not permitted in this session.` };
  }

  const result = await gate.broker.register(
    gate.threadId, gate.toolCallId, gate.toolName, gate.input, gate.cwd, gate.signal, gate.timeoutMs,
  );
  audit.record({
    ...base,
    outcome: result.block ? 'denied' : 'allowed',
    answeredBy: result.answeredBy ?? 'human',
  });
  return result;
}
```

Replace the body of `createApprovalExtension` with:

```ts
  return (pi) => {
    pi.on('tool_call', async (event, ctx) => {
      const decision = await decideToolCall({
        threadId, cwd, toolName: event.toolName, toolCallId: event.toolCallId, input: event.input,
        signal: ctx.signal, broker, policy, audit, timeoutMs,
      });
      // `allow` is "no opinion" to Pi's hook: return undefined so the tool runs.
      return decision.block ? decision : undefined;
    });
  };
```

- [ ] **Step 4: Run the gate test plus every existing approval test**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/approvals-gate.test.ts test/approvals*.test.ts test/tool-policy*.test.ts test/routes-trust.test.ts && npm run typecheck
```

Expected: all passing. The existing extension tests exercise the same paths through the thin wrapper.

- [ ] **Step 5: Commit**

```bash
git add src/backend/pi/approvals.ts src/backend/test/approvals-gate.test.ts && git commit -m "refactor(approvals): extract decideToolCall for engine-agnostic gating"
```

---

### Task 5: Claude model catalog and thinking mapping

**Files:**
- Create: `src/backend/engines/claude/models.ts`
- Test: `src/backend/test/claude-models.test.ts`

**Interfaces:**
- Produces: `CLAUDE_CODE_PROVIDER = 'claude-code'`, `CLAUDE_CODE_MODELS: EngineModel[]`, `findClaudeModel(id: string): EngineModel | undefined`, `toSdkThinking(model: EngineModel, level: ThinkingLevel | undefined): { effort?: 'low'|'medium'|'high'|'xhigh'|'max'; thinking?: { type: 'disabled' } }`, `contextWindowFor(model: EngineModel): number`.

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-models.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel, toSdkThinking } from '../engines/claude/models';
import { capabilitiesFromModel } from '../pi/model-capabilities';

test('every catalog model is claude-code, vision-capable and keyed by its SDK id', () => {
  for (const model of CLAUDE_CODE_MODELS) {
    assert.equal(model.provider, CLAUDE_CODE_PROVIDER);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.match(model.id, /^claude-/);
  }
  assert.ok(findClaudeModel('claude-opus-5'));
  assert.equal(findClaudeModel('gpt-5'), undefined);
});

test('capability resolver derives Nexus thinking levels from the catalog', () => {
  const opus = capabilitiesFromModel(findClaudeModel('claude-opus-5')!);
  assert.deepEqual(opus.reasoning.levels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opus.imageInput, 'supported');
  const fable = capabilitiesFromModel(findClaudeModel('claude-fable-5-1')!);
  assert.equal(fable.reasoning.mandatory, true);
  assert.ok(!fable.reasoning.levels.includes('off'));
  const haiku = capabilitiesFromModel(findClaudeModel('claude-haiku-4-5')!);
  assert.equal(haiku.reasoning.supported, false);
});

test('toSdkThinking maps Nexus levels onto SDK effort and disabled-thinking', () => {
  const opus = findClaudeModel('claude-opus-5')!;
  const fable = findClaudeModel('claude-fable-5-1')!;
  assert.deepEqual(toSdkThinking(opus, undefined), {});
  assert.deepEqual(toSdkThinking(opus, 'minimal'), { effort: 'low' });
  assert.deepEqual(toSdkThinking(opus, 'xhigh'), { effort: 'xhigh' });
  assert.deepEqual(toSdkThinking(opus, 'off'), { thinking: { type: 'disabled' } });
  // Fable rejects disabled thinking (400): "off" degrades to the lowest effort.
  assert.deepEqual(toSdkThinking(fable, 'off'), { effort: 'low' });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-models.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/models.ts`**

```ts
/**
 * Static catalog for the Claude engine. The SDK accepts any model id the
 * account can reach, so this list is what the picker offers, not a hard limit;
 * `setModel` passes ids through unchanged.
 *
 * `thinkingLevelMap` drives Pi's `getSupportedThinkingLevels`, which the
 * capability resolver already uses for every other catalog entry:
 *   - `off: null` removes "off" (thinking is always on for Fable);
 *   - `xhigh`/`max` must be present (non-undefined) to be offered.
 */
import type { EngineModel } from '../types.js';
import type { ThinkingLevel } from '../../pi/thinking.js';

export const CLAUDE_CODE_PROVIDER = 'claude-code';

export type SdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const FULL_EFFORT = { xhigh: 'xhigh', max: 'max' } as const;
const ALWAYS_ON = { off: null, xhigh: 'xhigh', max: 'max' } as const;

export const CLAUDE_CODE_MODELS: EngineModel[] = [
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-fable-5-1', name: 'Claude Fable 5.1', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: ALWAYS_ON },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  // Haiku 4.5 uses budget-based thinking the SDK manages itself; Nexus offers no level.
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'] },
];

export function findClaudeModel(id: string): EngineModel | undefined {
  return CLAUDE_CODE_MODELS.find((model) => model.id === id);
}

export function contextWindowFor(model: EngineModel): number {
  return model.contextWindow ?? 200_000;
}

/**
 * Nexus thinking level → SDK request options. `undefined` = leave the SDK's
 * adaptive default alone. `minimal` has no SDK equivalent and becomes `low`.
 * `off` becomes `{ thinking: { type: 'disabled' } }` except on models whose
 * `thinkingLevelMap.off === null` (Fable: disabled thinking is a 400).
 */
export function toSdkThinking(
  model: EngineModel,
  level: ThinkingLevel | undefined,
): { effort?: SdkEffort; thinking?: { type: 'disabled' } } {
  if (level === undefined || model.reasoning !== true) return {};
  if (level === 'off') {
    return model.thinkingLevelMap?.off === null ? { effort: 'low' } : { thinking: { type: 'disabled' } };
  }
  if (level === 'minimal') return { effort: 'low' };
  return { effort: level };
}
```

- [ ] **Step 4: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-models.test.ts && npm run typecheck
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git add src/backend/engines/claude/models.ts src/backend/test/claude-models.test.ts && git commit -m "feat(engines): claude-code model catalog and thinking mapping"
```

---

### Task 6: Tool-name mapping

**Files:**
- Create: `src/backend/engines/claude/tool-names.ts`
- Test: `src/backend/test/claude-tool-names.test.ts`

**Interfaces:**
- Produces: `NEXUS_MCP_SERVER = 'nexus'`, `NEXUS_MCP_PREFIX = 'mcp__nexus__'`, `toPolicyToolName(claudeName: string): string`, `toDisplayToolName(claudeName: string): string`, `toClaudeToolName(nexusName: string): string`.

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-tool-names.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEXUS_MCP_PREFIX, toClaudeToolName, toDisplayToolName, toPolicyToolName } from '../engines/claude/tool-names';

test('policy names are Pi lowercase names for built-ins and bare names for Nexus MCP tools', () => {
  assert.equal(toPolicyToolName('Bash'), 'bash');
  assert.equal(toPolicyToolName('Edit'), 'edit');
  assert.equal(toPolicyToolName('MultiEdit'), 'edit');
  assert.equal(toPolicyToolName('Write'), 'write');
  assert.equal(toPolicyToolName('Read'), 'read');
  assert.equal(toPolicyToolName('Grep'), 'grep');
  assert.equal(toPolicyToolName('Glob'), 'find');
  assert.equal(toPolicyToolName('WebSearch'), 'web_search');
  assert.equal(toPolicyToolName('mcp__nexus__question'), 'question');
  assert.equal(toPolicyToolName('mcp__nexus__docker_service'), 'docker_service');
  // Unknown built-ins and foreign MCP tools pass through (policy treats them as `unknown`).
  assert.equal(toPolicyToolName('Task'), 'Task');
  assert.equal(toPolicyToolName('mcp__other__thing'), 'mcp__other__thing');
});

test('display names keep Claude built-ins and strip only the Nexus MCP prefix', () => {
  assert.equal(toDisplayToolName('Bash'), 'Bash');
  assert.equal(toDisplayToolName('mcp__nexus__question'), 'question');
  assert.equal(toDisplayToolName('mcp__other__thing'), 'mcp__other__thing');
});

test('toClaudeToolName round-trips a Nexus tool name', () => {
  assert.equal(toClaudeToolName('question'), `${NEXUS_MCP_PREFIX}question`);
  assert.equal(toDisplayToolName(toClaudeToolName('memory_recall')), 'memory_recall');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-tool-names.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/tool-names.ts`**

```ts
/**
 * Three name spaces meet in the Claude engine:
 *   - Claude's tool names (`Bash`, `Edit`, `mcp__nexus__question`) — what the
 *     SDK reports and what `canUseTool` receives;
 *   - policy names (`bash`, `edit`, `question`) — Pi's lowercase names, which
 *     `tool-policy.ts` classifies and the audit trail records;
 *   - display names — what the transcript and the frontend see. Built-ins keep
 *     Claude's names (`runLabels.ts` already knows `Bash`/`Read`/`Edit`/`Write`);
 *     Nexus tools drop the MCP prefix so `question`, `memory_recall`, … render
 *     exactly as they do for Pi sessions.
 */
export const NEXUS_MCP_SERVER = 'nexus';
export const NEXUS_MCP_PREFIX = `mcp__${NEXUS_MCP_SERVER}__`;

const BUILTIN_TO_POLICY: Readonly<Record<string, string>> = {
  Bash: 'bash',
  KillShell: 'bash',
  BashOutput: 'read',
  Read: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'write',
  NotebookEdit: 'write',
  Grep: 'grep',
  Glob: 'find',
  LS: 'ls',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
};

export function toDisplayToolName(claudeName: string): string {
  return claudeName.startsWith(NEXUS_MCP_PREFIX) ? claudeName.slice(NEXUS_MCP_PREFIX.length) : claudeName;
}

export function toPolicyToolName(claudeName: string): string {
  if (claudeName.startsWith(NEXUS_MCP_PREFIX)) return claudeName.slice(NEXUS_MCP_PREFIX.length);
  return BUILTIN_TO_POLICY[claudeName] ?? claudeName;
}

export function toClaudeToolName(nexusName: string): string {
  return `${NEXUS_MCP_PREFIX}${nexusName}`;
}
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-tool-names.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git add src/backend/engines/claude/tool-names.ts src/backend/test/claude-tool-names.test.ts && git commit -m "feat(engines): claude tool-name mapping for policy and display"
```

---

### Task 7: Tool-use correlator

**Files:**
- Create: `src/backend/engines/claude/tool-use-correlator.ts`
- Test: `src/backend/test/claude-tool-use-correlator.test.ts`

**Interfaces:**
- Produces: `class ToolUseCorrelator { remember(toolName: string, toolUseId: string, input: unknown): void; claim(toolName: string, input: unknown): string | undefined; clear(): void }`.

Why it exists: the SDK's `PreToolUse` hook sees `tool_use_id` + input; the in-process MCP handler sees only the arguments. Nexus's `question` tool registers its gate under a tool-call id the frontend later answers with, so the handler must run under Claude's `tool_use_id`.

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-tool-use-correlator.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolUseCorrelator } from '../engines/claude/tool-use-correlator';

test('claim returns the id whose input matches, then removes it', () => {
  const c = new ToolUseCorrelator();
  c.remember('mcp__nexus__question', 'toolu_1', { questions: [{ id: 'a' }] });
  c.remember('mcp__nexus__question', 'toolu_2', { questions: [{ id: 'b' }] });
  assert.equal(c.claim('mcp__nexus__question', { questions: [{ id: 'b' }] }), 'toolu_2');
  assert.equal(c.claim('mcp__nexus__question', { questions: [{ id: 'b' }] }), 'toolu_1'); // FIFO fallback
  assert.equal(c.claim('mcp__nexus__question', {}), undefined);
});

test('claim is scoped by tool name and clear drops everything', () => {
  const c = new ToolUseCorrelator();
  c.remember('mcp__nexus__memory_recall', 'toolu_9', { query: 'x' });
  assert.equal(c.claim('mcp__nexus__question', { query: 'x' }), undefined);
  c.clear();
  assert.equal(c.claim('mcp__nexus__memory_recall', { query: 'x' }), undefined);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-tool-use-correlator.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/tool-use-correlator.ts`**

```ts
/**
 * Pairs Claude `tool_use_id`s (seen by the PreToolUse hook) with in-process
 * MCP invocations (which see only the arguments). Exact-input match first,
 * FIFO per tool name as the fallback for identical parallel calls.
 */
export class ToolUseCorrelator {
  private readonly queues = new Map<string, Array<{ id: string; key: string }>>();

  remember(toolName: string, toolUseId: string, input: unknown): void {
    const queue = this.queues.get(toolName) ?? [];
    queue.push({ id: toolUseId, key: stableKey(input) });
    this.queues.set(toolName, queue);
  }

  claim(toolName: string, input: unknown): string | undefined {
    const queue = this.queues.get(toolName);
    if (!queue || queue.length === 0) return undefined;
    const key = stableKey(input);
    const index = queue.findIndex((entry) => entry.key === key);
    const [entry] = queue.splice(index >= 0 ? index : 0, 1);
    return entry?.id;
  }

  clear(): void {
    this.queues.clear();
  }
}

function stableKey(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v));
  } catch {
    return String(value);
  }
}
```

- [ ] **Step 4: Run the test**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-tool-use-correlator.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
cd /Users/k-sym/Projects/nexus && git add src/backend/engines/claude/tool-use-correlator.ts src/backend/test/claude-tool-use-correlator.test.ts && git commit -m "feat(engines): correlate Claude tool_use ids with in-process MCP calls"
```

---

### Task 8: Pi tools → in-process MCP server

**Files:**
- Create: `src/backend/engines/claude/pi-tools-bridge.ts`
- Test: `src/backend/test/claude-pi-tools-bridge.test.ts`

**Interfaces:**
- Consumes: `ToolUseCorrelator` (Task 7), `NEXUS_MCP_SERVER` / `toClaudeToolName` (Task 6), Pi `ExtensionFactory` / `ToolDefinition`.
- Produces:
  - `type PiToolDefinition = ToolDefinition<any, any, any>`
  - `collectPiTools(factories: ExtensionFactory[]): Promise<PiToolDefinition[]>`
  - `interface BridgeContext { cwd: string; correlator: ToolUseCorrelator; signal: () => AbortSignal | undefined; onUpdate: (toolCallId: string, toolName: string, partial: AgentToolResult<unknown>) => void; onDetails: (toolCallId: string, details: unknown) => void }`
  - `zodShapeFor(schema: unknown): z.ZodRawShape`
  - `buildNexusToolDefinitions(tools: PiToolDefinition[], ctx: BridgeContext): SdkMcpToolDefinition[]`
  - `createNexusMcpServer(tools: PiToolDefinition[], ctx: BridgeContext): McpSdkServerConfigWithInstance`

Note: none of the Nexus tools read the `ctx: ExtensionContext` argument of `execute` (verified: `grep -n "ctx\." src/backend/pi/{docker,browser,monday,helpers}-tool.ts` is empty), so a stub context is enough.

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-pi-tools-bridge.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { buildNexusToolDefinitions, collectPiTools, zodShapeFor } from '../engines/claude/pi-tools-bridge';
import { ToolUseCorrelator } from '../engines/claude/tool-use-correlator';
import { createQuestionExtension, QuestionBroker } from '../pi/questions';
import { createMemoryExtension } from '../pi/memory-tool';
import { ApprovalBroker, createApprovalExtension } from '../pi/approvals';
import type { ToolPolicyResolver } from '../pi/tool-policy';

const allowAll: ToolPolicyResolver = () => 'allow';

function context(overrides: Partial<Parameters<typeof buildNexusToolDefinitions>[1]> = {}) {
  return {
    cwd: '/repo',
    correlator: new ToolUseCorrelator(),
    signal: () => undefined,
    onUpdate: () => {},
    onDetails: () => {},
    ...overrides,
  };
}

test('collectPiTools keeps registerTool() calls and ignores hook-only factories', async () => {
  const tools = await collectPiTools([
    createQuestionExtension('t', new QuestionBroker()),
    createApprovalExtension('t', '/repo', new ApprovalBroker(), allowAll),
    createMemoryExtension('/repo', async () => ['m1', 'm2']),
  ]);
  assert.deepEqual(tools.map((t) => t.name), ['question', 'memory_recall']);
});

test('zodShapeFor turns a TypeBox object schema into a zod raw shape that validates', () => {
  const shape = zodShapeFor(Type.Object({
    query: Type.String({ description: 'q' }),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }));
  assert.deepEqual(Object.keys(shape), ['query', 'limit']);
  assert.equal(shape.query.safeParse('x').success, true);
  assert.equal(shape.limit.safeParse(undefined).success, true);
  assert.equal(shape.limit.safeParse(0).success, false);
  assert.throws(() => zodShapeFor(Type.String()), /object schema/);
});

test('bridged handler runs the Pi tool under the correlated tool_use id and side-channels details', async () => {
  const tools = await collectPiTools([createMemoryExtension('/repo', async () => ['m1', 'm2'])]);
  const details: Array<[string, unknown]> = [];
  const ctx = context({ onDetails: (id, d) => { details.push([id, d]); } });
  ctx.correlator.remember('mcp__nexus__memory_recall', 'toolu_7', { query: 'x' });
  const [def] = buildNexusToolDefinitions(tools, ctx);
  assert.equal(def.name, 'memory_recall');
  const result = await def.handler({ query: 'x' } as any, {});
  assert.deepEqual(result.content, [{ type: 'text', text: '- m1\n- m2' }]);
  assert.equal(result.isError, false);
  assert.deepEqual(details, [['toolu_7', { status: 'ok', query: 'x', count: 2 }]]);
});

test('a throwing Pi tool becomes an MCP error result instead of a crash', async () => {
  const tools = await collectPiTools([createMemoryExtension('/repo', async () => { throw new Error('daemon down'); })]);
  const [def] = buildNexusToolDefinitions(tools, context());
  const result = await def.handler({ query: 'x' } as any, {});
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'daemon down' }]);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-pi-tools-bridge.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/pi-tools-bridge.ts`**

```ts
/**
 * Turns the Nexus tools a Pi session would get into an in-process MCP server
 * for the Claude Agent SDK. Same extension factories, same `execute`
 * functions, same brokers — so `question`, `memory_recall`, Docker, browser,
 * Monday and the API helpers behave identically under both engines and a
 * tool added for Pi shows up for Claude with no extra work.
 *
 * TypeBox schemas are JSON Schema; `z.fromJSONSchema` (zod 4) turns them into
 * the zod raw shape the SDK's `tool()` wants, so the model sees the same
 * parameter descriptions Pi advertises.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentToolResult, ExtensionContext, ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { NEXUS_MCP_SERVER, toClaudeToolName } from './tool-names.js';
import type { ToolUseCorrelator } from './tool-use-correlator.js';

export type PiToolDefinition = ToolDefinition<any, any, any>;

export interface BridgeContext {
  cwd: string;
  correlator: ToolUseCorrelator;
  /** The current turn's abort signal, read per call so a session can outlive a turn. */
  signal: () => AbortSignal | undefined;
  onUpdate: (toolCallId: string, toolName: string, partial: AgentToolResult<unknown>) => void;
  /** Pi tools return structured `details` beside text; MCP only carries the text
   *  back through Claude, so details travel on this side channel. */
  onDetails: (toolCallId: string, details: unknown) => void;
}

/** A callable proxy whose every property is itself: absorbs `pi.on(...)`,
 *  `pi.registerCommand(...)`, `pi.ui.notify(...)` and any nested access. */
function absorbAll(onRegisterTool?: (def: PiToolDefinition) => void): any {
  const proxy: any = new Proxy(function noop() {}, {
    get: (_target, prop) => (prop === 'registerTool' && onRegisterTool ? onRegisterTool : proxy),
    apply: () => undefined,
  });
  return proxy;
}

/**
 * Run each factory against a recorder that keeps `registerTool()` calls and
 * ignores everything else. A factory that throws costs its own tools only.
 */
export async function collectPiTools(factories: ExtensionFactory[]): Promise<PiToolDefinition[]> {
  const tools: PiToolDefinition[] = [];
  const recorder = absorbAll((def) => { tools.push(def); });
  for (const factory of factories) {
    try {
      await factory(recorder);
    } catch {
      /* a factory that needs the real runtime costs its tools, not the session */
    }
  }
  return tools;
}

export function zodShapeFor(schema: unknown): z.ZodRawShape {
  // TypeBox schemas carry symbol-keyed metadata; a JSON round trip leaves plain JSON Schema.
  const plain = JSON.parse(JSON.stringify(schema));
  const parsed = z.fromJSONSchema(plain);
  if (!(parsed instanceof z.ZodObject)) throw new Error('tool parameters must be an object schema');
  return parsed.shape as z.ZodRawShape;
}

function extensionContextStub(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, ui: absorbAll() } as unknown as ExtensionContext;
}

function toMcpContent(content: AgentToolResult<unknown>['content']) {
  return content.map((block) => block.type === 'image'
    ? { type: 'image' as const, data: block.data, mimeType: block.mimeType }
    : { type: 'text' as const, text: block.text });
}

export function buildNexusToolDefinitions(tools: PiToolDefinition[], ctx: BridgeContext): SdkMcpToolDefinition[] {
  return tools.map((def) => tool(def.name, def.description, zodShapeFor(def.parameters), async (args) => {
    const toolCallId = ctx.correlator.claim(toClaudeToolName(def.name), args) ?? `nexus-${randomUUID()}`;
    try {
      const result = await def.execute(
        toolCallId,
        args as any,
        ctx.signal(),
        (partial) => ctx.onUpdate(toolCallId, def.name, partial),
        extensionContextStub(ctx.cwd),
      );
      if (result.details !== undefined) ctx.onDetails(toolCallId, result.details);
      return {
        content: toMcpContent(result.content),
        isError: (result as { isError?: boolean }).isError === true,
      };
    } catch (err: any) {
      // Pi's loop turns a throw into an error tool result; do the same for MCP.
      return { content: [{ type: 'text' as const, text: err?.message || String(err) }], isError: true };
    }
  }));
}

export function createNexusMcpServer(tools: PiToolDefinition[], ctx: BridgeContext): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: NEXUS_MCP_SERVER,
    version: '1.0.0',
    tools: buildNexusToolDefinitions(tools, ctx),
  });
}
```

If `parsed.shape as z.ZodRawShape` fails typecheck under zod 4.4's types, use `parsed.shape as unknown as z.ZodRawShape`; if `SdkMcpToolDefinition` is not exported by the installed SDK build, type the return as `ReturnType<typeof tool>[]`.

- [ ] **Step 4: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-pi-tools-bridge.test.ts && npm run typecheck
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engines/claude/pi-tools-bridge.ts src/backend/test/claude-pi-tools-bridge.test.ts && git commit -m "feat(engines): bridge Pi extension tools into an in-process MCP server"
```

---

### Task 9: SDK message → Pi event mapper

**Files:**
- Create: `src/backend/engines/claude/events.ts`
- Test: `src/backend/test/claude-events.test.ts`

**Interfaces:**
- Consumes: `toDisplayToolName` (Task 6), Pi message types from `@earendil-works/pi-ai`, `ContextUsage` from pi-coding-agent, SDK message types.
- Produces:
  - `interface MapperSinks { provider: string; model: string; emit(event: EngineSessionEvent): void; persist(message: AssistantMessage | ToolResultMessage): void; detailsFor(toolCallId: string): unknown; onSessionId(sessionId: string, apiKeySource: string): void; onContextUsage(usage: ContextUsage): void; now?: () => number }`
  - `class SdkEventMapper { constructor(sinks: MapperSinks); handle(msg: SDKMessage): void; abort(reason?: string): void; fail(message: string): void; finish(): { ok: boolean; error?: string } }`

Event contract (Pi vocabulary — see `AgentSessionEvent` in `node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts` and `AssistantMessageEvent` in `pi-ai/dist/types.d.ts`):

| SDK message | Emitted Pi events | Persisted |
| --- | --- | --- |
| `system/init` | — (`onSessionId`) | — |
| `stream_event` `message_start` | `message_start`, `message_update{start}` | — |
| `stream_event` `content_block_start/delta/stop` | `message_update{text_*, thinking_*, toolcall_*}` | — |
| `assistant` (top-level only) | `message_update{done|error}`, `message_end`, then `tool_execution_start` per tool call | AssistantMessage |
| `user` with `tool_result` blocks | `tool_execution_end` per block | ToolResultMessage |
| `system/status` compacting → idle | `compaction_start` … `compaction_end` | — |
| `system/compact_boundary` | `compaction_end` if still compacting | — |
| `system/api_retry` | `auto_retry_start`; next output → `auto_retry_end{success:true}` | — |
| `result` error without an error message already shown | `message_update{error}`, `message_end` (synthetic) | AssistantMessage (error) |
| `abort()` mid-message | `message_update{error, reason:'aborted'}`, `message_end` | partial AssistantMessage |

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-events.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SdkEventMapper, type MapperSinks } from '../engines/claude/events';

function harness() {
  const events: any[] = [];
  const persisted: any[] = [];
  const sessionIds: string[] = [];
  const usage: any[] = [];
  const sinks: MapperSinks = {
    provider: 'claude-code',
    model: 'claude-opus-5',
    emit: (ev) => { events.push(ev); },
    persist: (m) => { persisted.push(m); },
    detailsFor: (id) => (id === 'toolu_q' ? { status: 'answered' } : undefined),
    onSessionId: (id) => { sessionIds.push(id); },
    onContextUsage: (u) => { usage.push(u); },
    now: () => 1_000,
  };
  return { mapper: new SdkEventMapper(sinks), events, persisted, sessionIds, usage };
}

const base = { uuid: 'u', session_id: 'sess-1' };
const stream = (event: any) => ({ type: 'stream_event', event, parent_tool_use_id: null, ...base });
const assistant = (content: any[], stop_reason = 'end_turn', extra: any = {}) => ({
  type: 'assistant', parent_tool_use_id: null, ...base, ...extra,
  message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } },
});

test('init records the session id', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base } as any);
  assert.deepEqual(h.sessionIds, ['sess-1']);
});

test('a streamed text turn emits deltas then one message_end and persists the assistant message', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_stop', index: 0 }) as any);
  h.mapper.handle(assistant([{ type: 'text', text: 'Hello' }]) as any);

  const types = h.events.map((e) => e.type === 'message_update' ? `update:${e.assistantMessageEvent.type}` : e.type);
  assert.deepEqual(types, ['message_start', 'update:start', 'update:text_start', 'update:text_delta', 'update:text_delta', 'update:text_end', 'update:done', 'message_end']);
  assert.equal(h.events.at(-1).message.content[0].text, 'Hello');
  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].role, 'assistant');
  assert.equal(h.persisted[0].stopReason, 'stop');
  assert.equal(h.persisted[0].provider, 'claude-code');
  assert.deepEqual(h.persisted[0].usage.input, 10);
  assert.deepEqual(h.persisted[0].usage.cacheRead, 3);
});

test('a tool turn emits toolcall events, tool_execution_start/end with display names and side-channel details', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_q', name: 'mcp__nexus__question', input: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"questions":' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '[]}' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_stop', index: 0 }) as any);
  h.mapper.handle(assistant([{ type: 'tool_use', id: 'toolu_q', name: 'mcp__nexus__question', input: { questions: [] } }], 'tool_use') as any);
  h.mapper.handle({ type: 'user', parent_tool_use_id: null, ...base, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_q', content: [{ type: 'text', text: 'Scope: Small' }], is_error: false },
  ] } } as any);

  const end = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'toolcall_end');
  assert.deepEqual(end.assistantMessageEvent.toolCall, { type: 'toolCall', id: 'toolu_q', name: 'question', arguments: { questions: [] } });
  const start = h.events.find((e) => e.type === 'tool_execution_start');
  assert.deepEqual(start, { type: 'tool_execution_start', toolCallId: 'toolu_q', toolName: 'question', args: { questions: [] } });
  const done = h.events.find((e) => e.type === 'tool_execution_end');
  assert.equal(done.toolName, 'question');
  assert.equal(done.isError, false);
  assert.deepEqual(done.result.details, { status: 'answered' });
  assert.equal(h.persisted[0].content[0].name, 'question');
  assert.equal(h.persisted[1].role, 'toolResult');
  assert.deepEqual(h.persisted[1].details, { status: 'answered' });
});

test('subagent messages (parent_tool_use_id set) are ignored', () => {
  const h = harness();
  h.mapper.handle({ ...assistant([{ type: 'text', text: 'inner' }]), parent_tool_use_id: 'toolu_task' } as any);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.persisted, []);
});

test('api_retry maps to auto_retry_start and the next output closes it', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3, retry_delay_ms: 4000, error_status: 529, error: 'overloaded', ...base } as any);
  h.mapper.handle(assistant([{ type: 'text', text: 'ok' }]) as any);
  assert.deepEqual(h.events[0], { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 4000, errorMessage: 'overloaded (HTTP 529)' });
  assert.deepEqual(h.events[1], { type: 'auto_retry_end', success: true, attempt: 2 });
});

test('compaction status and boundary map to compaction_start/end exactly once', () => {
  const h = harness();
  h.mapper.handle({ type: 'system', subtype: 'status', status: 'compacting', ...base } as any);
  h.mapper.handle({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 }, ...base } as any);
  h.mapper.handle({ type: 'system', subtype: 'status', status: null, compact_result: 'success', ...base } as any);
  assert.deepEqual(h.events.map((e) => e.type), ['compaction_start', 'compaction_end']);
  assert.equal(h.events[0].reason, 'threshold');
});

test('an assistant error surfaces as an error message end and result does not double-report', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'Invalid API key' }], 'end_turn', { error: 'authentication_failed' }) as any);
  h.mapper.handle({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  const ends = h.events.filter((e) => e.type === 'message_end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].message.stopReason, 'error');
  assert.match(ends[0].message.errorMessage, /authentication_failed/);
  assert.deepEqual(h.mapper.finish(), { ok: false, error: 'error_during_execution' });
});

test('a failed result with no prior message synthesises an error message', () => {
  const h = harness();
  h.mapper.handle({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 5, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null, ...base } as any);
  assert.equal(h.events.at(-1).type, 'message_end');
  assert.equal(h.persisted[0].stopReason, 'error');
  assert.equal(h.persisted[0].errorMessage, 'error_max_turns');
});

test('abort mid-message persists the partial with stopReason aborted', () => {
  const h = harness();
  h.mapper.handle(stream({ type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } }) as any);
  h.mapper.handle(stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) as any);
  h.mapper.handle(stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }) as any);
  h.mapper.abort();
  const last = h.events.at(-1);
  assert.equal(last.type, 'message_end');
  assert.equal(last.message.stopReason, 'aborted');
  assert.equal(h.persisted[0].content[0].text, 'partial');
  const err = h.events.find((e) => e.type === 'message_update' && e.assistantMessageEvent.type === 'error');
  assert.equal(err.assistantMessageEvent.reason, 'aborted');
});

test('context usage from the assistant message is forwarded in Pi shape', () => {
  const h = harness();
  h.mapper.handle(assistant([{ type: 'text', text: 'x' }], 'end_turn', {
    context_usage: { model: 'claude-opus-5', total_tokens: 12_000, raw_max_tokens: 1_000_000, percentage: 1.2, categories: [], mcp_tools: [] },
  }) as any);
  assert.deepEqual(h.usage, [{ tokens: 12_000, contextWindow: 1_000_000, percent: 1.2 }]);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-events.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/events.ts`**

```ts
/**
 * Maps Claude Agent SDK messages onto Pi's session-event vocabulary and
 * Pi-shaped transcript messages. Pure: every side effect goes through the
 * sinks, so the mapping is testable with fixtures.
 *
 * Streaming: the SDK's `stream_event` messages (`includePartialMessages`) give
 * the deltas; the following `assistant` message is authoritative and is what
 * gets persisted. Tool results arrive as `user` messages carrying
 * `tool_result` blocks. Subagent traffic (`parent_tool_use_id` set) is ignored
 * — only the main thread is rendered, as Pi has no subagents either.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ContextUsage } from '@earendil-works/pi-coding-agent';
import type {
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from '@earendil-works/pi-ai';
import type { EngineSessionEvent } from '../types.js';
import { toDisplayToolName } from './tool-names.js';

export interface MapperSinks {
  provider: string;
  model: string;
  emit(event: EngineSessionEvent): void;
  persist(message: AssistantMessage | ToolResultMessage): void;
  /** Structured details a bridged Nexus tool produced for this tool call (Task 8 side channel). */
  detailsFor(toolCallId: string): unknown;
  onSessionId(sessionId: string, apiKeySource: string): void;
  onContextUsage(usage: ContextUsage): void;
  now?: () => number;
}

type AssistantBlock = TextContent | ThinkingContent | ToolCall;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } };
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use': return 'toolUse';
    case 'max_tokens': return 'length';
    case 'refusal': return 'error';
    default: return 'stop';
  }
}

function mapUsage(usage: any): Usage {
  const input = Number(usage?.input_tokens ?? 0);
  const output = Number(usage?.output_tokens ?? 0);
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0);
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { ...ZERO_COST } };
}

function mapBlocks(content: any[]): AssistantBlock[] {
  const blocks: AssistantBlock[] = [];
  for (const block of content ?? []) {
    if (block?.type === 'text') blocks.push({ type: 'text', text: block.text ?? '' });
    else if (block?.type === 'thinking') blocks.push({ type: 'thinking', thinking: block.thinking ?? '', ...(block.signature ? { thinkingSignature: block.signature } : {}) });
    else if (block?.type === 'redacted_thinking') blocks.push({ type: 'thinking', thinking: '', redacted: true } as ThinkingContent);
    else if (block?.type === 'tool_use') blocks.push({ type: 'toolCall', id: block.id, name: toDisplayToolName(block.name), arguments: block.input ?? {} });
    // server_tool_use / web_search results etc. have no Pi equivalent and are dropped.
  }
  return blocks;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: any) => (b?.type === 'text' ? b.text ?? '' : '')).join('');
}

export class SdkEventMapper {
  private partial: AssistantMessage | null = null;
  private readonly jsonBuffers = new Map<number, string>();
  private readonly toolNames = new Map<string, string>();
  private retrying: number | null = null;
  private compacting = false;
  private lastAssistantErrored = false;
  private resultError: string | undefined;
  private resultOk = true;

  constructor(private readonly sinks: MapperSinks) {}

  private now(): number {
    return this.sinks.now?.() ?? Date.now();
  }

  private newAssistant(model?: string): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      api: 'anthropic-messages',
      provider: this.sinks.provider,
      model: model || this.sinks.model,
      usage: zeroUsage(),
      stopReason: 'pending',
      timestamp: this.now(),
    };
  }

  handle(msg: SDKMessage): void {
    switch (msg.type) {
      case 'system':
        this.handleSystem(msg as any);
        return;
      case 'stream_event':
        if ((msg as any).parent_tool_use_id) return;
        this.endRetry();
        this.handleStreamEvent((msg as any).event);
        return;
      case 'assistant':
        if ((msg as any).parent_tool_use_id) return;
        this.endRetry();
        this.handleAssistant(msg as any);
        return;
      case 'user':
        if ((msg as any).parent_tool_use_id) return;
        this.handleUser(msg as any);
        return;
      case 'result':
        this.handleResult(msg as any);
        return;
      default:
        return;
    }
  }

  /** The turn was aborted: close any half-streamed message as `aborted`. */
  abort(reason = 'Aborted'): void {
    if (!this.partial) return;
    const message: AssistantMessage = { ...this.partial, content: this.partial.content.filter(Boolean), stopReason: 'aborted', errorMessage: reason };
    this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'error', reason: 'aborted', error: message } });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    this.partial = null;
    this.jsonBuffers.clear();
  }

  /** The query itself failed (process died, auth error thrown): show it like a provider error. */
  fail(message: string): void {
    if (this.partial) {
      this.abort(message);
      return;
    }
    this.emitErrorMessage(message);
  }

  finish(): { ok: boolean; error?: string } {
    return this.resultOk ? { ok: true } : { ok: false, error: this.resultError };
  }

  private handleSystem(msg: any): void {
    switch (msg.subtype) {
      case 'init':
        this.sinks.onSessionId(msg.session_id, String(msg.apiKeySource ?? 'unknown'));
        return;
      case 'status':
        if (msg.status === 'compacting' && !this.compacting) {
          this.compacting = true;
          this.sinks.emit({ type: 'compaction_start', reason: 'threshold' });
        } else if (msg.status !== 'compacting' && this.compacting) {
          this.endCompaction('threshold', msg.compact_result === 'failed' ? msg.compact_error ?? 'Compaction failed' : undefined);
        }
        return;
      case 'compact_boundary':
        if (this.compacting) this.endCompaction(msg.compact_metadata?.trigger === 'manual' ? 'manual' : 'threshold');
        return;
      case 'api_retry': {
        const status = msg.error_status ? ` (HTTP ${msg.error_status})` : '';
        this.retrying = msg.attempt;
        this.sinks.emit({
          type: 'auto_retry_start',
          attempt: msg.attempt,
          maxAttempts: msg.max_retries,
          delayMs: msg.retry_delay_ms,
          errorMessage: `${msg.error}${status}`,
        });
        return;
      }
      default:
        return;
    }
  }

  private endCompaction(reason: 'manual' | 'threshold', errorMessage?: string): void {
    this.compacting = false;
    this.sinks.emit({
      type: 'compaction_end',
      reason,
      result: undefined,
      aborted: false,
      willRetry: false,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

  private endRetry(): void {
    if (this.retrying === null) return;
    this.sinks.emit({ type: 'auto_retry_end', success: true, attempt: this.retrying });
    this.retrying = null;
  }

  private ensurePartial(model?: string): AssistantMessage {
    if (!this.partial) {
      this.partial = this.newAssistant(model);
      this.sinks.emit({ type: 'message_start', message: this.partial });
      this.sinks.emit({ type: 'message_update', message: this.partial, assistantMessageEvent: { type: 'start', partial: this.partial } });
    }
    return this.partial;
  }

  private update(event: any): void {
    const partial = this.partial!;
    this.sinks.emit({ type: 'message_update', message: partial, assistantMessageEvent: { ...event, partial } });
  }

  private handleStreamEvent(event: any): void {
    switch (event?.type) {
      case 'message_start':
        this.partial = null;
        this.ensurePartial(event.message?.model);
        return;
      case 'content_block_start': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const block = event.content_block;
        if (block?.type === 'text') {
          partial.content[index] = { type: 'text', text: '' };
          this.update({ type: 'text_start', contentIndex: index });
        } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
          partial.content[index] = { type: 'thinking', thinking: '' };
          this.update({ type: 'thinking_start', contentIndex: index });
        } else if (block?.type === 'tool_use') {
          const name = toDisplayToolName(block.name);
          partial.content[index] = { type: 'toolCall', id: block.id, name, arguments: {} };
          this.jsonBuffers.set(index, '');
          this.toolNames.set(block.id, name);
          this.update({ type: 'toolcall_start', contentIndex: index });
        }
        return;
      }
      case 'content_block_delta': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const current = partial.content[index];
        const delta = event.delta;
        if (!current || !delta) return;
        if (delta.type === 'text_delta' && current.type === 'text') {
          current.text += delta.text ?? '';
          this.update({ type: 'text_delta', contentIndex: index, delta: delta.text ?? '' });
        } else if (delta.type === 'thinking_delta' && current.type === 'thinking') {
          current.thinking += delta.thinking ?? '';
          this.update({ type: 'thinking_delta', contentIndex: index, delta: delta.thinking ?? '' });
        } else if (delta.type === 'signature_delta' && current.type === 'thinking') {
          current.thinkingSignature = delta.signature;
        } else if (delta.type === 'input_json_delta' && current.type === 'toolCall') {
          this.jsonBuffers.set(index, (this.jsonBuffers.get(index) ?? '') + (delta.partial_json ?? ''));
          this.update({ type: 'toolcall_delta', contentIndex: index, delta: delta.partial_json ?? '' });
        }
        return;
      }
      case 'content_block_stop': {
        const partial = this.ensurePartial();
        const index: number = event.index;
        const current = partial.content[index];
        if (!current) return;
        if (current.type === 'text') this.update({ type: 'text_end', contentIndex: index, content: current.text });
        else if (current.type === 'thinking') this.update({ type: 'thinking_end', contentIndex: index, content: current.thinking });
        else if (current.type === 'toolCall') {
          const raw = this.jsonBuffers.get(index) ?? '';
          try { current.arguments = raw ? JSON.parse(raw) : {}; } catch { current.arguments = {}; }
          this.update({ type: 'toolcall_end', contentIndex: index, toolCall: current });
        }
        return;
      }
      case 'message_delta': {
        const partial = this.ensurePartial();
        if (event.delta?.stop_reason) partial.stopReason = mapStopReason(event.delta.stop_reason);
        if (event.usage?.output_tokens !== undefined) partial.usage.output = Number(event.usage.output_tokens);
        return;
      }
      default:
        return;
    }
  }

  private handleAssistant(msg: any): void {
    const beta = msg.message ?? {};
    const streamed = this.partial;
    const message: AssistantMessage = {
      ...this.newAssistant(beta.model),
      ...(streamed ? { timestamp: streamed.timestamp } : {}),
      content: mapBlocks(beta.content),
      usage: mapUsage(beta.usage),
      stopReason: mapStopReason(beta.stop_reason),
      ...(beta.id ? { responseId: beta.id } : {}),
    };
    if (msg.error) {
      message.stopReason = 'error';
      const text = extractText(beta.content);
      message.errorMessage = text ? `${msg.error}: ${text}` : String(msg.error);
    } else if (beta.stop_reason === 'refusal') {
      message.errorMessage = 'The model declined this request (refusal).';
    }
    if (!streamed) {
      this.sinks.emit({ type: 'message_start', message });
      this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'start', partial: message } });
    }
    const isError = message.stopReason === 'error';
    this.sinks.emit({
      type: 'message_update',
      message,
      assistantMessageEvent: isError
        ? { type: 'error', reason: 'error', error: message }
        : { type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message },
    });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      this.toolNames.set(block.id, block.name);
      this.sinks.emit({ type: 'tool_execution_start', toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
    if (msg.context_usage) {
      const cu = msg.context_usage;
      this.sinks.onContextUsage({ tokens: cu.total_tokens, contextWindow: cu.raw_max_tokens, percent: cu.percentage } as ContextUsage);
    }
    this.lastAssistantErrored = isError;
    this.partial = null;
    this.jsonBuffers.clear();
  }

  private handleUser(msg: any): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return; // our own prompt echoed back
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolCallId: string = block.tool_use_id;
      const toolName = this.toolNames.get(toolCallId) ?? 'tool';
      const details = this.sinks.detailsFor(toolCallId);
      const isError = block.is_error === true;
      const result: ToolResultMessage = {
        role: 'toolResult',
        toolCallId,
        toolName,
        content: [{ type: 'text', text: extractText(block.content) }],
        ...(details !== undefined ? { details } : {}),
        isError,
        timestamp: this.now(),
      };
      this.sinks.emit({
        type: 'tool_execution_end',
        toolCallId,
        toolName,
        result: { content: result.content, ...(details !== undefined ? { details } : {}) },
        isError,
      });
      this.sinks.persist(result);
    }
  }

  private handleResult(msg: any): void {
    if (this.retrying !== null) {
      this.sinks.emit({ type: 'auto_retry_end', success: false, attempt: this.retrying, finalError: msg.subtype });
      this.retrying = null;
    }
    if (this.compacting) this.endCompaction('threshold', 'Turn ended during compaction');
    const failed = msg.is_error === true || msg.subtype !== 'success';
    if (!failed) return;
    this.resultOk = false;
    this.resultError = msg.subtype;
    if (this.lastAssistantErrored) return; // the assistant message already told the story
    const detail = typeof msg.result === 'string' && msg.result.trim() ? `: ${msg.result.trim()}` : '';
    this.emitErrorMessage(`${msg.subtype}${detail}`);
  }

  private emitErrorMessage(errorMessage: string): void {
    const message: AssistantMessage = { ...this.newAssistant(), stopReason: 'error', errorMessage };
    this.sinks.emit({ type: 'message_start', message });
    this.sinks.emit({ type: 'message_update', message, assistantMessageEvent: { type: 'error', reason: 'error', error: message } });
    this.sinks.emit({ type: 'message_end', message });
    this.sinks.persist(message);
    this.lastAssistantErrored = true;
  }
}
```

- [ ] **Step 4: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-events.test.ts && npm run typecheck
```

Expected: 10 passing. If `ThinkingContent` has no `redacted` field in the installed pi-ai build, drop the `as ThinkingContent` block's `redacted: true` and keep the empty thinking text.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engines/claude/events.ts src/backend/test/claude-events.test.ts && git commit -m "feat(engines): map Claude Agent SDK messages onto Pi session events"
```

---

### Task 10: `ClaudeEngineSession` — one SDK query per turn

**Files:**
- Create: `src/backend/engines/claude/session.ts`
- Test: `src/backend/test/claude-session.test.ts`

**Interfaces:**
- Consumes: `decideToolCall` (Task 4), `toSdkThinking` / `CLAUDE_CODE_PROVIDER` (Task 5), `toPolicyToolName` / `NEXUS_MCP_SERVER` (Task 6), `ToolUseCorrelator` (Task 7), `createNexusMcpServer` / `PiToolDefinition` (Task 8), `SdkEventMapper` (Task 9), `ENGINE_SESSION_CUSTOM_TYPE` (Task 1).
- Produces:
  - `type QueryFn = typeof query` (from the SDK)
  - `interface ClaudeSessionDeps { threadId: string; cwd: string; sessionManager: SessionManager; model: EngineModel; tools: PiToolDefinition[]; systemPromptAppendix: string; policy: ToolPolicyResolver; approvals: ApprovalBroker; audit: ApprovalAudit; env: Record<string, string | undefined>; executablePath?: string; queryFn?: QueryFn; log?: (line: string) => void }`
  - `class ClaudeEngineSession implements EngineSession` with `readonly sessionManager`, `get engineSessionId(): string | undefined`, plus `subscribe/prompt/abort/setModel/setThinkingLevel/supportsThinking/getContextUsage`.
  - `readStoredSessionId(sessionManager: Pick<SessionManager, 'getEntries'>): string | undefined`

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-session.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ENGINE_SESSION_CUSTOM_TYPE } from '@nexus/shared';
import { ClaudeEngineSession, readStoredSessionId, type QueryFn } from '../engines/claude/session';
import { findClaudeModel } from '../engines/claude/models';
import { ApprovalBroker } from '../pi/approvals';
import { createToolPolicyResolver } from '../pi/tool-policy';
import { NULL_APPROVAL_AUDIT } from '../approvals/audit';

const base = { uuid: 'u', session_id: 'sdk-sess-1' };
const init = { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base };
const textTurn = (text: string) => [
  init,
  { type: 'assistant', parent_tool_use_id: null, ...base, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base },
];

/** A fake `query()` that replays fixtures and records the options it was called with. */
function fakeQuery(script: (call: { prompt: unknown; options: any }) => any[] | AsyncIterable<any>) {
  const calls: Array<{ prompt: unknown; options: any }> = [];
  let interrupted = () => {};
  const queryFn = ((params: { prompt: unknown; options?: any }) => {
    const call = { prompt: params.prompt, options: params.options };
    calls.push(call);
    const produced = script(call);
    const iterable = Array.isArray(produced) ? (async function* () { for (const m of produced) yield m; })() : produced;
    return Object.assign(iterable as any, { interrupt: async () => { interrupted(); } });
  }) as unknown as QueryFn;
  return { queryFn, calls, onInterrupt: (fn: () => void) => { interrupted = fn; } };
}

function makeSession(dir: string, queryFn: QueryFn, overrides: Partial<ConstructorParameters<typeof ClaudeEngineSession>[0]> = {}) {
  const cwd = '/repo';
  const sessionManager = SessionManager.create(cwd, join(dir, 'sessions'), { id: 'thread-1' });
  const session = new ClaudeEngineSession({
    threadId: 'thread-1', cwd, sessionManager, model: findClaudeModel('claude-opus-5')!, tools: [],
    systemPromptAppendix: 'Nexus orientation', policy: createToolPolicyResolver(), approvals: new ApprovalBroker(),
    audit: NULL_APPROVAL_AUDIT, env: {}, queryFn, ...overrides,
  });
  return { session, sessionManager };
}

test('prompt persists the user turn, streams events, persists the reply and records the SDK session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('Hello'));
    const { session, sessionManager } = makeSession(dir, queryFn);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('hi');

    const entries = sessionManager.getEntries();
    assert.deepEqual(entries.filter((e) => e.type === 'message').map((e: any) => e.message.role), ['user', 'assistant']);
    const record = entries.find((e: any) => e.type === 'custom' && e.customType === ENGINE_SESSION_CUSTOM_TYPE) as any;
    assert.equal(record.data.sessionId, 'sdk-sess-1');
    assert.equal(session.engineSessionId, 'sdk-sess-1');
    assert.ok(events.some((e) => e.type === 'message_end'));
    assert.equal(calls[0].prompt, 'hi');
    assert.equal(calls[0].options.model, 'claude-opus-5');
    assert.equal(calls[0].options.resume, undefined);
    assert.equal(calls[0].options.systemPrompt.append, 'Nexus orientation');
    assert.deepEqual(calls[0].options.disallowedTools, ['AskUserQuestion']);
    assert.ok(calls[0].options.mcpServers.nexus);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the second turn resumes the recorded SDK session and applies model + thinking changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const { session } = makeSession(dir, queryFn);
    await session.prompt('one');
    await session.setModel(findClaudeModel('claude-sonnet-5')!);
    session.setThinkingLevel('xhigh');
    await session.prompt('two');
    assert.equal(calls[1].options.resume, 'sdk-sess-1');
    assert.equal(calls[1].options.model, 'claude-sonnet-5');
    assert.equal(calls[1].options.effort, 'xhigh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reopened session reads the SDK session id back from the JSONL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn } = fakeQuery(() => textTurn('ok'));
    const { session, sessionManager } = makeSession(dir, queryFn);
    await session.prompt('one');
    const reopened = SessionManager.open(sessionManager.getSessionFile()!, join(dir, 'sessions'), '/repo');
    assert.equal(readStoredSessionId(reopened), 'sdk-sess-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('images are sent as a streaming user message with base64 blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('seen'));
    const { session } = makeSession(dir, queryFn);
    await session.prompt('look', { images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] });
    const messages: any[] = [];
    for await (const m of calls[0].prompt as AsyncIterable<any>) messages.push(m);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canUseTool routes through the tool policy: allow, deny, and confirm via the broker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn, calls } = fakeQuery(() => textTurn('ok'));
    const approvals = new ApprovalBroker();
    let supervised = false;
    const policy = createToolPolicyResolver({ isSupervised: () => supervised, categoryPolicy: () => ({ services: 'deny' }) });
    const { session } = makeSession(dir, queryFn, { approvals, policy });
    await session.prompt('go');
    const canUseTool = calls[0].options.canUseTool;

    assert.deepEqual(await canUseTool('Read', { file_path: 'a' }, { toolUseID: 't1', signal: new AbortController().signal }), { behavior: 'allow', updatedInput: { file_path: 'a' } });
    const denied = await canUseTool('mcp__nexus__docker_service', { action: 'up' }, { toolUseID: 't2', signal: new AbortController().signal });
    assert.equal(denied.behavior, 'deny');
    assert.match(denied.message, /docker_service/);

    supervised = true;
    const pending = canUseTool('Bash', { command: 'ls' }, { toolUseID: 't3', signal: new AbortController().signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(approvals.pendingCount('thread-1'), 1);
    assert.equal(approvals.listPending()[0].toolName, 'bash');
    approvals.decide('thread-1', 't3', 'allow');
    assert.equal((await pending).behavior, 'allow');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('abort interrupts the query and persists the partial reply as aborted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { queryFn, onInterrupt } = fakeQuery(() => (async function* () {
      yield init;
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'message_start', message: { model: 'claude-opus-5', content: [], usage: {} } } };
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } };
      yield { type: 'stream_event', parent_tool_use_id: null, ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } } };
      await gate;
    })());
    onInterrupt(() => release());
    const { session, sessionManager } = makeSession(dir, queryFn);
    const turn = session.prompt('long');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.abort();
    await turn;
    const assistant = sessionManager.getEntries().find((e: any) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.stopReason, 'aborted');
    assert.equal(assistant.message.content[0].text, 'half');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a query that throws becomes an error reply instead of a rejected prompt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-'));
  try {
    const { queryFn } = fakeQuery(() => (async function* () { yield init; throw new Error('spawn failed'); })());
    const { session, sessionManager } = makeSession(dir, queryFn);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('x');
    const assistant = sessionManager.getEntries().find((e: any) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.stopReason, 'error');
    assert.equal(assistant.message.errorMessage, 'spawn failed');
    assert.ok(events.some((e) => e.type === 'message_end'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-session.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/session.ts`**

```ts
/**
 * A chat session backed by the Claude Agent SDK. One `query()` per turn,
 * resumed through the SDK session id recorded in the thread's JSONL.
 *
 * Everything the chat route relies on from a Pi session is here: Pi-shaped
 * events to subscribers, Pi-shaped entries in `sessionManager` (so
 * `flattenEntries`, archive and run markers work unchanged), abort that
 * resolves `prompt()` rather than rejecting it, and context usage after the
 * turn. Tool calls go through `decideToolCall` — the same gate, broker, policy
 * and audit rows as Pi sessions.
 */
import {
  query as sdkQuery,
  type CanUseTool,
  type HookCallback,
  type Options,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentSessionEventListener, ContextUsage, SessionManager } from '@earendil-works/pi-coding-agent';
import type { ImageContent, UserMessage } from '@earendil-works/pi-ai';
import { ENGINE_SESSION_CUSTOM_TYPE, type EngineSessionRecord } from '@nexus/shared';
import { decideToolCall, type ApprovalBroker } from '../../pi/approvals.js';
import type { ToolPolicyResolver } from '../../pi/tool-policy.js';
import type { ThinkingLevel } from '../../pi/thinking.js';
import type { ApprovalAudit } from '../../approvals/audit.js';
import type { EngineModel, EngineSession, EngineSessionEvent } from '../types.js';
import { CLAUDE_CODE_PROVIDER, toSdkThinking } from './models.js';
import { NEXUS_MCP_SERVER, toPolicyToolName } from './tool-names.js';
import { ToolUseCorrelator } from './tool-use-correlator.js';
import { createNexusMcpServer, type PiToolDefinition } from './pi-tools-bridge.js';
import { SdkEventMapper } from './events.js';

export type QueryFn = typeof sdkQuery;

/** How long a graceful `interrupt()` gets before the child process is killed. */
const INTERRUPT_GRACE_MS = 2_000;

export interface ClaudeSessionDeps {
  threadId: string;
  cwd: string;
  sessionManager: SessionManager;
  model: EngineModel;
  tools: PiToolDefinition[];
  systemPromptAppendix: string;
  policy: ToolPolicyResolver;
  approvals: ApprovalBroker;
  audit: ApprovalAudit;
  env: Record<string, string | undefined>;
  executablePath?: string;
  /** Injected by tests; production uses the SDK's `query`. */
  queryFn?: QueryFn;
  log?: (line: string) => void;
}

/** The last recorded SDK session id for this thread, or undefined for a fresh thread. */
export function readStoredSessionId(sessionManager: Pick<SessionManager, 'getEntries'>): string | undefined {
  const entries = sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as any;
    if (entry?.type !== 'custom' || entry.customType !== ENGINE_SESSION_CUSTOM_TYPE) continue;
    const data = entry.data as EngineSessionRecord | undefined;
    if (data?.engine === 'claude-code' && typeof data.sessionId === 'string') return data.sessionId;
  }
  return undefined;
}

async function* single(message: SDKUserMessage): AsyncIterable<SDKUserMessage> {
  yield message;
}

function buildPrompt(text: string, images: ImageContent[]): string | AsyncIterable<SDKUserMessage> {
  if (images.length === 0) return text;
  return single({
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        { type: 'text', text },
        ...images.map((image) => ({
          type: 'image' as const,
          source: { type: 'base64' as const, media_type: image.mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: image.data },
        })),
      ],
    },
  });
}

export class ClaudeEngineSession implements EngineSession {
  readonly sessionManager: SessionManager;
  private readonly listeners = new Set<AgentSessionEventListener>();
  private readonly queryFn: QueryFn;
  private model: EngineModel;
  private thinkingLevel: ThinkingLevel | undefined;
  private sdkSessionId: string | undefined;
  private active: { controller: AbortController; query: Query; aborting: boolean } | null = null;
  private lastContextUsage: ContextUsage | undefined;
  private readonly detailsByToolCall = new Map<string, unknown>();
  private loggedAuthSource = false;

  constructor(private readonly deps: ClaudeSessionDeps) {
    this.sessionManager = deps.sessionManager;
    this.model = deps.model;
    this.queryFn = deps.queryFn ?? sdkQuery;
    this.sdkSessionId = readStoredSessionId(deps.sessionManager);
  }

  get engineSessionId(): string | undefined {
    return this.sdkSessionId;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async setModel(model: EngineModel): Promise<void> {
    this.model = model;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

  supportsThinking(): boolean {
    return this.model.reasoning === true;
  }

  getContextUsage(): ContextUsage | undefined {
    return this.lastContextUsage;
  }

  async abort(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.aborting = true;
    try {
      await active.query.interrupt();
    } catch {
      /* the process may already be gone */
    }
    const kill = setTimeout(() => {
      if (this.active === active) active.controller.abort();
    }, INTERRUPT_GRACE_MS);
    kill.unref?.();
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.active) throw new Error('A turn is already in progress for this session');
    const images = options?.images ?? [];
    this.persistUserMessage(text, images);

    const controller = new AbortController();
    const correlator = new ToolUseCorrelator();
    const mapper = new SdkEventMapper({
      provider: CLAUDE_CODE_PROVIDER,
      model: this.model.id,
      emit: (event) => this.emit(event),
      persist: (message) => { this.sessionManager.appendMessage(message as any); },
      detailsFor: (toolCallId) => this.detailsByToolCall.get(toolCallId),
      onSessionId: (sessionId, source) => this.recordSessionId(sessionId, source),
      onContextUsage: (usage) => { this.lastContextUsage = usage; },
    });
    const mcp = createNexusMcpServer(this.deps.tools, {
      cwd: this.deps.cwd,
      correlator,
      signal: () => controller.signal,
      onUpdate: (toolCallId, toolName, partial) => this.emit({ type: 'tool_execution_update', toolCallId, toolName, args: {}, partialResult: partial }),
      onDetails: (toolCallId, details) => { this.detailsByToolCall.set(toolCallId, details); },
    });
    const rememberToolUse: HookCallback = async (input) => {
      if (input.hook_event_name === 'PreToolUse') correlator.remember(input.tool_name, input.tool_use_id, input.tool_input);
      return {};
    };
    const appendix = this.deps.systemPromptAppendix;
    const queryOptions: Options = {
      cwd: this.deps.cwd,
      model: this.model.id,
      ...toSdkThinking(this.model, this.thinkingLevel),
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
      includePartialMessages: true,
      permissionMode: 'default',
      // No ~/.claude or project settings: Nexus's tool policy is the only permission source.
      settingSources: [],
      systemPrompt: { type: 'preset', preset: 'claude_code', ...(appendix ? { append: appendix } : {}) },
      // Nexus's `question` tool (via MCP) replaces Claude's built-in so the existing question UI/broker/iOS flow works.
      disallowedTools: ['AskUserQuestion'],
      mcpServers: { [NEXUS_MCP_SERVER]: mcp },
      canUseTool: this.gate(controller.signal),
      hooks: { PreToolUse: [{ hooks: [rememberToolUse] }] },
      abortController: controller,
      env: this.deps.env,
      ...(this.deps.executablePath ? { pathToClaudeCodeExecutable: this.deps.executablePath } : {}),
      stderr: (data) => this.deps.log?.(`[claude-engine ${this.deps.threadId}] ${data.trimEnd()}`),
    };

    const q = this.queryFn({ prompt: buildPrompt(text, images), options: queryOptions });
    const active = { controller, query: q, aborting: false };
    this.active = active;
    try {
      for await (const message of q) mapper.handle(message);
      if (active.aborting) mapper.abort();
    } catch (err: any) {
      if (active.aborting || controller.signal.aborted || err?.name === 'AbortError') {
        mapper.abort();
      } else {
        const reason = err?.message || 'Claude engine failed';
        this.deps.log?.(`[claude-engine ${this.deps.threadId}] query failed: ${reason}`);
        mapper.fail(reason);
      }
    } finally {
      this.active = null;
      correlator.clear();
      this.detailsByToolCall.clear();
    }
  }

  private gate(turnSignal: AbortSignal): CanUseTool {
    return async (toolName, input, opts) => {
      const decision = await decideToolCall({
        threadId: this.deps.threadId,
        cwd: this.deps.cwd,
        toolName: toPolicyToolName(toolName),
        toolCallId: opts.toolUseID,
        input,
        signal: opts.signal ?? turnSignal,
        broker: this.deps.approvals,
        policy: this.deps.policy,
        audit: this.deps.audit,
      });
      return decision.block
        ? { behavior: 'deny', message: decision.reason ?? 'Denied' }
        : { behavior: 'allow', updatedInput: input };
    };
  }

  private emit(event: EngineSessionEvent): void {
    for (const listener of this.listeners) {
      try {
        void listener(event);
      } catch {
        /* a misbehaving subscriber must not break the turn */
      }
    }
  }

  private persistUserMessage(text: string, images: ImageContent[]): void {
    const message: UserMessage = {
      role: 'user',
      content: images.length > 0 ? [{ type: 'text', text }, ...images] : text,
      timestamp: Date.now(),
    };
    this.sessionManager.appendMessage(message as any);
  }

  private recordSessionId(sessionId: string, source: string): void {
    if (!this.loggedAuthSource) {
      this.loggedAuthSource = true;
      this.deps.log?.(`[claude-engine ${this.deps.threadId}] auth source: ${source}`);
    }
    if (sessionId === this.sdkSessionId) return;
    this.sdkSessionId = sessionId;
    const record: EngineSessionRecord = { engine: 'claude-code', sessionId, recordedAt: new Date().toISOString() };
    this.sessionManager.appendCustomEntry(ENGINE_SESSION_CUSTOM_TYPE, record);
  }
}
```

- [ ] **Step 4: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-session.test.ts && npm run typecheck
```

Expected: 7 passing. Typecheck notes: if `Options['systemPrompt']` rejects the spread, build the object in an `if`; if `SDKUserMessage.message.content` image `media_type` is typed narrower, cast the image block `as any`.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engines/claude/session.ts src/backend/test/claude-session.test.ts && git commit -m "feat(engines): ClaudeEngineSession over the Claude Agent SDK"
```

---

### Task 11: `ClaudeEngine` and auth environment

**Files:**
- Create: `src/backend/engines/claude/auth.ts`
- Create: `src/backend/engines/claude/engine.ts`
- Test: `src/backend/test/claude-engine.test.ts`

**Interfaces:**
- Consumes: `PiRuntime` additions (Task 3), `openSessionManagerFor`, `collectPiTools` (Task 8), `ClaudeEngineSession` (Task 10), `CLAUDE_CODE_MODELS` (Task 5), `resolveEnvVars` from `config.ts`.
- Produces:
  - `type ClaudeEngineConfig = NexusConfig['engines']['claude']`
  - `resolveClaudeAuthEnv(cfg: ClaudeEngineConfig, base?: NodeJS.ProcessEnv): Record<string, string | undefined>`
  - `interface ClaudeEngineDeps { pi: PiRuntime; config: () => ClaudeEngineConfig; queryFn?: QueryFn; deleteSdkSession?: (sessionId: string, cwd: string) => Promise<void>; log?: (line: string) => void }`
  - `class ClaudeEngine implements ChatEngine`
  - `readStoredSessionIdFromFile(sessionDir: string, threadId: string): string | undefined`

- [ ] **Step 1: Write the failing test**

`src/backend/test/claude-engine.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../pi/runtime';
import { ClaudeEngine } from '../engines/claude/engine';
import { resolveClaudeAuthEnv } from '../engines/claude/auth';
import type { QueryFn } from '../engines/claude/session';

const base = { uuid: 'u', session_id: 'sdk-sess-9' };
const turn = [
  { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-opus-5', ...base },
  { type: 'assistant', parent_tool_use_id: null, ...base, message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'result', subtype: 'success', is_error: false, result: 'hi', num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: 'end_turn', ...base },
];
const queryFn = ((): any => Object.assign((async function* () { for (const m of turn) yield m; })(), { interrupt: async () => {} })) as unknown as QueryFn;

const enabled = { enabled: true, auth: 'subscription' as const, oauth_token: '', executable_path: '' };

async function makeRuntime(dir: string) {
  return PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') }, {
    recallMemories: async () => [],
  });
}

test('resolveClaudeAuthEnv is subscription-first', () => {
  const env = resolveClaudeAuthEnv(enabled, { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-live', HOME: '/h' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.match(env.CLAUDE_AGENT_SDK_CLIENT_APP ?? '', /^nexus\//);

  const withToken = resolveClaudeAuthEnv({ ...enabled, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}' }, { CLAUDE_CODE_OAUTH_TOKEN: 'tok' });
  assert.equal(withToken.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  const unresolved = resolveClaudeAuthEnv({ ...enabled, oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}' }, {});
  assert.equal(unresolved.CLAUDE_CODE_OAUTH_TOKEN, undefined);

  const apiKey = resolveClaudeAuthEnv({ ...enabled, auth: 'api_key' }, { ANTHROPIC_API_KEY: 'sk-live' });
  assert.equal(apiKey.ANTHROPIC_API_KEY, 'sk-live');
});

test('catalog and lookup follow the enabled flag', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    let cfg = { ...enabled };
    const engine = new ClaudeEngine({ pi, config: () => cfg, queryFn });
    assert.equal(engine.id, 'claude-code');
    assert.ok(engine.listModels().every((m) => m.configured === true && m.provider === 'claude-code'));
    assert.ok(engine.findModel('claude-code', 'claude-opus-5'));
    assert.equal(engine.findModel('anthropic', 'claude-opus-5'), undefined);
    cfg = { ...enabled, enabled: false };
    assert.ok(engine.listModels().every((m) => m.configured === false));
    assert.equal(engine.findModel('claude-code', 'claude-opus-5'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sessionFor caches per thread+cwd and writes into the Pi session directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn });
    const a = await engine.sessionFor('thread-1', '/repo');
    const b = await engine.sessionFor('thread-1', '/repo');
    assert.strictEqual(a, b);
    assert.equal(engine.hasSession('thread-1', '/repo'), true);
    await a.prompt('hello');
    const entries = await pi.readMessages('thread-1', '/repo');
    assert.deepEqual(entries.map((e: any) => e.message.role), ['user', 'assistant']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dropping the Pi session also deletes the SDK transcript, even after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-engine-'));
  try {
    const pi = await makeRuntime(dir);
    const deleted: string[] = [];
    const engine = new ClaudeEngine({ pi, config: () => enabled, queryFn, deleteSdkSession: async (id, cwd) => { deleted.push(`${id}@${cwd}`); } });
    const session = await engine.sessionFor('thread-1', '/repo');
    await session.prompt('hello');
    // Simulate a restart: a fresh engine with no cached session must still find the id on disk.
    const cold = new ClaudeEngine({ pi, config: () => enabled, queryFn, deleteSdkSession: async (id, cwd) => { deleted.push(`cold:${id}@${cwd}`); } });
    void cold;
    pi.dropSession('thread-1', '/repo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(deleted.includes('sdk-sess-9@/repo'));
    assert.ok(deleted.includes('cold:sdk-sess-9@/repo'));
    assert.equal(engine.hasSession('thread-1', '/repo'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-engine.test.ts
```

Expected: FAIL, cannot find module.

- [ ] **Step 3: Write `src/backend/engines/claude/auth.ts`**

```ts
/**
 * Environment for the SDK's Claude Code child process.
 *
 * Subscription-first: the whole point of this engine is to use a Claude
 * Pro/Max login through Anthropic's own harness, so `ANTHROPIC_API_KEY` is
 * removed unless the user explicitly picks `auth: api_key` (a stray key in the
 * dev shell would otherwise silently bill the API). A `claude setup-token`
 * token is passed through when configured; with nothing configured the
 * bundled Claude Code uses this machine's existing login.
 */
import type { NexusConfig } from '@nexus/shared';
import { resolveEnvVars } from '../../config.js';

export type ClaudeEngineConfig = NexusConfig['engines']['claude'];

const CLIENT_APP = 'nexus/0.1.0';

export function resolveClaudeAuthEnv(
  cfg: ClaudeEngineConfig,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP };
  const token = resolveEnvVars(cfg.oauth_token || '').trim();
  // An unresolved `${VAR}` reference must not be sent as a literal token.
  if (token && !token.startsWith('${')) env.CLAUDE_CODE_OAUTH_TOKEN = token;
  else delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (cfg.auth !== 'api_key') delete env.ANTHROPIC_API_KEY;
  return env;
}
```

Check how `resolveEnvVars` treats a missing variable (`sed -n 305,320p src/backend/config.ts`): if it substitutes an empty string the guard is redundant but harmless; if it leaves the literal, the guard is what makes the `unresolved` assertion pass. Note that the `withToken` assertion reads the real `process.env` through `resolveEnvVars`, so set `CLAUDE_CODE_OAUTH_TOKEN=tok` for that test via `process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok'` before the call and delete it after if `resolveEnvVars` only consults `process.env`.

- [ ] **Step 4: Write `src/backend/engines/claude/engine.ts`**

```ts
/**
 * The Claude engine: sessions backed by the Claude Agent SDK, sharing the Pi
 * runtime's brokers, policy, audit sink, session directory and tool set.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { ENGINE_SESSION_CUSTOM_TYPE, type EngineSessionRecord } from '@nexus/shared';
import { openSessionManagerFor, type PiRuntime } from '../../pi/runtime.js';
import type { ChatEngine, EngineModel, EngineSession } from '../types.js';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel } from './models.js';
import { collectPiTools } from './pi-tools-bridge.js';
import { ClaudeEngineSession, type QueryFn } from './session.js';
import { resolveClaudeAuthEnv, type ClaudeEngineConfig } from './auth.js';

export interface ClaudeEngineDeps {
  pi: PiRuntime;
  /** Read fresh per call so a config edit lands without a restart. */
  config: () => ClaudeEngineConfig;
  queryFn?: QueryFn;
  /** Removes the SDK's own transcript for a dropped thread. Defaults to the SDK's `deleteSession`. */
  deleteSdkSession?: (sessionId: string, cwd: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Synchronous read of the recorded SDK session id straight from the JSONL —
 * used on drop, where the session may not be cached (backend restarted) and
 * the file is about to disappear.
 */
export function readStoredSessionIdFromFile(sessionDir: string, threadId: string): string | undefined {
  let files: string[];
  try {
    files = readdirSync(sessionDir).filter((name) => name.endsWith(`_${threadId}.jsonl`));
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const name of files) {
    let text: string;
    try { text = readFileSync(join(sessionDir, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(ENGINE_SESSION_CUSTOM_TYPE)) continue;
      try {
        const entry = JSON.parse(line);
        const data = entry?.data as EngineSessionRecord | undefined;
        if (entry?.type === 'custom' && entry.customType === ENGINE_SESSION_CUSTOM_TYPE && data?.engine === 'claude-code') found = data.sessionId;
      } catch { /* skip malformed line */ }
    }
  }
  return found;
}

export class ClaudeEngine implements ChatEngine {
  readonly id = 'claude-code' as const;
  private readonly sessions = new Map<string, ClaudeEngineSession>();
  private readonly pending = new Map<string, Promise<ClaudeEngineSession>>();
  private readonly deleteSdkSession: (sessionId: string, cwd: string) => Promise<void>;

  constructor(private readonly deps: ClaudeEngineDeps) {
    this.deleteSdkSession = deps.deleteSdkSession ?? ((sessionId, cwd) => deleteSession(sessionId, { dir: cwd }));
    // Pi owns the thread's JSONL; when it drops a thread, drop our side too.
    deps.pi.onSessionDropped((threadId, cwd) => this.dropSession(threadId, cwd));
  }

  private key(threadId: string, cwd: string): string {
    return `${threadId}::${cwd}`;
  }

  listModels(): EngineModel[] {
    const configured = this.deps.config().enabled;
    return CLAUDE_CODE_MODELS.map((model) => ({ ...model, configured }));
  }

  findModel(provider: string, id: string): EngineModel | undefined {
    if (provider !== CLAUDE_CODE_PROVIDER || !this.deps.config().enabled) return undefined;
    return findClaudeModel(id);
  }

  hasSession(threadId: string, cwd: string): boolean {
    return this.sessions.has(this.key(threadId, cwd));
  }

  async sessionFor(threadId: string, cwd: string): Promise<EngineSession> {
    const key = this.key(threadId, cwd);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const creating = this.createSession(threadId, cwd);
    this.pending.set(key, creating);
    try {
      const session = await creating;
      this.sessions.set(key, session);
      return session;
    } finally {
      this.pending.delete(key);
    }
  }

  private async createSession(threadId: string, cwd: string): Promise<ClaudeEngineSession> {
    const pi = this.deps.pi;
    const sessionDir = pi.sessionDirFor(cwd);
    if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
    const sessionManager = await openSessionManagerFor(threadId, cwd, sessionDir);
    const tools = await collectPiTools(pi.extensionFactoriesFor(threadId, cwd));
    const cfg = this.deps.config();
    return new ClaudeEngineSession({
      threadId,
      cwd,
      sessionManager,
      model: CLAUDE_CODE_MODELS[0],
      tools,
      systemPromptAppendix: pi.systemPromptAppendixFor(threadId, cwd),
      policy: pi.policyFor(threadId, cwd),
      approvals: pi.approvals,
      audit: pi.auditSink,
      env: resolveClaudeAuthEnv(cfg),
      executablePath: cfg.executable_path?.trim() || undefined,
      queryFn: this.deps.queryFn,
      log: this.deps.log ?? ((line) => console.log(line)),
    });
  }

  dropSession(threadId: string, cwd: string): void {
    const key = this.key(threadId, cwd);
    const cached = this.sessions.get(key);
    this.sessions.delete(key);
    this.pending.delete(key);
    const sdkSessionId = cached?.engineSessionId ?? readStoredSessionIdFromFile(this.deps.pi.sessionDirFor(cwd), threadId);
    if (!sdkSessionId) return;
    // Fire-and-forget: the SDK transcript is a few KB in ~/.claude; failing to
    // remove it must never fail the drop.
    void this.deleteSdkSession(sdkSessionId, cwd).catch((err: any) => {
      this.deps.log?.(`[claude-engine ${threadId}] could not delete SDK session ${sdkSessionId}: ${err?.message ?? err}`);
    });
  }
}
```

- [ ] **Step 5: Run the test and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/claude-engine.test.ts && npm run typecheck
```

Expected: 4 passing.

- [ ] **Step 6: Commit**

```bash
git add src/backend/engines/claude/auth.ts src/backend/engines/claude/engine.ts src/backend/test/claude-engine.test.ts && git commit -m "feat(engines): ClaudeEngine with subscription-first auth env and drop cleanup"
```

---

### Task 12: Wire the registry into the backend and the chat/models routes

**Files:**
- Modify: `src/backend/fastify.d.ts`
- Modify: `src/backend/index.ts` (after `PiRuntime.create`, before `app.decorate('pi', pi)`)
- Modify: `src/backend/routes/chat.ts`
- Modify: `src/backend/routes/pi.ts`
- Test: `src/backend/test/routes-chat-engines.test.ts`

**Interfaces:**
- Consumes: `EngineRegistry`, `PiEngine` (Task 2), `ClaudeEngine` (Task 11), `EngineSession` (Task 2).
- Produces: `fastify.engines: EngineRegistry`; the chat route resolves `modelKey` through `engines.resolveModel` and opens the session through the owning engine; `/api/models` lists every engine's models.

- [ ] **Step 1: Write the failing route test**

`src/backend/test/routes-chat-engines.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { registerChatRoutes } from '../routes/chat';
import { buildModelCatalog } from '../routes/pi';
import { ConcurrencyTracker } from '../pi/concurrency';
import { EngineRegistry } from '../engines/registry';
import { capabilitiesFromModel } from '../pi/model-capabilities';
import type { ChatEngine, EngineSession } from '../engines/types';

function fakeEngine(id: 'pi' | 'claude-code', provider: string, prompts: string[]): ChatEngine {
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async (text: string) => { prompts.push(`${id}:${text}`); },
    abort: async () => {},
  } as unknown as EngineSession;
  const model = { provider, id: 'm1', name: 'M1', input: ['text'] as Array<'text' | 'image'>, configured: true };
  return {
    id,
    listModels: () => [model],
    findModel: (p, m) => (p === provider && m === 'm1' ? model : undefined),
    sessionFor: async () => session,
    hasSession: () => false,
    dropSession: () => {},
  };
}

async function makeApp() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-engines-route-'));
  const db = new Database(join(dir, 'nexus.db'));
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, repo_path TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_threads (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT, last_model_key TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, attachments_json TEXT, message_type TEXT, structured_json TEXT, thinking TEXT, tool_calls TEXT, created_at TEXT);
  `);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)').run('proj-1', 'demo', 'Demo', dir, now, now);
  db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('thread-1', 'proj-1', 'T1', now, now);
  const prompts: string[] = [];
  const pi = fakeEngine('pi', 'openrouter', prompts);
  const claude = fakeEngine('claude-code', 'claude-code', prompts);
  const runtime = {
    readMessages: async () => [],
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    isSupervised: () => false,
    models: { find: () => undefined, getAll: () => [], getAvailable: () => [] },
  };
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime as any);
  app.decorate('chatConcurrency', new ConcurrencyTracker());
  app.decorate('engines', new EngineRegistry([pi, claude]));
  app.register(registerChatRoutes, {
    detectGitBranch: async () => 'main',
    capabilityResolver: { peek: capabilitiesFromModel, resolve: async (m: any) => capabilitiesFromModel(m) },
  });
  await app.ready();
  return { app, db, dir, prompts };
}

test('the chat route opens the session on the engine that owns the model key', async () => {
  const { app, db, dir, prompts } = await makeApp();
  try {
    const claude = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'hello', modelKey: 'claude-code/m1' } });
    assert.equal(claude.statusCode, 200);
    const pi = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'again', modelKey: 'openrouter/m1' } });
    assert.equal(pi.statusCode, 200);
    assert.deepEqual(prompts, ['claude-code:hello', 'pi:again']);
    const unknown = await app.inject({ method: 'POST', url: '/api/threads/thread-1/messages/stream', payload: { content: 'x', modelKey: 'claude-code/nope' } });
    assert.equal(unknown.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the model catalog lists every engine when the registry is present', async () => {
  const { app, db, dir } = await makeApp();
  try {
    const catalog = buildModelCatalog(app as any);
    assert.deepEqual(catalog.map((m) => `${m.provider}/${m.id}`), ['openrouter/m1', 'claude-code/m1']);
    assert.ok(catalog.every((m) => m.configured === true));
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

If `registerChatRoutes` needs more tables than the three above, copy the `CREATE TABLE` block from `makeApp` in `test/routes-chat.test.ts` (lines ~250–290) verbatim.

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/routes-chat-engines.test.ts
```

Expected: FAIL — the route still resolves models through `pi.models.find` and returns 400 for `claude-code/m1`.

- [ ] **Step 3: Declare the decorator**

In `src/backend/fastify.d.ts` add `import type { EngineRegistry } from './engines/registry.js';` and inside `FastifyInstance`:

```ts
    engines: EngineRegistry;
```

- [ ] **Step 4: Build the registry in `src/backend/index.ts`**

Add imports:

```ts
import { EngineRegistry } from './engines/registry.js';
import { PiEngine } from './engines/pi-engine.js';
import { ClaudeEngine } from './engines/claude/engine.js';
```

After the OpenRouter key block (`if (openRouterKey) { ... }`) add:

```ts
  // Chat engines. Pi stays the default; `claude-code/*` model keys go through
  // the Claude Agent SDK so a Max/Pro login is used via Anthropic's own harness.
  const claudeEngine = new ClaudeEngine({
    pi,
    config: () => {
      try {
        return loadConfig().engines.claude;
      } catch {
        return { enabled: false, auth: 'subscription', oauth_token: '', executable_path: '' };
      }
    },
  });
  const engines = new EngineRegistry([new PiEngine(pi), claudeEngine]);
```

Next to `app.decorate('pi', pi);` add:

```ts
  app.decorate('engines', engines);
```

- [ ] **Step 5: Route the chat stream through the registry**

In `src/backend/routes/chat.ts`:

1. Replace the `import type { AgentSession } from '@earendil-works/pi-coding-agent';` line with:

```ts
import type { EngineSession } from '../engines/types.js';
import { EngineRegistry } from '../engines/registry.js';
import { PiEngine } from '../engines/pi-engine.js';
```

2. Replace the `ActiveStream` and `ChatSession` declarations with:

```ts
interface ActiveStream {
  session: Pick<EngineSession, 'abort'>;
  runId: string;
  abortSource?: AgentRunAbortSource;
}

type ChatSession = EngineSession;
```

3. In `registerChatRoutes`, after `const pi = fastify.pi;` add:

```ts
  // Tests that decorate only `pi` get a Pi-only registry; production decorates
  // the full one in index.ts.
  const engines: EngineRegistry = (fastify as any).engines ?? new EngineRegistry([new PiEngine(pi as any)]);
```

4. In the stream handler, replace the block

```ts
    let selectedModel: any;
    if (body.modelKey) {
      const sep = body.modelKey.indexOf('/');
      if (sep > 0) {
        const provider = body.modelKey.slice(0, sep);
        const modelId = body.modelKey.slice(sep + 1);
        selectedModel = pi.models.find(provider, modelId);
        if (!selectedModel) {
          reply.code(400);
          return { error: `Model not found: ${body.modelKey}` };
        }
      }
    }
```

with

```ts
    const resolved = engines.resolveModel(modelKey);
    if (!resolved) {
      reply.code(400);
      return { error: `Model not found: ${modelKey}` };
    }
    const selectedModel: any = resolved.model;
    const engine = resolved.engine;
```

5. Replace `session = await pi.sessionFor(threadId, cwd);` with `session = await engine.sessionFor(threadId, cwd);`.

6. `safeContextUsage` takes `Partial<Pick<AgentSession, 'getContextUsage'>>`; change it to `Partial<Pick<EngineSession, 'getContextUsage'>>` and its return type to `ReturnType<EngineSession['getContextUsage']> | undefined`.

Everything else (`pi.questions`, `pi.approvals`, `pi.readMessages`, `pi.dropSession`, `pi.getSessionModel/setSessionModel`, `pi.isSupervised`) stays on `pi`: brokers, session files and the per-thread model cache are shared by both engines.

- [ ] **Step 6: Catalog from the registry in `src/backend/routes/pi.ts`**

Replace the first two lines of `buildModelCatalog`'s body with:

```ts
  const engines = (fastify as any).engines as { listModels(): EngineModel[] } | undefined;
  const all = engines ? engines.listModels() : fastify.pi.models.getAll();
  const available = engines ? all.filter((m) => m.configured !== false) : fastify.pi.models.getAvailable();
```

and add `import type { EngineModel } from '../engines/types.js';`. The rest of the mapping is unchanged (`configuredKeys` is now derived from `available` either way). In the `PUT /api/models/curation` handler replace `const available = fastify.pi.models.getAvailable();` with `const available = buildModelCatalog(fastify, capabilityResolver).filter((m) => m.configured !== false);`.

- [ ] **Step 7: Run the new test, the existing chat/pi route tests, the full suite and typecheck**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && npx tsx --test test/routes-chat-engines.test.ts test/routes-chat.test.ts test/pi-runtime.test.ts test/routes-pi*.test.ts && npm test && npm run typecheck && cd ../frontend && npm run typecheck
```

Expected: all passing; both typechecks clean. The frontend needs no change: `providerLabel('claude-code')` already renders "Claude Code", and `runLabels.ts` already knows the Claude tool names.

- [ ] **Step 8: Commit**

```bash
git add src/backend/fastify.d.ts src/backend/index.ts src/backend/routes/chat.ts src/backend/routes/pi.ts src/backend/test/routes-chat-engines.test.ts && git commit -m "feat(engines): route chat turns and the model catalog through the engine registry"
```

---

### Task 13: Live round trip, packaging check, docs

**Files:**
- Create: `src/backend/test/live/claude-engine.test.ts`
- Modify: `README.md` (new "Engines" subsection after the "Multi-provider chat" row's section; see line ~727 "Model registry" area)
- Verify: `scripts/stage-services.cjs`, `scripts/prune-foreign-natives.cjs` (no code change expected)

- [ ] **Step 1: Write the live test (runs only with `npm run test:live` and real auth)**

`src/backend/test/live/claude-engine.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../../pi/runtime';
import { ClaudeEngine } from '../../engines/claude/engine';
import { findClaudeModel } from '../../engines/claude/models';

// Opt-in: NEXUS_LIVE_CLAUDE=1 plus a working `claude` login or CLAUDE_CODE_OAUTH_TOKEN.
const enabled = process.env.NEXUS_LIVE_CLAUDE === '1';

test('Claude engine completes a real turn on Haiku and resumes it', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-live-'));
  try {
    const pi = await PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') });
    const engine = new ClaudeEngine({ pi, config: () => ({ enabled: true, auth: 'subscription', oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}', executable_path: '' }), log: (l) => console.log(l) });
    const session = await engine.sessionFor('live-thread', dir);
    await session.setModel(findClaudeModel('claude-haiku-4-5')!);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('Reply with exactly the word PONG and nothing else.');
    const end = events.filter((e) => e.type === 'message_end').at(-1);
    assert.match(end.message.content.map((b: any) => b.text ?? '').join(''), /PONG/);
    assert.ok((session as any).engineSessionId, 'session id recorded');
    await session.prompt('What word did you just say? Answer with that word only.');
    const second = events.filter((e) => e.type === 'message_end').at(-1);
    assert.match(second.message.content.map((b: any) => b.text ?? '').join(''), /PONG/);
    assert.ok(session.getContextUsage()?.contextWindow, 'context usage populated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it against the real SDK**

```bash
cd /Users/k-sym/Projects/nexus/src/backend && NEXUS_LIVE_CLAUDE=1 npx tsx --test test/live/claude-engine.test.ts
```

Expected: PASS, with a log line `auth source: oauth` (subscription) — if it says `ANTHROPIC_API_KEY`, `engines.claude.auth` is not `subscription` or the env strip failed; fix before continuing. If the SDK reports `No conversation found` on the second prompt, the `resume` id handling is wrong; investigate before continuing.

- [ ] **Step 3: Manual checks in the running app**

1. `npm run dev`; open a project; in the model picker choose **Claude Code · claude-opus-5** (enable it under Settings → Models if curation is customised). Send "list the files in this repo". Expect a streamed reply with a `Bash`/`Glob` tool card, then a `context_usage` bar.
2. Turn on Supervise for the thread; ask it to create a file. Expect an approval card (iOS push too if configured); Allow; the tool runs; the Decisions view shows a `write` row with source `supervise`.
3. Ask "ask me which option I prefer" — expect the Nexus question card (tool name `question`), answer it, the turn continues.
4. Stop a long turn mid-stream: the run card shows Cancelled by user; the partial reply is kept.
5. Restart the backend; send another turn in the same thread: the model still has the earlier context (resume works); history renders unchanged.
6. Delete the thread; confirm `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` is gone.
7. Send with an image attached to a `claude-code` model; the model describes it.

- [ ] **Step 4: Packaging check**

```bash
cd /Users/k-sym/Projects/nexus && npm run build && npm run stage:services && /bin/ls .stage/services/backend/node_modules/@anthropic-ai/ && node scripts/prune-foreign-natives.cjs && /bin/ls .stage/services/backend/node_modules/@anthropic-ai/
```

Expected: `claude-agent-sdk` and `claude-agent-sdk-darwin-arm64` present before and after pruning (the prune regex matches `darwin-x64`, `linux`, `win32`, not `darwin-arm64`). If `stage-services` installs with `--omit=optional`, the darwin package is missing: change that install to keep optional deps or set `engines.claude.executable_path` to a system `claude` and document it. Then `npm run tauri:build` and run the packaged app through manual check 1.

- [ ] **Step 5: README**

Add under the "Models & curation" material (near line 727 in README.md):

```markdown
### Engines

Nexus has two chat engines, selected by the model key's provider prefix:

| Engine | Provider prefix | Auth | Notes |
| --- | --- | --- | --- |
| Pi runtime | everything else (`openrouter/…`, `local/…`, `github-copilot/…`, …) | API keys / provider OAuth in `~/.nexus/auth.json` | Default engine. |
| Claude Agent SDK | `claude-code/…` | Your `claude` login (Max/Pro) or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Runs Claude through Anthropic's own Claude Code harness, which is the way consumer-plan credentials are permitted to be used. `ANTHROPIC_API_KEY` is stripped from the child process unless `engines.claude.auth: api_key`. |

Both engines share the tool policy, Supervise, the approval and question brokers, the audit trail, memory recall and the Nexus tools (offered to Claude as an in-process MCP server). Transcripts for both live in `~/.nexus/sessions/<repo>/…jsonl`; the Claude engine additionally keeps the SDK's own session under `~/.claude/projects/` and removes it when the thread is deleted or archived.

```yaml
engines:
  claude:
    enabled: true
    auth: subscription        # or api_key
    oauth_token: ${CLAUDE_CODE_OAUTH_TOKEN}   # optional; empty ⇒ use this machine's claude login
    executable_path: ''       # optional; empty ⇒ the SDK's bundled Claude Code
```
```

- [ ] **Step 6: Full verification and commit**

```bash
cd /Users/k-sym/Projects/nexus && npm run typecheck && npm run --workspace=src/backend test && npm run build && git add README.md src/backend/test/live/claude-engine.test.ts && git commit -m "docs(engines): document the Claude Agent SDK engine; add live round-trip test"
```

---

## Coexistence with `2026-09-02-pi-session-chat-reliability.md`

- That spec upgrades Pi to 0.84.4 and teaches the frontend run model `compaction_*` / `auto_retry_*` phases. This plan emits those events from the Claude engine (Task 9), so the frontend work applies to both engines with no extra code.
- Both touch `src/backend/routes/chat.ts` lightly and in different places (this plan: model resolution + `sessionFor`; that spec: only if a typed adapter is needed). Land whichever is ready first; the other rebases trivially.
- Do not pin Pi to `main` here either; Task 3's refactor keeps `createSession` behaviour byte-for-byte.

## Known limits (deliberate, v1)

- One SDK process per turn (~1–2 s startup). Follow-up: persistent streaming-input query per session.
- `configured` for `claude-code` models means "engine enabled", not "login verified"; an expired login surfaces as an `authentication_failed` error reply on the first turn.
- Per-message cost is not attributed (Pi's `usage.cost` stays zero); the SDK reports cost per turn in the `result` message and is logged only.
- Subagent (`Task`) internals are not rendered — only the main thread's tool calls, mirroring Pi.
- SDK rate-limit warnings (`rate_limit_event`) are not surfaced in the UI yet.
- A thread is pinned to the engine of its first turn. The Pi session and the SDK session hold different conversation state, so switching engines mid-thread would silently drop history; the chat route answers `409 { kind: 'engine_mismatch' }` instead. Start a new thread to change engines.
- Signal filters (tool-result projection) are Pi-only; Claude tool results are not projected through them.
- Every Claude tool call — including the read-only built-ins (`Read`/`Grep`/`Glob`/`LS`) the CLI would auto-allow under `permissionMode: 'default'` — reaches the Nexus policy, because the `PreToolUse` hook answers `permissionDecision: 'ask'`. The cost is one `canUseTool` round trip per read.

## Self-review

- **Spec coverage:** engine seam (T2, T12); Claude engine on the SDK (T5, T8–T11); subscription-first auth (T1, T11); shared policy/approvals/audit (T4, T10); Nexus tools for Claude (T8); question UI parity (T6–T8, T10); transcript/history/archive parity via Pi JSONL (T3, T9, T10); resume across restarts (T10, T11); drop cleanup (T3, T11); catalog + picker (T2, T5, T12); packaging (T13); docs (T13). Frontend run-phase labels are out of scope by design (owned by the parallel spec).
- **Placeholder scan:** every code step is complete; the only "check and adjust" notes are for typing differences in the installed SDK build (T8 Step 3, T10 Step 4) and the `resolveEnvVars` missing-variable behaviour (T11 Step 3), each with the exact alternative stated.
- **Type consistency:** `EngineSession`/`EngineModel`/`ChatEngine` (T2) are what T10–T12 implement and consume; `decideToolCall` (T4) signature is what T10 calls; `MapperSinks` (T9) matches the object T10 constructs; `PiToolDefinition`/`BridgeContext` (T8) match T10's `createNexusMcpServer` call; `openSessionManagerFor`, `extensionFactoriesFor`, `systemPromptAppendixFor`, `auditSink`, `onSessionDropped` (T3) are exactly what T11 uses; `readStoredSessionId` (T10) vs `readStoredSessionIdFromFile` (T11) are distinct on purpose (in-memory entries vs raw file).
