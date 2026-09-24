# Embedded Terminal Threads — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat thread be created in **terminal mode** and render a live, interactive shell (`node-pty` + `xterm.js`) embedded in the app, `cwd`'d to the project repo, with the persona's launch command pre-typed (not auto-run).

**Architecture:** A persistent PTY registry on the backend keyed by `threadId` (survives navigation; reaped on idle/close/shutdown), streamed to an `xterm.js` terminal over a `@fastify/websocket` endpoint bound to `127.0.0.1`. Thread mode is a new `chat_threads.mode` column set at creation. The persona's launch command (`claude --append-system-prompt …` etc.) is built from the persona's parsed config and written to the PTY input for the user to review and press Enter — the repo's `AGENTS.md` and working tree are never mutated.

**Tech Stack:** `node-pty` (native, ABI-safe under the existing `spawn('node')` backend launch), `@fastify/websocket`, `@xterm/xterm` + `@xterm/addon-fit`, better-sqlite3, `node:test` (backend), React/TS (frontend — verify via typecheck/build/manual).

**Builds on:** Phase 1 (merged). New-chat picker, project tree, `ChatPanel` (threadId-driven), and persona icon/color already exist.

**Scope boundary:** Terminal threads are terminal-only — no syncing terminal turns back into bubble chat history. No cross-restart PTY resurrection. The existing osascript "open in Terminal.app" button stays for chat threads.

---

## File Structure

**Create**
- `src/backend/pty/launch-command.ts` — pure: build the persona-aware pre-typed command + shell-quote helper.
- `src/backend/pty/scrollback.ts` — pure: bounded scrollback buffer.
- `src/backend/pty/manager.ts` — PTY registry (injectable spawn): create/attach/input/resize/detach/reap.
- `src/backend/pty/node-pty-adapter.ts` — wraps `node-pty` into the `PtyLike`/`SpawnFn` interface the manager expects.
- `src/backend/routes/pty.ts` — registers the `/api/threads/:threadId/pty` WebSocket route.
- `src/backend/test/launch-command.test.ts`, `src/backend/test/scrollback.test.ts`, `src/backend/test/pty-manager.test.ts`, `src/backend/test/chat-thread-mode.test.ts` — tests.
- `src/frontend/src/components/TerminalPane.tsx` — xterm.js terminal bound to the PTY WebSocket.

**Modify**
- `src/shared/index.ts` — `ChatThread.mode`, `ChatMode` type.
- `src/backend/db.ts` — `mode` column migration.
- `src/backend/routes/chat.ts` — thread-create accepts/persists `mode`.
- `src/backend/index.ts` — register `@fastify/websocket` + `registerPtyRoutes`.
- `src/frontend/src/api.ts` — `createThread(projectId, agentId, mode)`; `ptyWsUrl(threadId)` helper.
- `src/frontend/src/components/NewChatPicker.tsx` — mode toggle (Chat / Terminal).
- `src/frontend/src/App.tsx` — pass `mode` through `startNewChat` → `createThread`.
- `src/frontend/src/components/Sidebar.tsx` — terminal glyph on terminal-mode thread rows.
- `src/frontend/src/components/ChatPanel.tsx` OR `src/frontend/src/App.tsx` — route terminal-mode threads to `TerminalPane` instead of the bubble UI.
- `electron/package.json` / build — ensure `node-pty` is rebuilt for the packaged app.

---

## Task 1: Install dependencies

**Files:** `src/backend/package.json`, `src/frontend/package.json` (via npm)

- [ ] **Step 1: Install backend deps**

Run:
```bash
npm install --workspace=src/backend node-pty @fastify/websocket
```
Expected: both added to `src/backend/package.json` dependencies; install succeeds (node-pty compiles a native binding).

- [ ] **Step 2: Install frontend deps**

Run:
```bash
npm install --workspace=src/frontend @xterm/xterm @xterm/addon-fit
```
Expected: both added to `src/frontend/package.json` dependencies.

- [ ] **Step 3: Verify node-pty loads under the backend's runtime**

Run:
```bash
node -e "const pty=require('node-pty'); const p=pty.spawn(process.env.SHELL||'/bin/zsh',[],{cols:80,rows:24}); p.onData(()=>{}); setTimeout(()=>{p.kill();console.log('node-pty OK');},300)"
```
Expected: prints `node-pty OK` with no native-module error. (If it fails to load, run `npm rebuild node-pty` and retry.)

- [ ] **Step 4: Commit**

```bash
git add src/backend/package.json src/frontend/package.json package-lock.json
git commit -m "build: add node-pty, @fastify/websocket, xterm deps"
```

> **Packaging note (do not skip at release time):** `node-pty` is native. Electron launches the backend via `spawn('node', …)` (system Node), so node-pty must be built for that system Node's ABI — the same arrangement that already works for `better-sqlite3`. Whatever native-rebuild step the packaged build uses for better-sqlite3 must also cover node-pty. This is verified at packaging time (out of scope for dev tasks here) but is captured in Task 12.

---

## Task 2: Shared `ChatThread.mode`

**Files:** Modify `src/shared/index.ts` (ChatThread interface)

- [ ] **Step 1: Add the mode type and field**

In `src/shared/index.ts`, immediately before the `ChatThread` interface, add:

```ts
/** A chat thread is either a bubble conversation or an embedded terminal session. */
export type ChatMode = 'chat' | 'terminal';
```

Then add to the `ChatThread` interface (after `archived_at`):

```ts
  /** 'chat' (bubble UI) or 'terminal' (embedded PTY). Defaults to 'chat'. */
  mode?: ChatMode;
```

- [ ] **Step 2: Build + typecheck shared**

Run: `npm run --workspace=src/shared build && npm run --workspace=src/shared typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/shared/index.ts
git commit -m "feat(shared): add ChatMode + ChatThread.mode"
```

---

## Task 3: DB migration — `chat_threads.mode` (TDD)

**Files:**
- Modify: `src/backend/db.ts` (near the `agent_session_id` migration, ~line 247)
- Test: `src/backend/test/chat-thread-mode.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/chat-thread-mode.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import fs from 'fs';
import { getDb } from '../db';

test('chat_threads has a mode column defaulting to chat', () => {
  const base = join(tmpdir(), `nexus-modetest-${process.pid}-${Date.now()}.db`);
  const db = getDb(base);
  const cols = db.pragma('table_info(chat_threads)') as { name: string; dflt_value: string | null }[];
  const mode = cols.find(c => c.name === 'mode');
  db.close();
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(base + ext, { force: true });
  assert.ok(mode, 'mode column present');
  assert.match(String(mode!.dflt_value ?? ''), /chat/, "mode defaults to 'chat'");
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `npm --workspace=src/backend test`
Expected: FAIL — `mode column present` assertion fails (column absent).

- [ ] **Step 3: Add the migration**

In `src/backend/db.ts`, find the block (~line 247-249):

```ts
  const threadCols = db.pragma('table_info(chat_threads)') as { name: string }[];
  if (!threadCols.some(c => c.name === 'agent_session_id')) {
    db.exec('ALTER TABLE chat_threads ADD COLUMN agent_session_id TEXT');
  }
```

Add immediately after the closing brace of that `if`:

```ts
  if (!threadCols.some(c => c.name === 'mode')) {
    db.exec("ALTER TABLE chat_threads ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat'");
  }
```

> Note: `threadCols` is read once above; reuse it. If the variable is scoped/used differently in the actual file, re-read `table_info(chat_threads)` for the `mode` check to be safe.

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `npm --workspace=src/backend test`
Expected: PASS — full suite green (41 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/db.ts src/backend/test/chat-thread-mode.test.ts
git commit -m "feat(backend): chat_threads.mode column migration + test"
```

---

## Task 4: Thread-create accepts `mode`

**Files:** Modify `src/backend/routes/chat.ts` (POST `/api/projects/:projectId/threads`, ~line 36)

- [ ] **Step 1: Persist mode on create**

In the create handler, change the body type and insert. Replace:

```ts
    const body = request.body as { agent_id: string };
```
with:
```ts
    const body = request.body as { agent_id: string; mode?: ChatMode };
    const mode: ChatMode = body.mode === 'terminal' ? 'terminal' : 'chat';
```

Add `mode` to the constructed `thread` object (after `archived_at: null,`):
```ts
      mode,
```

Update the INSERT to include the column:
```ts
    db.prepare('INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at, archived_at, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(thread.id, thread.project_id, thread.agent_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at, thread.mode);
```

Add `ChatMode` to the existing `@nexus/shared` import at the top of `chat.ts`.

- [ ] **Step 2: Verify backend typecheck + tests**

Run: `npm run --workspace=src/shared build && npm run --workspace=src/backend typecheck && npm --workspace=src/backend test`
Expected: PASS (41 tests).

- [ ] **Step 3: Commit**

```bash
git add src/backend/routes/chat.ts
git commit -m "feat(backend): thread-create accepts and persists mode"
```

---

## Task 5: Launch-command builder (TDD)

Pure module: given a persona's provider + system prompt + optional session id, produce the pre-typed command string. Plus a POSIX single-quote helper.

**Files:**
- Create: `src/backend/pty/launch-command.ts`
- Test: `src/backend/test/launch-command.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/launch-command.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchCommand, shellSingleQuote } from '../pty/launch-command';

test('shellSingleQuote wraps and escapes single quotes', () => {
  assert.equal(shellSingleQuote(`it's`), `'it'\\''s'`);
  assert.equal(shellSingleQuote('plain'), `'plain'`);
});

test('claude_code new thread appends the system prompt', () => {
  const cmd = buildLaunchCommand({ provider: 'claude_code', systemPrompt: 'Be terse.' });
  assert.equal(cmd, `claude --append-system-prompt 'Be terse.'`);
});

test('claude_code with a session id resumes (ignores system prompt)', () => {
  const cmd = buildLaunchCommand({ provider: 'claude_code', systemPrompt: 'x', sessionId: 'abc-123' });
  assert.equal(cmd, 'claude --resume abc-123');
});

test('claude_code ignores an unsafe session id and falls back to append', () => {
  const cmd = buildLaunchCommand({ provider: 'claude_code', systemPrompt: 'x', sessionId: 'bad; rm -rf /' });
  assert.equal(cmd, `claude --append-system-prompt 'x'`);
});

test('claude_code with no system prompt is bare claude', () => {
  assert.equal(buildLaunchCommand({ provider: 'claude_code' }), 'claude');
});

test('codex returns the codex CLI', () => {
  assert.equal(buildLaunchCommand({ provider: 'codex', systemPrompt: 'x' }), 'codex');
});

test('other providers get an empty command (plain shell)', () => {
  assert.equal(buildLaunchCommand({ provider: 'openrouter', systemPrompt: 'x' }), '');
  assert.equal(buildLaunchCommand({ provider: 'local' }), '');
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `npm --workspace=src/backend test`
Expected: FAIL — cannot find module `../pty/launch-command`.

- [ ] **Step 3: Implement**

Create `src/backend/pty/launch-command.ts`:

```ts
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** POSIX single-quote a string for safe inclusion in a shell command. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchOpts {
  provider: string;
  systemPrompt?: string;
  sessionId?: string | null;
}

/**
 * Build the command pre-typed (not executed) into a fresh terminal thread.
 * Persona context rides in via the CLI's own system-prompt flag — the repo is never mutated.
 * Returns '' for providers without a terminal CLI (plain shell).
 */
export function buildLaunchCommand({ provider, systemPrompt, sessionId }: LaunchOpts): string {
  if (provider === 'claude_code') {
    if (sessionId && SAFE_SESSION_ID.test(sessionId)) return `claude --resume ${sessionId}`;
    if (systemPrompt && systemPrompt.trim()) return `claude --append-system-prompt ${shellSingleQuote(systemPrompt)}`;
    return 'claude';
  }
  if (provider === 'codex') return 'codex';
  return '';
}
```

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `npm --workspace=src/backend test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/pty/launch-command.ts src/backend/test/launch-command.test.ts
git commit -m "feat(backend): persona-aware PTY launch-command builder + tests"
```

---

## Task 6: Bounded scrollback buffer (TDD)

**Files:**
- Create: `src/backend/pty/scrollback.ts`
- Test: `src/backend/test/scrollback.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/scrollback.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollbackBuffer } from '../pty/scrollback';

test('accumulates appended chunks in order', () => {
  const b = new ScrollbackBuffer(1000);
  b.append('foo'); b.append('bar');
  assert.equal(b.snapshot(), 'foobar');
});

test('trims oldest chunks when exceeding the byte cap', () => {
  const b = new ScrollbackBuffer(5); // tiny cap
  b.append('aaa'); b.append('bbb'); b.append('ccc');
  // oldest chunks dropped until under cap; newest always retained
  const snap = b.snapshot();
  assert.ok(snap.endsWith('ccc'), 'keeps newest chunk');
  assert.ok(snap.length <= 6, `trimmed near cap, got ${snap.length}`);
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `npm --workspace=src/backend test`
Expected: FAIL — cannot find module `../pty/scrollback`.

- [ ] **Step 3: Implement**

Create `src/backend/pty/scrollback.ts`:

```ts
/** A bounded FIFO buffer of terminal output, replayed to newly-attached clients. */
export class ScrollbackBuffer {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly maxBytes = 200_000) {}

  append(data: string): void {
    this.chunks.push(data);
    this.size += data.length;
    while (this.size > this.maxBytes && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
```

- [ ] **Step 4: Run the test, confirm it PASSES**

Run: `npm --workspace=src/backend test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/pty/scrollback.ts src/backend/test/scrollback.test.ts
git commit -m "feat(backend): bounded scrollback buffer + tests"
```

---

## Task 7: PTY manager with injectable spawn (TDD)

The registry: one persistent session per `threadId`, multiple attached clients, scrollback replay, idle reaping. Spawn is injected so it's testable with a fake PTY.

**Files:**
- Create: `src/backend/pty/manager.ts`
- Test: `src/backend/test/pty-manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/pty-manager.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtyManager, type PtyLike } from '../pty/manager';

function fakePty() {
  const calls = { writes: [] as string[], resizes: [] as [number, number][], killed: false };
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: (() => void) | null = null;
  const pty: PtyLike = {
    onData: cb => { dataCb = cb; },
    onExit: cb => { exitCb = cb; },
    write: d => { calls.writes.push(d); },
    resize: (c, r) => { calls.resizes.push([c, r]); },
    kill: () => { calls.killed = true; exitCb?.(); },
  };
  return { pty, calls, emit: (d: string) => dataCb?.(d) };
}

test('creating a session writes the launch command and spawns once', () => {
  const f = fakePty();
  let spawned = 0;
  const mgr = new PtyManager({ spawn: () => { spawned++; return f.pty; } });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: 'claude' });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: 'claude' }); // second attach reuses
  assert.equal(spawned, 1, 'spawns one PTY per threadId');
  assert.ok(f.calls.writes.includes('claude'), 'pre-types the launch command');
});

test('a newly attached client receives the scrollback snapshot', () => {
  const f = fakePty();
  const mgr = new PtyManager({ spawn: () => f.pty });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  f.emit('hello world');
  const received: string[] = [];
  mgr.attach('t1', d => received.push(d));
  assert.ok(received.join('').includes('hello world'), 'replays scrollback to new client');
});

test('input and resize reach the PTY', () => {
  const f = fakePty();
  const mgr = new PtyManager({ spawn: () => f.pty });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  mgr.input('t1', 'ls\r');
  mgr.resize('t1', 120, 40);
  assert.ok(f.calls.writes.includes('ls\r'));
  assert.deepEqual(f.calls.resizes.at(-1), [120, 40]);
});

test('close kills the PTY and forgets the session', () => {
  const f = fakePty();
  let spawned = 0;
  const mgr = new PtyManager({ spawn: () => { spawned++; return f.pty; } });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  mgr.close('t1');
  assert.ok(f.calls.killed, 'kills the PTY');
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  assert.equal(spawned, 2, 'a fresh PTY spawns after close');
});
```

- [ ] **Step 2: Run the test, confirm it FAILS**

Run: `npm --workspace=src/backend test`
Expected: FAIL — cannot find module `../pty/manager`.

- [ ] **Step 3: Implement**

Create `src/backend/pty/manager.ts`:

```ts
import { ScrollbackBuffer } from './scrollback';

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface SpawnCtx {
  cwd: string;
  cols: number;
  rows: number;
  launchCommand: string;
}

export type SpawnFn = (ctx: SpawnCtx) => PtyLike;

interface Session {
  pty: PtyLike;
  buffer: ScrollbackBuffer;
  clients: Set<(data: string) => void>;
  lastActive: number;
  launched: boolean;
}

/** When the launch command is written after spawn (lets the shell print its first prompt). */
const LAUNCH_DELAY_MS = 400;

export class PtyManager {
  private sessions = new Map<string, Session>();
  constructor(private readonly opts: { spawn: SpawnFn; now?: () => number }) {}

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Ensure a session exists for threadId; spawn + pre-type the launch command if new. */
  open(threadId: string, ctx: SpawnCtx): void {
    if (this.sessions.has(threadId)) return;
    const pty = this.opts.spawn(ctx);
    const session: Session = { pty, buffer: new ScrollbackBuffer(), clients: new Set(), lastActive: this.clock(), launched: false };
    pty.onData(data => {
      session.buffer.append(data);
      session.lastActive = this.clock();
      for (const send of session.clients) send(data);
    });
    pty.onExit(() => this.sessions.delete(threadId));
    this.sessions.set(threadId, session);

    if (ctx.launchCommand) {
      const write = () => { if (this.sessions.has(threadId)) { pty.write(ctx.launchCommand); session.launched = true; } };
      // setTimeout in prod; tests inject now() and rely on immediate write below.
      if (this.opts.now) write();
      else setTimeout(write, LAUNCH_DELAY_MS);
    }
  }

  /** Register a client and replay scrollback. */
  attach(threadId: string, send: (data: string) => void): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    const snap = s.buffer.snapshot();
    if (snap) send(snap);
    s.clients.add(send);
    s.lastActive = this.clock();
  }

  detach(threadId: string, send: (data: string) => void): void {
    this.sessions.get(threadId)?.clients.delete(send);
  }

  input(threadId: string, data: string): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    s.pty.write(data);
    s.lastActive = this.clock();
  }

  resize(threadId: string, cols: number, rows: number): void {
    this.sessions.get(threadId)?.pty.resize(cols, rows);
  }

  /** Kill + forget a session (explicit close / thread delete). */
  close(threadId: string): void {
    const s = this.sessions.get(threadId);
    if (!s) return;
    this.sessions.delete(threadId);
    s.pty.kill();
  }

  /** Reap sessions with no clients idle beyond maxIdleMs. */
  reap(maxIdleMs: number): void {
    const cutoff = this.clock() - maxIdleMs;
    for (const [id, s] of this.sessions) {
      if (s.clients.size === 0 && s.lastActive < cutoff) this.close(id);
    }
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
```

> Test note: the tests construct `new PtyManager({ spawn })` without `now`, so the launch-command write happens via `setTimeout`. To keep the first test synchronous, the implementation writes immediately when `now` is injected; the provided test asserts on `writes.includes('claude')` and passes because the first test does NOT inject `now`… so adjust: in the first test, pass `{ spawn, now: () => 1000 }` to force the synchronous write. Update that test's manager construction to `new PtyManager({ spawn: () => { spawned++; return f.pty; }, now: () => 1000 })`.

- [ ] **Step 4: Apply the test note, run, confirm PASS**

Edit `pty-manager.test.ts` first test to inject `now: () => 1000` as described, then run `npm --workspace=src/backend test`.
Expected: PASS (all manager tests + prior suite).

- [ ] **Step 5: Commit**

```bash
git add src/backend/pty/manager.ts src/backend/test/pty-manager.test.ts
git commit -m "feat(backend): PTY manager registry with injectable spawn + tests"
```

---

## Task 8: node-pty adapter

**Files:** Create `src/backend/pty/node-pty-adapter.ts`

- [ ] **Step 1: Implement the real spawn**

Create `src/backend/pty/node-pty-adapter.ts`:

```ts
import * as nodePty from 'node-pty';
import type { PtyLike, SpawnFn } from './manager';

const SHELL = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh');

/** Real PTY spawn backed by node-pty, adapted to the manager's PtyLike interface. */
export const spawnNodePty: SpawnFn = ({ cwd, cols, rows }) => {
  const proc = nodePty.spawn(SHELL, [], {
    name: 'xterm-color',
    cwd,
    cols,
    rows,
    env: process.env as { [key: string]: string },
  });
  const adapter: PtyLike = {
    onData: cb => proc.onData(cb),
    onExit: cb => proc.onExit(() => cb()),
    write: data => proc.write(data),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  };
  return adapter;
};
```

- [ ] **Step 2: Verify it typechecks**

Run: `npm run --workspace=src/backend typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/backend/pty/node-pty-adapter.ts
git commit -m "feat(backend): node-pty adapter for the PTY manager"
```

---

## Task 9: PTY WebSocket route + server registration

**Files:**
- Create: `src/backend/routes/pty.ts`
- Modify: `src/backend/index.ts`

- [ ] **Step 1: Create the route**

Create `src/backend/routes/pty.ts`:

```ts
import { FastifyInstance } from 'fastify';
import { getDb } from '../db';
import { ChatThread } from '@nexus/shared';
import { PtyManager } from '../pty/manager';
import { spawnNodePty } from '../pty/node-pty-adapter';
import { buildLaunchCommand } from '../pty/launch-command';
import { parsePersonaLaunch } from '../persona-launch';

const manager = new PtyManager({ spawn: spawnNodePty });
const REAP_INTERVAL_MS = 60_000;
const MAX_IDLE_MS = 30 * 60_000;
const reaper = setInterval(() => manager.reap(MAX_IDLE_MS), REAP_INTERVAL_MS);
reaper.unref?.();

export async function registerPtyRoutes(fastify: FastifyInstance) {
  const db = getDb();

  fastify.get('/api/threads/:threadId/pty', { websocket: true }, (socket, req) => {
    const { threadId } = req.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) { socket.close(1008, 'thread not found'); return; }

    const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as { repo_path: string } | undefined;
    const cwd = project?.repo_path || process.cwd();

    const persona = db.prepare('SELECT config_yaml FROM personas WHERE slug = ?').get(thread.agent_id) as { config_yaml: string } | undefined;
    const launch = persona ? parsePersonaLaunch(persona.config_yaml) : { provider: '', systemPrompt: '' };
    const launchCommand = buildLaunchCommand({ provider: launch.provider, systemPrompt: launch.systemPrompt, sessionId: thread.agent_session_id ?? undefined });

    manager.open(threadId, { cwd, cols: 80, rows: 24, launchCommand });

    const send = (data: string) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'output', data })); };
    manager.attach(threadId, send);

    socket.on('message', (raw: Buffer) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input' && typeof msg.data === 'string') manager.input(threadId, msg.data);
      else if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') manager.resize(threadId, msg.cols, msg.rows);
    });

    socket.on('close', () => manager.detach(threadId, send));
  });
}
```

- [ ] **Step 2: Add the `parsePersonaLaunch` helper**

Create `src/backend/persona-launch.ts`:

```ts
import yaml from 'js-yaml';

export interface PersonaLaunch {
  provider: string;
  systemPrompt: string;
}

/** Extract the launch-relevant fields (provider + system prompt) from a persona's config_yaml. */
export function parsePersonaLaunch(configYaml: string): PersonaLaunch {
  let cfg: { provider?: unknown; system_prompt?: unknown } = {};
  try { cfg = (yaml.load(configYaml) as typeof cfg) ?? {}; } catch { /* defaults */ }
  return {
    provider: typeof cfg.provider === 'string' ? cfg.provider : '',
    systemPrompt: typeof cfg.system_prompt === 'string' ? cfg.system_prompt : '',
  };
}
```

- [ ] **Step 3: Register the websocket plugin + route**

In `src/backend/index.ts`:

Add an import near the other route imports:
```ts
import websocket from '@fastify/websocket';
import { registerPtyRoutes } from './routes/pty';
```

Register the plugin BEFORE the routes (after `await app.register(sensible);`):
```ts
  await app.register(websocket);
```

Register the route alongside the others:
```ts
  app.register(registerPtyRoutes);
```

- [ ] **Step 4: Verify typecheck + tests + boot**

Run: `npm run --workspace=src/shared build && npm run --workspace=src/backend typecheck && npm --workspace=src/backend test`
Expected: PASS (suite unchanged at the new total; route is integration-tested manually in Task 12).

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/pty.ts src/backend/persona-launch.ts src/backend/index.ts
git commit -m "feat(backend): PTY WebSocket route + @fastify/websocket registration"
```

---

## Task 10: Frontend TerminalPane + WS URL helper

**Files:**
- Create: `src/frontend/src/components/TerminalPane.tsx`
- Modify: `src/frontend/src/api.ts`

- [ ] **Step 1: Add a PTY WebSocket URL helper to `api.ts`**

The API base is `__NEXUS_API__` (Electron) or `/api` (Vite-proxied dev). Add near the top of `src/frontend/src/api.ts`, after the `API` const:

```ts
/** Build the ws:// URL for a thread's PTY, derived from the API base. */
export function ptyWsUrl(threadId: string): string {
  const httpBase = API.startsWith('http')
    ? API
    : `${window.location.origin}${API.startsWith('/') ? API : `/${API}`}`;
  const wsBase = httpBase.replace(/^http/, 'ws');
  return `${wsBase}/threads/${threadId}/pty`;
}
```

- [ ] **Step 2: Create the terminal component**

Create `src/frontend/src/components/TerminalPane.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { ptyWsUrl } from '../api';

export default function TerminalPane({ threadId }: { threadId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#09090b' }, // zinc-950
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const ws = new WebSocket(ptyWsUrl(threadId));
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'output') term.write(msg.data);
      } catch { /* ignore non-JSON frames */ }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));

    const dataSub = term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    const onResize = () => {
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      dataSub.dispose();
      ws.close();
      term.dispose();
    };
  }, [threadId]);

  return <div ref={hostRef} className="h-full w-full bg-zinc-950 p-2" />;
}
```

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS. (If TS complains about the xterm CSS import, ensure `vite-env.d.ts`/module CSS handling is in place — Vite handles `.css` imports natively, so no change is usually needed.)

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/TerminalPane.tsx src/frontend/src/api.ts
git commit -m "feat(frontend): TerminalPane (xterm) + ptyWsUrl helper"
```

---

## Task 11: Wire mode through the UI

**Files:**
- Modify: `src/frontend/src/api.ts` (createThread mode param)
- Modify: `src/frontend/src/components/NewChatPicker.tsx` (mode toggle)
- Modify: `src/frontend/src/App.tsx` (pass mode; route terminal threads)
- Modify: `src/frontend/src/components/Sidebar.tsx` (terminal glyph)

- [ ] **Step 1: Widen `createThread` to accept mode**

In `src/frontend/src/api.ts`, change the `createThread` entry:

```ts
    createThread: (projectId: string, agentId: string, mode: 'chat' | 'terminal' = 'chat') =>
      fetchJson<ChatThread>(`${API}/projects/${projectId}/threads`, { method: 'POST', body: JSON.stringify({ agent_id: agentId, mode }) }),
```

- [ ] **Step 2: Add the mode toggle to `NewChatPicker`**

In `src/frontend/src/components/NewChatPicker.tsx`, widen `onStart` and add a mode radio. Change the prop type:

```tsx
  onStart: (slug: string, mode: 'chat' | 'terminal') => void;
```

Add mode state after `selected`:

```tsx
  const [mode, setMode] = useState<'chat' | 'terminal'>('chat');
```

Insert before the Cancel/Start row:

```tsx
      <div className="flex gap-1 px-1 pt-2">
        {(['chat', 'terminal'] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 px-2 py-1 text-xs rounded-md border transition-colors ${mode === m ? 'border-indigo-500 bg-indigo-500/10 text-white' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600'}`}
          >
            {m === 'chat' ? 'Chat' : 'Terminal'}
          </button>
        ))}
      </div>
```

Change the Start button handler to `onClick={() => onStart(selected, mode)}`.

- [ ] **Step 3: Pass mode through `App.startNewChat` + route terminal threads**

In `src/frontend/src/App.tsx`, update `startNewChat`:

```tsx
const startNewChat = async (slug: string, mode: 'chat' | 'terminal') => {
  if (!newChat) return;
  const thread = await api.chat.createThread(newChat.projectId, slug, mode);
  setNewChat(null);
  await loadThreads(newChat.projectId);
  selectThread(newChat.projectId, thread.id);
};
```

In `renderMain`, where `subView === 'chat'` renders `ChatPanel`, branch on the active thread's mode. Resolve the active thread from `threads`:

```tsx
if (subView === 'chat') {
  const active = threads.find(t => t.id === activeThreadId);
  if (active?.mode === 'terminal') return <TerminalPane key={active.id} threadId={active.id} />;
  return <ChatPanel projectId={activeProject.id} threadId={activeThreadId} agentSlug={active?.agent_id} onThreadsChanged={() => loadThreads(activeProject.id)} agents={status?.agents} />;
}
```

Add `import TerminalPane from './components/TerminalPane';` at the top.

- [ ] **Step 4: Terminal glyph in the tree**

In `src/frontend/src/components/Sidebar.tsx`, import a terminal icon: add `Terminal` to the `@phosphor-icons/react` import. In the thread-row `Row` for threads, show the glyph for terminal threads by passing a `trailing` prop:

```tsx
trailing={thread.mode === 'terminal' ? <Terminal size={12} className="text-zinc-500" /> : undefined}
```

(`thread` is the `ChatThread` from `ThreadMeta`; `mode` is now on it.)

- [ ] **Step 5: Verify typecheck + build**

Run: `npm run --workspace=src/shared build && npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/api.ts src/frontend/src/components/NewChatPicker.tsx src/frontend/src/App.tsx src/frontend/src/components/Sidebar.tsx
git commit -m "feat(frontend): wire terminal mode through picker, tree, and routing"
```

---

## Task 12: End-to-end verification

- [ ] **Step 1: Backend tests + typecheck**

Run: `npm run --workspace=src/shared build && npm --workspace=src/backend test && npm run --workspace=src/backend typecheck`
Expected: PASS, including launch-command, scrollback, pty-manager, and chat-thread-mode tests.

- [ ] **Step 2: Frontend typecheck + build**

Run: `npm run --workspace=src/frontend typecheck && npm run --workspace=src/frontend build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (dev)**

Run `npm run dev`. Then:
- Expand a project → Chat → `+ New` → pick a **Claude Code** persona → choose **Terminal** → Start.
- The main area shows an embedded terminal `cwd`'d to the repo, with `claude --append-system-prompt '…'` pre-typed (NOT executed). Press Enter to run it.
- The thread row in the tree shows the terminal glyph.
- Switch to Kanban and back to the thread → the **same** terminal session is still alive with its scrollback (persistent PTY).
- Start a second terminal thread → independent session.
- Start a **Chat**-mode thread → still renders the bubble UI (no regression).
- Resize the window → terminal reflows.

- [ ] **Step 4: node-pty packaging check (release only)**

Before packaging the Electron app, confirm `node-pty` is rebuilt for the system Node ABI the backend runs under (same step that handles `better-sqlite3`). Run the packaged app and open a terminal thread to confirm the native module loads. If it fails with a NODE_MODULE_VERSION mismatch, add `node-pty` to the electron-rebuild/`@electron/rebuild` target list.

- [ ] **Step 5: Final commit (if stragglers)**

```bash
git add -A && git commit -m "chore: phase-2 embedded terminal verification fixes"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** mode chosen at creation (T2/T4/T11), `chat_threads.mode` migration (T3), `node-pty` + `xterm.js` over a 127.0.0.1 WebSocket (T1/T9/T10), persona pre-fill via `--append-system-prompt`/`--resume` without mutating the repo (T5/T9), persistent PTY keyed by threadId surviving navigation + scrollback replay + idle reaper (T6/T7/T9), terminal glyph in the tree (T11), Chat-mode unaffected (T11), packaging note (T1/T12). Out of scope per spec: terminal↔chat history sync, cross-restart resurrection.
- **Type consistency:** `ChatMode`/`mode` (shared) used in chat route + picker + api + routing; `PtyLike`/`SpawnFn`/`SpawnCtx` consistent across manager, adapter, and tests; `buildLaunchCommand({provider, systemPrompt, sessionId})` signature identical in T5 and T9; WS frame shapes (`{type:'output'|'input'|'resize', …}`) identical in route (T9) and TerminalPane (T10).
- **Known sharp edge:** the launch-command write timing (T7 `LAUNCH_DELAY_MS`) is best-effort; if a shell is slow to print its first prompt the pre-typed text could interleave. Acceptable for v1; revisit with a prompt-readiness probe if it misbehaves.
- **Reaper lifetime:** the `setInterval` in `pty.ts` is module-scoped and `unref()`'d so it won't hold the process open; `manager.shutdown()` should be called on server close if/when the backend adds a shutdown hook (optional follow-up).
```
