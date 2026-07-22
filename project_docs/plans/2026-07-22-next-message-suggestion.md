# Next-Message Suggestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an assistant turn finishes, offer the user's likely next message as dim placeholder text in the composer, accepted with `Tab`.

**Architecture:** A second, small model call — never prompt injection into the main turn. The frontend fires `POST /api/next-message` after the stream closes, passing the transcript it already holds. The backend validates and bounds it, renders it to a string, and forwards to the memory daemon's local gen model. Every failure degrades to "no placeholder"; nothing about this path may ever surface an error to the user or slow a chat turn.

**Spec:** [`project_docs/design/2026-07-22-next-message-suggestion-design.md`](../design/2026-07-22-next-message-suggestion-design.md)

**Tech Stack:** TypeScript throughout. Backend + daemon: Fastify, tests via `node:test` (`tsx --test`). Frontend: React + Vite, tests via Vitest + `@testing-library/react`.

## Global Constraints

- **Failure is silent.** An unreachable daemon or a slow model produces `{ suggestion: '' }` and a `console.error` — never a non-2xx, never a toast, never a banner. Model this on [`src/backend/sessions/auto-title.ts`](../../src/backend/sessions/auto-title.ts), which states the same contract in its header.
- **Never block a chat turn.** This path runs strictly after the NDJSON stream closes.
- **Caps, copied verbatim from the spec:** max 20 turns; max 2000 chars per turn; max 8000 chars of rendered context; suggestion capped at 160 chars.
- **Daemon model params, verbatim:** `temperature: 0.3`, `maxTokens: 48`, `timeoutMs: 20_000`.
- **The suggestion only ever renders when the composer is empty.** This is what allows it to live in the textarea's `placeholder` attribute rather than an overlay.
- **`Tab` accepts into the input; it does not send.**
- Backend and daemon are separate npm installs. Run each package's tests from its own directory.

---

### Task 1: Daemon route — `generate-next-message`

**Files:**
- Modify: `src/memory-daemon/src/routes/operations.ts`
- Create: `src/memory-daemon/test/next-message.test.ts`

**Interfaces:**
- Consumes: `ctx.models.complete(prompt, opts)` and `ModelError`, both already imported in `operations.ts`.
- Produces: `POST /operations/generate-next-message` accepting `{ transcript: string }` and returning `{ suggestion: string }`; exported `cleanSuggestion(raw: string): string`.

`cleanSuggestion` is exported for the same reason `cleanSessionTitle` is — it holds all the risk, and exporting it means it can be unit-tested without booting Fastify.

- [ ] **Step 1: Write the failing test**

Create `src/memory-daemon/test/next-message.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanSuggestion } from '../src/routes/operations';

test('keeps a clean suggestion untouched', () => {
  assert.equal(cleanSuggestion('run the tests'), 'run the tests');
});

test('strips wrapping quotes and label preamble', () => {
  assert.equal(cleanSuggestion('"run the tests"'), 'run the tests');
  assert.equal(cleanSuggestion('Next message: run the tests'), 'run the tests');
  assert.equal(cleanSuggestion('User: run the tests'), 'run the tests');
  assert.equal(cleanSuggestion('Suggestion: "run the tests"'), 'run the tests');
});

test('keeps only the first non-empty line', () => {
  assert.equal(cleanSuggestion('\n\nrun the tests\nthen deploy'), 'run the tests');
});

test('preserves a trailing question mark but drops stray punctuation', () => {
  assert.equal(cleanSuggestion('what broke?'), 'what broke?');
  assert.equal(cleanSuggestion('run the tests.'), 'run the tests');
  assert.equal(cleanSuggestion('run the tests ...'), 'run the tests');
});

test('caps length at 160 chars', () => {
  assert.equal(cleanSuggestion('x'.repeat(300)).length, 160);
});

test('returns empty string for empty or decoration-only output', () => {
  assert.equal(cleanSuggestion(''), '');
  assert.equal(cleanSuggestion('   \n  '), '');
  assert.equal(cleanSuggestion('""'), '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/memory-daemon`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: FAIL — `cleanSuggestion` is not exported from `operations.ts`.

- [ ] **Step 3: Add the constants and the cleaner**

In `src/memory-daemon/src/routes/operations.ts`, after the existing `cleanSessionTitle` function (around line 38):

```ts
const NEXT_MESSAGE_SYSTEM_PROMPT =
  "You predict the user's next message in a coding session. Read the transcript and reply with " +
  "the single most likely thing the user will say next, in their voice, as a short instruction " +
  "or question. Reply with that message alone: no quotes, no preamble, no explanation. Reply " +
  "with nothing at all if the next move is not predictable.";

/** Generous on purpose: a late suggestion costs nothing because the frontend
 *  discards anything that lands after the user has started typing or moved on.
 *  Short enough that a wedged gen server never pins a request open. */
const NEXT_MESSAGE_TIMEOUT_MS = 20_000;

/** Same decoration problem as `cleanSessionTitle`: small local models prepend
 *  labels and wrap output in quotes however firmly the prompt forbids it. A
 *  trailing '?' is meaning, not decoration, so it survives. */
export function cleanSuggestion(raw: string): string {
  const firstLine = raw.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return firstLine
    .replace(/^(?:next\s+message|suggestion|user|message)\s*:\s*/i, "")
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.,;:\s]+$/, "")
    .trim()
    .slice(0, 160);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `src/memory-daemon`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Add the route**

In the same file, immediately after the `POST /operations/generate-session-title` handler closes (before the final `}` of `registerOperationRoutes`):

```ts
  app.post("/operations/generate-next-message", async (request, reply) => {
    const transcript = ((request.body ?? {}) as { transcript?: string }).transcript?.trim();
    if (!transcript) return reply.code(400).send({ error: "transcript is required" });

    try {
      const suggestion = cleanSuggestion(await ctx.models.complete(transcript, {
        system: NEXT_MESSAGE_SYSTEM_PROMPT,
        temperature: 0.3,
        maxTokens: 48,
        timeoutMs: NEXT_MESSAGE_TIMEOUT_MS,
      }));
      return { suggestion };
    } catch (err) {
      const detail = err instanceof ModelError ? err.message : undefined;
      return reply.code(502).send({ error: "Next message model failed", detail });
    }
  });
```

Note the deliberate asymmetry with `generate-session-title`: an empty result here returns `200 { suggestion: "" }` rather than a 502, because "nothing worth suggesting" is a valid outcome, not a failure.

- [ ] **Step 6: Verify the daemon still typechecks and its full suite passes**

Run from `src/memory-daemon`:

```bash
npm run typecheck && npm test
```

Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/memory-daemon/src/routes/operations.ts src/memory-daemon/test/next-message.test.ts
git commit -m "feat(daemon): add generate-next-message operation"
```

---

### Task 2: Backend suggestion logic

**Files:**
- Create: `src/backend/sessions/next-message.ts`
- Modify: `src/backend/memory/client.ts`
- Create: `src/backend/test/next-message.test.ts`

**Interfaces:**
- Consumes: `daemon` from `../memory/client.js`; the daemon route from Task 1.
- Produces:
  - `interface TranscriptTurn { role: 'user' | 'assistant'; text: string }`
  - `parseTranscript(value: unknown): TranscriptTurn[] | null`
  - `renderTranscript(turns: TranscriptTurn[]): string`
  - `suggestNextMessage(turns: TranscriptTurn[], deps?: { generate?: (transcript: string) => Promise<string> }): Promise<string>`
  - `daemon.generateNextMessage(input: { transcript: string }): Promise<{ suggestion: string }>`

The `deps.generate` injection mirrors `autoTitleSession` so route tests never need a live model.

- [ ] **Step 1: Write the failing test**

Create `src/backend/test/next-message.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTEXT_CHARS,
  MAX_TURNS,
  MAX_TURN_CHARS,
  parseTranscript,
  renderTranscript,
  suggestNextMessage,
} from '../sessions/next-message';

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `m${i}` }));

test('parseTranscript rejects anything that is not an array of turns', () => {
  assert.equal(parseTranscript(undefined), null);
  assert.equal(parseTranscript('nope'), null);
  assert.equal(parseTranscript({}), null);
  assert.equal(parseTranscript([{ role: 'system', text: 'x' }]), null);
  assert.equal(parseTranscript([{ role: 'user' }]), null);
});

test('parseTranscript accepts a well-formed transcript', () => {
  assert.deepEqual(parseTranscript([{ role: 'user', text: 'hi' }]), [{ role: 'user', text: 'hi' }]);
});

test('parseTranscript keeps only the last MAX_TURNS turns', () => {
  const parsed = parseTranscript(turns(MAX_TURNS + 5));
  assert.equal(parsed?.length, MAX_TURNS);
  assert.equal(parsed?.[parsed.length - 1].text, `m${MAX_TURNS + 4}`);
});

test('parseTranscript caps each turn at MAX_TURN_CHARS', () => {
  const parsed = parseTranscript([{ role: 'user', text: 'x'.repeat(MAX_TURN_CHARS + 500) }]);
  assert.equal(parsed?.[0].text.length, MAX_TURN_CHARS);
});

test('renderTranscript labels turns and caps total context', () => {
  assert.equal(
    renderTranscript([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]),
    'User: hi\n\nAssistant: hello',
  );
  const long = renderTranscript(
    Array.from({ length: MAX_TURNS }, () => ({ role: 'user' as const, text: 'x'.repeat(MAX_TURN_CHARS) })),
  );
  assert.ok(long.length <= MAX_CONTEXT_CHARS);
});

test('renderTranscript keeps the most recent turns when it has to truncate', () => {
  const rendered = renderTranscript([
    { role: 'user', text: 'x'.repeat(MAX_CONTEXT_CHARS) },
    { role: 'assistant', text: 'the newest thing' },
  ]);
  assert.ok(rendered.endsWith('the newest thing'));
});

test('suggestNextMessage skips the model when there is no assistant turn', async () => {
  let called = false;
  const suggestion = await suggestNextMessage([{ role: 'user', text: 'hi' }], {
    generate: async () => { called = true; return 'run the tests'; },
  });
  assert.equal(suggestion, '');
  assert.equal(called, false);
});

test('suggestNextMessage returns the generated suggestion', async () => {
  const suggestion = await suggestNextMessage(
    [{ role: 'user', text: 'add a test' }, { role: 'assistant', text: 'done' }],
    { generate: async () => 'run the tests' },
  );
  assert.equal(suggestion, 'run the tests');
});

test('suggestNextMessage swallows a generator failure', async () => {
  const suggestion = await suggestNextMessage(
    [{ role: 'user', text: 'add a test' }, { role: 'assistant', text: 'done' }],
    { generate: async () => { throw new Error('daemon unreachable'); } },
  );
  assert.equal(suggestion, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/backend`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: FAIL — cannot find module `../sessions/next-message`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/sessions/next-message.ts`:

```ts
/**
 * Predict the user's next message from the tail of a conversation.
 *
 * The caller supplies the transcript rather than the server re-reading it: every
 * surface that wants a suggestion (chat, assistant, the glasses cockpit) is
 * already holding the messages it has just rendered, so this stays stateless —
 * no db reads, no session resolution, no per-surface code.
 *
 * Failure is silent by design, exactly as in `auto-title.ts`. This runs after a
 * chat turn has already completed, and a suggestion is a courtesy: an
 * unreachable daemon or a slow model must produce no placeholder, never an
 * error the user has to acknowledge.
 */
import { daemon } from '../memory/client.js';

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** The model only needs the recent tail; older turns add latency, not signal. */
export const MAX_TURNS = 20;
/** One pasted stack trace should not crowd out the surrounding conversation. */
export const MAX_TURN_CHARS = 2000;
/** Total prompt ceiling, sized so a queued call still returns inside the timeout. */
export const MAX_CONTEXT_CHARS = 8000;

export interface NextMessageDeps {
  generate?: (transcript: string) => Promise<string>;
}

/** Returns the bounded turns, or null when the input is not a transcript at all. */
export function parseTranscript(value: unknown): TranscriptTurn[] | null {
  if (!Array.isArray(value)) return null;
  const turns: TranscriptTurn[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { role, text } = raw as { role?: unknown; text?: unknown };
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof text !== 'string') return null;
    turns.push({ role, text: text.slice(0, MAX_TURN_CHARS) });
  }
  return turns.slice(-MAX_TURNS);
}

/** Flatten to the labelled form the daemon's archive summariser already uses. */
export function renderTranscript(turns: TranscriptTurn[]): string {
  const rendered = turns
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.text}`)
    .join('\n\n');
  // Truncate from the front: the newest turns carry the intent being predicted.
  return rendered.length > MAX_CONTEXT_CHARS ? rendered.slice(-MAX_CONTEXT_CHARS) : rendered;
}

/** Returns the suggestion, or '' for "nothing worth offering". Never throws. */
export async function suggestNextMessage(
  turns: TranscriptTurn[],
  deps: NextMessageDeps = {},
): Promise<string> {
  // Nothing to predict from until the assistant has actually said something.
  if (!turns.some((turn) => turn.role === 'assistant' && turn.text.trim())) return '';

  const generate = deps.generate ?? generateWithMemoryDaemon;
  try {
    return (await generate(renderTranscript(turns))).trim();
  } catch (err: any) {
    console.error('[next-message]', err?.message);
    return '';
  }
}

async function generateWithMemoryDaemon(transcript: string): Promise<string> {
  const res = await daemon.generateNextMessage({ transcript });
  return String(res.suggestion ?? '');
}
```

- [ ] **Step 4: Add the daemon client method**

In `src/backend/memory/client.ts`, add the request/response types next to `SessionTitleRequest` (around line 93):

```ts
export interface NextMessageRequest {
  transcript: string;
}

export interface NextMessageResponse {
  suggestion: string;
}
```

and the method inside the exported `daemon` object, after `generateSessionTitle`:

```ts
  generateNextMessage(input: NextMessageRequest) {
    return req<NextMessageResponse>('POST', '/operations/generate-next-message', input);
  },
```

- [ ] **Step 5: Run test to verify it passes**

Run from `src/backend`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Commit**

```bash
git add src/backend/sessions/next-message.ts src/backend/memory/client.ts src/backend/test/next-message.test.ts
git commit -m "feat(backend): next-message suggestion logic and daemon client method"
```

---

### Task 3: Backend route — `POST /api/next-message`

**Files:**
- Create: `src/backend/routes/next-message.ts`
- Modify: `src/backend/index.ts`
- Modify: `src/backend/test/next-message.test.ts`

**Interfaces:**
- Consumes: `parseTranscript`, `suggestNextMessage` from Task 2.
- Produces: `registerNextMessageRoutes(fastify: FastifyInstance): Promise<void>`, serving `POST /api/next-message`.

- [ ] **Step 1: Write the failing test**

Append to `src/backend/test/next-message.test.ts` (and add `import Fastify from 'fastify';` plus `import { registerNextMessageRoutes } from '../routes/next-message';` at the top):

```ts
async function routeApp() {
  const app = Fastify();
  await app.register(registerNextMessageRoutes);
  return app;
}

test('route rejects a malformed transcript with 400', async () => {
  const app = await routeApp();
  const res = await app.inject({ method: 'POST', url: '/api/next-message', payload: { transcript: 'nope' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('route returns an empty suggestion for a transcript with no assistant turn', async () => {
  const app = await routeApp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/next-message',
    payload: { transcript: [{ role: 'user', text: 'hi' }] },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { suggestion: '' });
  await app.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/backend`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: FAIL — cannot find module `../routes/next-message`.

- [ ] **Step 3: Write the route**

Create `src/backend/routes/next-message.ts`:

```ts
/**
 * `POST /api/next-message` — given the tail of a conversation, return the user's
 * likely next message for the composer to offer as a placeholder.
 *
 * Stateless on purpose: the caller passes the transcript it already holds, so
 * this route serves chat, the Assistant, and the glasses cockpit identically
 * with no per-surface code. See
 * `project_docs/design/2026-07-22-next-message-suggestion-design.md`.
 *
 * 400 on a malformed body is the only error status. A daemon that is down or a
 * model that fails returns `{ suggestion: '' }`, because the caller's behaviour
 * is the same either way: show no placeholder.
 */
import type { FastifyInstance } from 'fastify';
import { parseTranscript, suggestNextMessage } from '../sessions/next-message.js';

export async function registerNextMessageRoutes(fastify: FastifyInstance) {
  fastify.post('/api/next-message', async (request, reply) => {
    const turns = parseTranscript((request.body as { transcript?: unknown } | undefined)?.transcript);
    if (!turns) {
      reply.code(400);
      return { error: 'transcript must be an array of { role, text }' };
    }
    return { suggestion: await suggestNextMessage(turns) };
  });
}
```

- [ ] **Step 4: Register the route**

In `src/backend/index.ts`, add the import beside the other route imports (after line 32):

```ts
import { registerNextMessageRoutes } from './routes/next-message.js';
```

and register it beside the others (after `app.register(registerAssistantRoutes);`):

```ts
  app.register(registerNextMessageRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run from `src/backend`:

```bash
npx tsx --test test/next-message.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Verify the backend typechecks and its full suite passes**

Run from the repo root:

```bash
npm run --workspace=src/backend typecheck && npm run --workspace=src/backend test
```

Expected: no type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/next-message.ts src/backend/index.ts src/backend/test/next-message.test.ts
git commit -m "feat(backend): add POST /api/next-message"
```

---

### Task 4: Frontend hook — `useNextSuggestion`

**Files:**
- Create: `src/frontend/src/hooks/useNextSuggestion.ts`
- Create: `src/frontend/src/hooks/useNextSuggestion.test.ts`

**Interfaces:**
- Consumes: `apiFetch` from `../api-base`; `POST /api/next-message` from Task 3.
- Produces:
  - `interface SuggestionMessage { role: string; content: string }`
  - `useNextSuggestion(input: { sessionKey: string | null; turnKey: string | null; messages: SuggestionMessage[]; enabled: boolean }): { suggestion: string; dismiss: () => void }`

`messages` is each surface's own list; only `user`/`assistant` roles with non-empty content are sent. `turnKey` is the trailing assistant message's id — it changes once per turn, so it is both the fire trigger and the staleness token.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/hooks/useNextSuggestion.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useNextSuggestion } from './useNextSuggestion';

const MESSAGES = [
  { role: 'user', content: 'add a test' },
  { role: 'assistant', content: 'done' },
];

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ suggestion: 'run the tests' }),
  }) as unknown as Response);
});

describe('useNextSuggestion', () => {
  it('fetches a suggestion once a turn completes', async () => {
    const { result } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'run-1', messages: MESSAGES, enabled: true }));
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
  });

  it('does not fetch while disabled', async () => {
    renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'run-1', messages: MESSAGES, enabled: false }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not fetch without a completed turn', async () => {
    renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: null, messages: MESSAGES, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends only user and assistant turns as { role, text }', async () => {
    renderHook(() => useNextSuggestion({
      sessionKey: 't1',
      turnKey: 'run-1',
      messages: [...MESSAGES, { role: 'toolResult', content: 'noise' }, { role: 'user', content: '  ' }],
      enabled: true,
    }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.transcript).toEqual([
      { role: 'user', text: 'add a test' },
      { role: 'assistant', text: 'done' },
    ]);
  });

  it('clears the suggestion when the session changes', async () => {
    const { result, rerender } = renderHook(
      (props: { sessionKey: string }) => useNextSuggestion({
        sessionKey: props.sessionKey, turnKey: 'run-1', messages: MESSAGES, enabled: true,
      }),
      { initialProps: { sessionKey: 't1' } },
    );
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
    rerender({ sessionKey: 't2' });
    expect(result.current.suggestion).toBe('');
  });

  it('dismiss clears the suggestion and it does not come back for the same turn', async () => {
    const { result, rerender } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'run-1', messages: MESSAGES, enabled: true }));
    await waitFor(() => expect(result.current.suggestion).toBe('run the tests'));
    act(() => result.current.dismiss());
    expect(result.current.suggestion).toBe('');
    rerender();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.suggestion).toBe('');
  });

  it('stays silent when the request fails', async () => {
    global.fetch = vi.fn(async () => { throw new Error('offline'); });
    const { result } = renderHook(() =>
      useNextSuggestion({ sessionKey: 't1', turnKey: 'run-1', messages: MESSAGES, enabled: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.current.suggestion).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run from `src/frontend`:

```bash
npx vitest run src/hooks/useNextSuggestion.test.ts
```

Expected: FAIL — cannot resolve `./useNextSuggestion`.

- [ ] **Step 3: Write the hook**

Create `src/frontend/src/hooks/useNextSuggestion.ts`:

```ts
/**
 * Ask the backend for the user's likely next message once a turn completes.
 *
 * Fires after the stream has closed rather than riding on it: the suggestion is
 * only computable once the reply exists, and holding `run_end` open to wait for
 * it would make every turn look slower to save one round-trip.
 *
 * Silent on failure, by contract. No toast, no banner, no retry — an offline
 * daemon simply means no placeholder.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../api-base';

export interface SuggestionMessage {
  role: string;
  content: string;
}

export interface UseNextSuggestionInput {
  /** The surface's own id (threadId / assistant sessionId). Staleness token only — never sent. */
  sessionKey: string | null;
  /** Trailing assistant message id. Changes once per turn: trigger and staleness token. */
  turnKey: string | null;
  messages: SuggestionMessage[];
  /** Caller-owned predicate: composer empty && the turn ended cleanly. */
  enabled: boolean;
}

function toTranscript(messages: SuggestionMessage[]) {
  return messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
    .map((m) => ({ role: m.role, text: m.content }));
}

export function useNextSuggestion({ sessionKey, turnKey, messages, enabled }: UseNextSuggestionInput) {
  const [suggestion, setSuggestion] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  // Turns already handled — so a dismissed suggestion never returns for the same
  // turn, and a re-render never re-fires an in-flight or completed request.
  const handledRef = useRef<string | null>(null);
  // Read inside the effect without making message identity a trigger: the
  // transcript is a snapshot taken when the turn ends, not a live dependency.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const dismiss = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setSuggestion('');
  }, []);

  // A new session starts clean: any in-flight request belongs to the old one.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    handledRef.current = null;
    setSuggestion('');
  }, [sessionKey]);

  useEffect(() => {
    if (!enabled || !turnKey || handledRef.current === turnKey) return;
    const transcript = toTranscript(messagesRef.current);
    if (transcript.length === 0) return;

    handledRef.current = turnKey;
    const controller = new AbortController();
    abortRef.current = controller;
    const requestedFor = { sessionKey, turnKey };

    void (async () => {
      try {
        const res = await apiFetch('/api/next-message', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ transcript }),
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = (await res.json()) as { suggestion?: string };
        // The world may have moved on while the local model was thinking.
        if (controller.signal.aborted) return;
        if (requestedFor.sessionKey !== sessionKey || requestedFor.turnKey !== turnKey) return;
        setSuggestion((data.suggestion ?? '').trim());
      } catch {
        /* silent by contract */
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    })();

    return () => controller.abort();
  }, [enabled, turnKey, sessionKey]);

  return { suggestion, dismiss };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run from `src/frontend`:

```bash
npx vitest run src/hooks/useNextSuggestion.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/hooks/useNextSuggestion.ts src/frontend/src/hooks/useNextSuggestion.test.ts
git commit -m "feat(frontend): add useNextSuggestion hook"
```

---

### Task 5: Wire the suggestion into ChatPanel

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/frontend/src/components/ChatPanel.test.tsx`

**Interfaces:**
- Consumes: `useNextSuggestion` from Task 4. Existing local state: `input`, `setInput`, `isRunning`, `threadId`, `state` (from `usePiStream`), `visible` (merged message list, defined around line 633), `handleKeyDown` (line 537).
- Produces: no new exports — this is the first user-visible integration.

The suggestion renders as the textarea's `placeholder`, which is only visible when the composer is empty — exactly the condition under which we want to show it. That is what avoids the overlay/mirror-div machinery inline ghost text normally needs.

- [ ] **Step 1: Write the failing test**

Add to `src/frontend/src/components/ChatPanel.test.tsx`, inside the existing `describe('ChatPanel', …)`:

```ts
  it('offers a suggestion as the composer placeholder and accepts it with Tab', async () => {
    const user = userEvent.setup();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/next-message') {
        return { ok: true, json: async () => ({ suggestion: 'run the tests' }) } as Response;
      }
      if (url === '/api/models') {
        return { ok: true, json: async () => ({ models: [{ id: 'sonnet', name: 'Sonnet', provider: 'anthropic', configured: true }] }) } as Response;
      }
      if (url.startsWith('/api/projects/p1/model-status')) {
        return { ok: true, json: async () => ({ busy: false }) } as Response;
      }
      if (url === '/api/threads/t1') {
        return {
          ok: true,
          json: async () => ({
            thread: { id: 't1' },
            messages: [
              { id: 'm1', role: 'user', content: 'add a test', timestamp: 1 },
              { id: 'm2', role: 'assistant', content: 'done', timestamp: 2 },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    render(<ChatPanel projectId="p1" threadId="t1" onThreadsChanged={noop} />);

    const box = await screen.findByTestId('chat-input');
    await waitFor(() => expect(box).toHaveAttribute('placeholder', 'run the tests'));

    box.focus();
    await user.keyboard('{Tab}');
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('run the tests'));
    // Tab accepts; it must not send.
    expect((global.fetch as any).mock.calls.some(([u]: [string]) => String(u).endsWith('/messages/stream'))).toBe(false);
  });
```

If `ChatPanel`'s props differ from `projectId` / `threadId` / `onThreadsChanged`, copy the exact prop set from the neighbouring tests in this file rather than inventing one.

- [ ] **Step 2: Run test to verify it fails**

Run from `src/frontend`:

```bash
npx vitest run src/components/ChatPanel.test.tsx -t 'offers a suggestion'
```

Expected: FAIL — the placeholder is still the static "Type a message…" string.

- [ ] **Step 3: Call the hook**

In `src/frontend/src/components/ChatPanel.tsx`, add the import beside the other hook imports:

```ts
import { useNextSuggestion } from '../hooks/useNextSuggestion';
```

Then, immediately after `visible` is computed (around line 635, after the `const visible = …` assignment):

```ts
  // The trailing assistant message identifies the completed turn: it changes
  // exactly once per turn, so it serves as both trigger and staleness token.
  // Message id rather than run id — AssistantView's messages carry no run
  // metadata, and this feature uses one signal across both surfaces.
  const lastMessage = visible[visible.length - 1];
  const completedTurnKey =
    !isRunning && lastMessage?.role === 'assistant' && lastMessage.content.trim()
      ? lastMessage.id
      : null;
  const { suggestion, dismiss: dismissSuggestion } = useNextSuggestion({
    sessionKey: threadId ?? null,
    turnKey: completedTurnKey,
    messages: visible,
    // Only ever offered into an empty composer — which is also the only time a
    // placeholder renders, and why this needs no ghost-text overlay.
    enabled: !isRunning && !input.trim() && state.status !== 'error',
  });
```

This fires on thread open as well as after a live turn, since a freshly loaded
thread also ends in an assistant message. That is intentional — resuming a thread
is exactly when "what next?" is worth answering — and it costs one local model
call per thread open.

- [ ] **Step 4: Accept on Tab**

Replace `handleKeyDown` (line 537) with:

```ts
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && suggestion && !input) {
      // Accept into the composer without sending: editing before Enter is free.
      e.preventDefault();
      setInput(suggestion);
      dismissSuggestion();
      return;
    }
    if (e.key === 'Escape' && suggestion) {
      dismissSuggestion();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };
```

- [ ] **Step 5: Render the suggestion as the placeholder**

In the composer `<textarea>` (line 811), replace the `placeholder` prop:

```tsx
            placeholder={suggestion || 'Type a message… (Enter to send, Shift+Enter for newline)'}
```

and add the accept hint just after `<ContextUsageLabel usage={state.contextUsage} />` inside the `composer-actions` column:

```tsx
            {suggestion && !input && (
              <span className="text-[10px] text-faint text-center" data-testid="suggestion-hint">
                ⇥ to accept
              </span>
            )}
```

- [ ] **Step 6: Run test to verify it passes**

Run from `src/frontend`:

```bash
npx vitest run src/components/ChatPanel.test.tsx
```

Expected: PASS — the new test plus every pre-existing ChatPanel test.

- [ ] **Step 7: Verify the frontend typechecks**

Run from the repo root:

```bash
npm run --workspace=src/frontend typecheck
```

Expected: no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx src/frontend/src/components/ChatPanel.test.tsx
git commit -m "feat(frontend): offer a next-message suggestion in the chat composer"
```

---

### Task 6: Wire the suggestion into AssistantView

**Files:**
- Modify: `src/frontend/src/components/AssistantView.tsx`
- Modify: `src/frontend/src/components/AssistantView.test.tsx`

**Interfaces:**
- Consumes: `useNextSuggestion` from Task 4. Existing local state: `input`, `setInput`, `selectedSessionId`, `handleKeyDown`, and the message list rendered by `useAssistantStream`.
- Produces: no new exports.

Same integration as Task 5 against the other composer, with two differences that matter:

- `AssistantView.test.tsx` mocks the **`../api-base` module** (`apiFetchMock`), not `global.fetch` — so the `/api/next-message` branch goes into that mock, not a fetch stub. Do not copy Task 5's stub.
- `AssistantView`'s message list and running state come from `useAssistantStream`, so the local identifiers differ from ChatPanel's even though the shapes match. Read the component before editing.

Session `s1` in this file's `installDefaultMock()` already ends in an assistant message (`m2`, "checks queued"), which is exactly the state that should produce a suggestion.

- [ ] **Step 1: Write the failing test**

In `src/frontend/src/components/AssistantView.test.tsx`, add a `/api/next-message` branch at the top of the `installDefaultMock()` implementation, before the `/api/assistant/sessions` branch:

```ts
    if (url === '/api/next-message') {
      return { ok: true, json: async () => ({ suggestion: 'run the tests' }) } as Response;
    }
```

Then add this test inside the existing top-level `describe`:

```ts
  it('offers a next-message suggestion as the composer placeholder', async () => {
    render(<AssistantView />);
    await screen.findByText('Nightly checks');
    const box = await screen.findByPlaceholderText('run the tests');
    expect(box).toBeInstanceOf(HTMLTextAreaElement);
  });
```

If `AssistantView` takes props, copy the exact prop set from the neighbouring `render(...)` calls in this file.

- [ ] **Step 2: Run test to verify it fails**

Run from `src/frontend`:

```bash
npx vitest run src/components/AssistantView.test.tsx -t 'offers a suggestion'
```

Expected: FAIL — no element with that placeholder.

- [ ] **Step 3: Call the hook**

In `src/frontend/src/components/AssistantView.tsx`, add:

```ts
import { useNextSuggestion } from '../hooks/useNextSuggestion';
```

and, next to where the component reads its message list and running state:

```ts
  const lastMessage = messages[messages.length - 1];
  const completedTurnKey =
    !isRunning && lastMessage?.role === 'assistant' && lastMessage.content.trim()
      ? lastMessage.id
      : null;
  const { suggestion, dismiss: dismissSuggestion } = useNextSuggestion({
    sessionKey: selectedSessionId ?? null,
    turnKey: completedTurnKey,
    messages,
    enabled: !isRunning && !input.trim(),
  });
```

Substitute this file's actual names for `messages` and `isRunning` — the shapes match ChatPanel's, the identifiers do not.

- [ ] **Step 4: Accept on Tab and render the placeholder**

Add to the top of `handleKeyDown`:

```ts
    if (e.key === 'Tab' && suggestion && !input) {
      e.preventDefault();
      setInput(suggestion);
      dismissSuggestion();
      return;
    }
    if (e.key === 'Escape' && suggestion) {
      dismissSuggestion();
      return;
    }
```

and change the textarea's placeholder (line 412):

```tsx
              placeholder={suggestion || 'Message Assistant...'}
```

- [ ] **Step 5: Run the full frontend suite**

Run from `src/frontend`:

```bash
npx vitest run
```

Expected: PASS, including every pre-existing test.

- [ ] **Step 6: Verify the whole repo typechecks**

Run from the repo root:

```bash
npm run typecheck
```

Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/src/components/AssistantView.tsx src/frontend/src/components/AssistantView.test.tsx
git commit -m "feat(frontend): offer a next-message suggestion in the assistant composer"
```

---

## Manual verification

**Precondition: the memory daemon's gen server must be up, with thinking disabled.**

Suggestions are served by the *daemon's* generation model — `memory.models.gen_url`, default
`http://127.0.0.1:4001/v1` — **not** by `models.local`, which is the chat provider Nexus streams
turns from. The two are easy to conflate: probing the chat provider tells you nothing about
whether suggestions will work.

Two ways this silently yields no placeholder, both of which `suggestNextMessage` swallows by
design:

- **Gen server down.** `ModelClient.complete()` throws a `transport` ModelError. The likeliest
  cause, since the daemon's three servers (gen 4001, embed 4002, rerank 4003) are launched
  externally.
- **Gen server is a reasoning model launched without thinking off.** It spends its whole token
  budget on hidden reasoning and returns empty `content` with `finish_reason: "length"` — measured
  against a 35B reasoning model, where even a 512-token budget produced nothing while
  `--reasoning off` answered in 9–12 tokens. `complete()` detects this specific case and throws a
  non-retryable `config` ModelError naming the fix.

`generate-session-title` shares this code path, so either failure also breaks session auto-naming.
New sessions stuck on the "New Session" placeholder are the visible symptom, and a useful way to
tell whether the daemon's gen model is healthy before blaming this feature.

Automated tests cover the wiring; they cannot tell you whether the suggestions are any *good*. That is the real acceptance criterion, and it needs a human.

Run the stack:

```bash
npm run web
```

Then, in a project chat:

1. Send a turn that ends with the assistant doing something — the placeholder should appear within a second or two of the reply finishing.
2. Press `Tab`. The text lands in the composer and **nothing is sent**.
3. Start typing instead. The placeholder disappears on the first character.
4. Switch threads mid-suggestion. No suggestion leaks into the new thread.
5. Stop the memory daemon and repeat step 1. No placeholder, no toast, no error — chat is unaffected.

If the suggestions are weak, tune `NEXT_MESSAGE_SYSTEM_PROMPT` in
`src/memory-daemon/src/routes/operations.ts`. That is the single tuning point, which is why the
prompt lives in one place and both surfaces share it.

## Follow-ups, deliberately not in this plan

- **Glasses.** The endpoint is stateless and surface-agnostic; the cockpit's Steer screen can adopt it with slide-to-highlight, tap-to-send. Deferred until desktop suggestion quality has been lived with.
- **Suppressing the suggestion while a structured question card is pending.** Redundant rather than harmful, and wiring `questionSubmissions` into the enabled predicate costs more than the redundancy does.
- **The gateway's loopback transcript read** (`readEvents` in `src/backend/gateway/sessions.ts` calling back into the main app over HTTP because the assistant reader is module-private). A real wart, unrelated to this feature now that the endpoint is stateless. Worth its own issue.
