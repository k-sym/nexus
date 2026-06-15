# Chat Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add drag/drop and paste image attachments to Nexus chat, with up to five preview thumbnails per outgoing message and Pi image forwarding.

**Architecture:** Keep pending attachments in the chat composer and pass them through the existing NDJSON chat stream route. Model catalog responses expose Pi input capabilities so the frontend can block image sends for text-only models. Backend validation, persistence, Pi prompt forwarding, and history flattening all use one shared image attachment shape.

**Tech Stack:** React 19, Vite/Vitest, Fastify, better-sqlite3, node:test, `@earendil-works/pi-coding-agent@0.79.0`, `@earendil-works/pi-ai@0.79.0`.

---

## File Structure

- Modify `src/backend/pi/runtime.ts`: include `input?: ("text" | "image")[]` in `ModelShape` and copy `m.input`.
- Modify `src/backend/pi/model-curation.ts`: preserve `input` on curated model catalog items.
- Modify `src/backend/routes/pi.ts`: include `input` in `/api/models` catalog items.
- Modify `src/frontend/src/hooks/useModels.ts`: add `input` to `ModelInfo`.
- Modify `src/backend/routes/chat.ts`: define `ChatImageAttachment`, validate image payloads, persist `attachments_json`, forward images to `session.prompt`, and preserve images when flattening session history.
- Modify `src/frontend/src/hooks/usePiStream.ts`: carry optional images through optimistic state and request body.
- Modify `src/frontend/src/components/ChatPanel.tsx`: add drag/drop and paste handling, thumbnail strip, max-5 warning, text-only model warning, and attachment rendering in user bubbles.
- Modify backend tests in `src/backend/test/routes-chat.test.ts`, `src/backend/test/pi-runtime.test.ts`, and `src/backend/test/pi-model-curation.test.ts`.
- Modify frontend tests in `src/frontend/src/hooks/usePiStream.test.ts` and `src/frontend/src/components/ChatPanel.test.tsx`.

---

### Task 1: Expose Model Image Capability

**Files:**
- Modify: `src/backend/pi/runtime.ts`
- Modify: `src/backend/pi/model-curation.ts`
- Modify: `src/backend/routes/pi.ts`
- Modify: `src/frontend/src/hooks/useModels.ts`
- Test: `src/backend/test/pi-runtime.test.ts`
- Test: `src/backend/test/pi-model-curation.test.ts`

- [ ] **Step 1: Write failing runtime model-shape test**

Append this test to `src/backend/test/pi-runtime.test.ts`:

```ts
test('PiRuntime.findModel exposes model input capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = new PiRuntime(paths);
    const model = {
      provider: 'test-provider',
      id: 'vision-model',
      name: 'Vision Model',
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 1000,
      maxTokens: 100,
    };
    (rt.models as any).find = () => model;

    const found = rt.findModel('test-provider', 'vision-model');

    assert.deepEqual(found?.input, ['text', 'image']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Write failing curation preservation test**

Add an `input` field to one catalog item in `src/backend/test/pi-model-curation.test.ts`:

```ts
{ provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet', configured: true, input: ['text', 'image'] },
```

Then append:

```ts
test('ModelCurationStore preserves input capabilities on curated models', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    const result = store.apply(catalog);
    const model = result.models.find((item) => item.id === 'claude-sonnet-4-5');
    assert.deepEqual(model?.input, ['text', 'image']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run backend tests and verify failure**

Run:

```bash
npm test --workspace=src/backend -- pi-runtime.test.ts pi-model-curation.test.ts
```

Expected: TypeScript/test failure because `input` is not exposed on the runtime/catalog types yet.

- [ ] **Step 4: Implement model capability plumbing**

In `src/backend/pi/runtime.ts`, update `ModelShape`:

```ts
export interface ModelShape {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
}
```

In `findModel`, return `input`:

```ts
return {
  id: m.id,
  name: m.name,
  provider: m.provider,
  reasoning: m.reasoning,
  contextWindow: m.contextWindow,
  maxTokens: m.maxTokens,
  input: m.input,
};
```

In `src/backend/pi/model-curation.ts`, update `ModelCatalogItem`:

```ts
export interface ModelCatalogItem {
  provider: string;
  id: string;
  name: string;
  configured?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
}
```

In `src/backend/routes/pi.ts`, add `input` to `buildModelCatalog`:

```ts
input: m.input,
```

In `src/frontend/src/hooks/useModels.ts`, update `ModelInfo`:

```ts
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  configured?: boolean;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
npm test --workspace=src/backend -- pi-runtime.test.ts pi-model-curation.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/backend/pi/runtime.ts src/backend/pi/model-curation.ts src/backend/routes/pi.ts src/frontend/src/hooks/useModels.ts src/backend/test/pi-runtime.test.ts src/backend/test/pi-model-curation.test.ts
git commit -m "feat: expose model input capabilities"
```

---

### Task 2: Validate And Forward Images In The Backend

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Test: `src/backend/test/routes-chat.test.ts`

- [ ] **Step 1: Write failing tests for image validation and Pi prompt options**

Append these tests to `src/backend/test/routes-chat.test.ts`:

```ts
test('POST /api/threads/:id/messages/stream rejects more than five images', async () => {
  const session = { subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'openai', id: 'vision', input: ['text', 'image'] }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const images = Array.from({ length: 6 }, (_, index) => ({
      type: 'image',
      data: Buffer.from(`image-${index}`).toString('base64'),
      mimeType: 'image/png',
      name: `image-${index}.png`,
      size: 20,
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'look', modelKey: 'openai/vision', images },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /at most 5 images/i);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects unsupported image MIME types', async () => {
  const session = { subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'openai', id: 'vision', input: ['text', 'image'] }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: {
        content: 'look',
        modelKey: 'openai/vision',
        images: [{ type: 'image', data: 'abc123', mimeType: 'application/pdf', name: 'bad.pdf' }],
      },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /unsupported image type/i);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream passes valid images to Pi and persists attachments', async () => {
  let promptArgs: unknown[] = [];
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async (...args: unknown[]) => {
      promptArgs = args;
    },
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'openai', id: 'vision', input: ['text', 'image'] }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const image = {
      type: 'image',
      data: Buffer.from('png bytes').toString('base64'),
      mimeType: 'image/png',
      name: 'screenshot.png',
      size: 9,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'look', modelKey: 'openai/vision', images: [image] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(promptArgs[0], 'look');
    assert.deepEqual(promptArgs[1], { images: [image] });

    const row = db.prepare('SELECT attachments_json FROM chat_messages WHERE role = ?').get('user') as { attachments_json: string };
    assert.deepEqual(JSON.parse(row.attachments_json), [image]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test --workspace=src/backend -- routes-chat.test.ts
```

Expected: tests fail because the route ignores `images`, does not validate them, persists `[]`, and calls `session.prompt(body.content)`.

- [ ] **Step 3: Implement backend image validation**

In `src/backend/routes/chat.ts`, add near the top:

```ts
const MAX_CHAT_IMAGES = 5;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

interface ChatImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
}

function validateChatImages(value: unknown): { ok: true; images: ChatImageAttachment[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, images: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'images must be an array' };
  if (value.length > MAX_CHAT_IMAGES) return { ok: false, error: `A message can include at most ${MAX_CHAT_IMAGES} images.` };

  const images: ChatImageAttachment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Each image must be an object.' };
    const image = item as Record<string, unknown>;
    if (image.type !== 'image') return { ok: false, error: 'Each image must have type "image".' };
    if (typeof image.data !== 'string' || image.data.length === 0) return { ok: false, error: 'Each image must include base64 data.' };
    if (typeof image.mimeType !== 'string' || !SUPPORTED_IMAGE_MIME_TYPES.has(image.mimeType)) {
      return { ok: false, error: `Unsupported image type: ${String(image.mimeType ?? '')}` };
    }
    images.push({
      type: 'image',
      data: image.data,
      mimeType: image.mimeType,
      ...(typeof image.name === 'string' ? { name: image.name } : {}),
      ...(typeof image.size === 'number' ? { size: image.size } : {}),
    });
  }
  return { ok: true, images };
}
```

Change the stream body type:

```ts
const body = request.body as { content: string; modelKey?: string; images?: unknown };
const validatedImages = validateChatImages(body.images);
if (!validatedImages.ok) {
  reply.code(400);
  return { error: validatedImages.error };
}
const images = validatedImages.images;
```

Use `images` when persisting and prompting:

```ts
JSON.stringify(images),
```

```ts
await session.prompt(body.content, images.length > 0 ? { images } : undefined);
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test --workspace=src/backend -- routes-chat.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/chat.ts src/backend/test/routes-chat.test.ts
git commit -m "feat: forward chat images to pi"
```

---

### Task 3: Preserve Image Attachments In History

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Test: `src/backend/test/routes-chat.test.ts`

- [ ] **Step 1: Write failing history tests**

Append these tests to `src/backend/test/routes-chat.test.ts`:

```ts
test('GET /api/threads/:threadId preserves user image blocks from Pi session history', async () => {
  const image = { type: 'image', data: 'abc123', mimeType: 'image/png', name: 'screen.png' };
  const runtime = {
    readMessages: async () => [
      {
        type: 'message',
        id: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'look' }, image],
          timestamp: 1,
        },
      },
    ],
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages[0].attachments, [image]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId preserves DB fallback image attachments', async () => {
  const image = { type: 'image', data: 'abc123', mimeType: 'image/png', name: 'screen.png' };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m1', 'thread-1', 'user', 'look', JSON.stringify([image]), '2026-06-10T12:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages[0].attachments, [image]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm test --workspace=src/backend -- routes-chat.test.ts
```

Expected: new assertions fail because `dbMessages`, `flattenEntries`, and `extractText` discard image blocks.

- [ ] **Step 3: Implement attachment extraction**

In `src/backend/routes/chat.ts`, add:

```ts
function extractImages(content: unknown): ChatImageAttachment[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b: any): b is ChatImageAttachment =>
    b?.type === 'image' &&
    typeof b.data === 'string' &&
    typeof b.mimeType === 'string'
  );
}

function parseAttachmentsJson(value: string | null): ChatImageAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const result = validateChatImages(parsed);
    return result.ok ? result.images : [];
  } catch {
    return [];
  }
}
```

In `dbMessages`, include attachments in mapped rows:

```ts
attachments: parseAttachmentsJson(row.attachments_json),
```

Update the row type to include `attachments_json: string | null`.

In `flattenEntries`, update user messages:

```ts
out.push({
  id: e.id,
  role: 'user',
  content: typeof m.content === 'string' ? m.content : extractText(m.content),
  attachments: extractImages(m.content),
  timestamp: m.timestamp ?? e.timestamp,
});
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test --workspace=src/backend -- routes-chat.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/routes/chat.ts src/backend/test/routes-chat.test.ts
git commit -m "feat: preserve chat image history"
```

---

### Task 4: Carry Images Through The Stream Hook

**Files:**
- Modify: `src/frontend/src/hooks/usePiStream.ts`
- Test: `src/frontend/src/hooks/usePiStream.test.ts`

- [ ] **Step 1: Write failing hook tests**

In `src/frontend/src/hooks/usePiStream.test.ts`, update the `START_STREAM seeds a user + empty assistant bubble` test to pass attachments:

```ts
const image = { type: 'image' as const, data: 'abc123', mimeType: 'image/png', name: 'screen.png' };
const next = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'hi', attachments: [image] });
expect(next.messages[0].attachments).toEqual([image]);
```

Append this hook test:

```ts
it('sends images in the stream request body', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
      controller.close();
    },
  });
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as Response);
  global.fetch = fetchMock;
  const image = { type: 'image' as const, data: 'abc123', mimeType: 'image/png', name: 'screen.png' };

  const { result } = renderHook(() => usePiStream());

  await act(async () => {
    await result.current.startStream('thread-1', 'hi', { images: [image] });
  });

  const [, init] = fetchMock.mock.calls[0];
  expect(JSON.parse(String(init.body))).toEqual({ content: 'hi', images: [image] });
});
```

- [ ] **Step 2: Run frontend hook tests and verify failure**

Run:

```bash
npm --workspace=src/frontend test -- usePiStream.test.ts
```

Expected: TypeScript/test failure because `StreamMessage` and `START_STREAM` do not include attachments, and `startStream` options do not accept `images`.

- [ ] **Step 3: Implement stream attachment support**

In `src/frontend/src/hooks/usePiStream.ts`, add:

```ts
export interface ChatImageAttachment {
  type: 'image';
  data: string;
  mimeType: string;
  name?: string;
  size?: number;
}
```

Add to `StreamMessage`:

```ts
attachments?: ChatImageAttachment[];
```

Change `StreamAction`:

```ts
| { type: 'START_STREAM'; prompt: string; attachments?: ChatImageAttachment[] }
```

In the `START_STREAM` message:

```ts
attachments: action.attachments ?? [],
```

Change `startStream` signature:

```ts
async (
  threadId: string,
  text: string,
  opts: { confirmCancel?: boolean; modelKey?: string; images?: ChatImageAttachment[] } = {},
) => {
```

Dispatch with attachments:

```ts
dispatch({ type: 'START_STREAM', prompt: text, attachments: opts.images });
```

Build the body without sending empty images:

```ts
body: JSON.stringify({
  content: text,
  modelKey: opts.modelKey,
  ...(opts.images && opts.images.length > 0 ? { images: opts.images } : {}),
}),
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm --workspace=src/frontend test -- usePiStream.test.ts
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/hooks/usePiStream.ts src/frontend/src/hooks/usePiStream.test.ts
git commit -m "feat: send chat images from stream hook"
```

---

### Task 5: Add Composer Image Drop, Paste, Preview, And Send Blocking

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Test: `src/frontend/src/components/ChatPanel.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add helper functions near the top of `src/frontend/src/components/ChatPanel.test.tsx`:

```ts
function imageFile(name = 'screen.png', type = 'image/png') {
  return new File(['image-bytes'], name, { type });
}

function makeDataTransfer(files: File[]) {
  return {
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    types: ['Files'],
  };
}
```

Append these tests:

```ts
it('shows an overlay while dragging images over the chat pane', async () => {
  render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
  const pane = await screen.findByTestId('chat-drop-target');

  fireEvent.dragEnter(pane, { dataTransfer: makeDataTransfer([imageFile()]) });

  expect(screen.getByText(/Release to attach images/i)).toBeInTheDocument();
});

it('drops images into thumbnails above the textarea and sends them', async () => {
  const encoder = new TextEncoder();
  let streamBody: any;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/models') {
      return { ok: true, json: async () => ({ models: [{ id: 'vision', name: 'Vision', provider: 'openai', input: ['text', 'image'], configured: true }] }) } as Response;
    }
    if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
    if (url === '/api/threads/t1') return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
    if (url === '/api/threads/t1/messages/stream') {
      streamBody = JSON.parse(String(init?.body));
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
            controller.close();
          },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });

  render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
  const pane = await screen.findByTestId('chat-drop-target');
  fireEvent.drop(pane, { dataTransfer: makeDataTransfer([imageFile('screen.png')]) });

  expect(await screen.findByText('screen.png')).toBeInTheDocument();
  await userEvent.type(screen.getByTestId('chat-input'), 'describe this');
  await userEvent.click(screen.getByTestId('send-button'));

  await waitFor(() => expect(streamBody.images).toHaveLength(1));
  expect(streamBody.images[0].mimeType).toBe('image/png');
});

it('limits pending image attachments to five', async () => {
  render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
  const pane = await screen.findByTestId('chat-drop-target');
  const files = Array.from({ length: 6 }, (_, index) => imageFile(`screen-${index}.png`));

  fireEvent.drop(pane, { dataTransfer: makeDataTransfer(files) });

  expect(await screen.findByText(/Only 5 images can be attached/i)).toBeInTheDocument();
  expect(screen.getAllByTestId('pending-image-thumb')).toHaveLength(5);
});

it('disables send when pending images are attached to a text-only model', async () => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/models') {
      return { ok: true, json: async () => ({ models: [{ id: 'text', name: 'Text', provider: 'openai', input: ['text'], configured: true }] }) } as Response;
    }
    if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
    if (url === '/api/threads/t1') return { ok: true, json: async () => ({ thread: { id: 't1' }, messages: [] }) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  });

  render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);
  const pane = await screen.findByTestId('chat-drop-target');
  fireEvent.drop(pane, { dataTransfer: makeDataTransfer([imageFile()]) });

  expect(await screen.findByText(/selected model does not support images/i)).toBeInTheDocument();
  expect(screen.getByTestId('send-button')).toBeDisabled();
});
```

Add `fireEvent` to the import:

```ts
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
```

- [ ] **Step 2: Run UI tests and verify failure**

Run:

```bash
npm --workspace=src/frontend test -- ChatPanel.test.tsx
```

Expected: tests fail because there is no drop target test id, no overlay, no pending thumbnails, no file reading, and no model capability send blocking.

- [ ] **Step 3: Implement ChatPanel state and file conversion**

In `src/frontend/src/components/ChatPanel.tsx`, import the attachment type:

```ts
import { usePiStream, ChatBusyError, type StreamMessage, type ChatImageAttachment } from '../hooks/usePiStream';
```

Add constants and helpers above the component:

```ts
const MAX_PENDING_IMAGES = 5;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function fileToImageAttachment(file: File): Promise<ChatImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const comma = result.indexOf(',');
      resolve({
        type: 'image',
        data: comma >= 0 ? result.slice(comma + 1) : result,
        mimeType: file.type,
        name: file.name,
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image.'));
    reader.readAsDataURL(file);
  });
}
```

Inside `ChatPanel`, add state:

```ts
const [pendingImages, setPendingImages] = useState<ChatImageAttachment[]>([]);
const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
const [draggingImages, setDraggingImages] = useState(false);
```

Compute selected model support:

```ts
const activeModel = models.find((model) => `${model.provider}/${model.id}` === activeModelId);
const selectedModelSupportsImages = activeModel?.input?.includes('image') ?? false;
const hasPendingImages = pendingImages.length > 0;
const imageModelBlocked = hasPendingImages && !selectedModelSupportsImages;
```

Add an image ingestion callback:

```ts
const addImageFiles = useCallback(async (files: File[]) => {
  const imageFiles = files.filter((file) => SUPPORTED_IMAGE_MIME_TYPES.has(file.type));
  const rejected = files.length - imageFiles.length;
  const slots = Math.max(0, MAX_PENDING_IMAGES - pendingImages.length);
  const accepted = imageFiles.slice(0, slots);
  const overLimit = imageFiles.length > slots;

  if (rejected > 0) setAttachmentWarning('Only PNG, JPEG, GIF, and WebP images can be attached.');
  else if (overLimit) setAttachmentWarning(`Only ${MAX_PENDING_IMAGES} images can be attached to one message.`);
  else setAttachmentWarning(null);

  if (accepted.length === 0) return;
  const attachments = await Promise.all(accepted.map(fileToImageAttachment));
  setPendingImages((current) => [...current, ...attachments].slice(0, MAX_PENDING_IMAGES));
}, [pendingImages.length]);
```

- [ ] **Step 4: Implement drop, paste, send, and remove behavior**

Add handlers:

```ts
const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
  e.preventDefault();
  e.stopPropagation();
  setDraggingImages(false);
  void addImageFiles(Array.from(e.dataTransfer.files));
}, [addImageFiles]);

const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
  if (Array.from(e.dataTransfer.types).includes('Files')) {
    e.preventDefault();
    setDraggingImages(true);
  }
}, []);

const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
  if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
}, []);

const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDraggingImages(false);
}, []);

const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
  const files = Array.from(e.clipboardData.files);
  if (files.length === 0) return;
  e.preventDefault();
  void addImageFiles(files);
}, [addImageFiles]);

const removePendingImage = useCallback((index: number) => {
  setPendingImages((current) => current.filter((_, i) => i !== index));
  setAttachmentWarning(null);
}, []);
```

Update `submit` signature and stream call:

```ts
async (text: string, opts: { confirmCancel?: boolean; modelKey?: string; images?: ChatImageAttachment[] } = {}) => {
```

```ts
await startStream(threadId, text, {
  confirmCancel: opts.confirmCancel,
  modelKey: opts.modelKey ?? activeModelId,
  images: opts.images ?? pendingImages,
});
```

Clear pending images after completion:

```ts
setPendingImages([]);
setAttachmentWarning(null);
```

Update `handleSend`:

```ts
const text = input.trim();
if ((!text && pendingImages.length === 0) || !threadId || imageModelBlocked) return;
setInput('');
void submit(text, { images: pendingImages });
```

Add `onPaste={handlePaste}` to the textarea.

Wrap the return root:

```tsx
<div
  className="flex-1 flex flex-col min-w-0 h-full relative"
  data-testid="chat-drop-target"
  onDragEnter={handleDragEnter}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

Add overlay just inside the root:

```tsx
{draggingImages && (
  <div className="absolute inset-3 z-20 rounded-lg border border-dashed border-cyan-300/50 bg-slate-950/70 flex items-center justify-center text-sm text-primary pointer-events-none">
    Release to attach images
  </div>
)}
```

Add thumbnail strip above the textarea:

```tsx
{pendingImages.length > 0 && (
  <div className="flex gap-2 overflow-x-auto pb-2">
    {pendingImages.map((image, index) => (
      <div key={`${image.name ?? 'image'}-${index}`} data-testid="pending-image-thumb" className="relative w-20 h-16 rounded-md overflow-hidden border border-subtle surface-elevated shrink-0">
        <img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name ?? `Image ${index + 1}`} className="w-full h-full object-cover" />
        <button type="button" onClick={() => removePendingImage(index)} className="absolute right-1 top-1 w-5 h-5 rounded-full bg-zinc-950/85 text-xs text-primary">x</button>
        {image.name && <span className="absolute left-1 bottom-1 max-w-[4.5rem] truncate rounded bg-zinc-950/80 px-1 text-[9px] text-zinc-200">{image.name}</span>}
      </div>
    ))}
  </div>
)}
```

Add warnings above or below the thumbnail strip:

```tsx
{attachmentWarning && <div className="pb-2 text-xs text-amber-200">{attachmentWarning}</div>}
{imageModelBlocked && <div className="pb-2 text-xs text-amber-200">The selected model does not support images. Pick a vision-capable model or remove the images.</div>}
```

Disable Send when blocked or no content:

```tsx
disabled={(!input.trim() && pendingImages.length === 0) || imageModelBlocked}
```

- [ ] **Step 5: Run UI tests**

Run:

```bash
npm --workspace=src/frontend test -- ChatPanel.test.tsx
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx src/frontend/src/components/ChatPanel.test.tsx
git commit -m "feat: add chat image composer previews"
```

---

### Task 6: Render Attachments In Message Bubbles

**Files:**
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Test: `src/frontend/src/components/ChatPanel.test.tsx`

- [ ] **Step 1: Write failing render test**

Append this test to `src/frontend/src/components/ChatPanel.test.tsx`:

```ts
it('renders image attachments on reloaded user messages', async () => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/models') {
      return { ok: true, json: async () => ({ models: [{ id: 'vision', name: 'Vision', provider: 'openai', input: ['text', 'image'], configured: true }] }) } as Response;
    }
    if (url.startsWith('/api/projects/p1/model-status')) return { ok: true, json: async () => ({ busy: false }) } as Response;
    if (url === '/api/threads/t1') {
      return {
        ok: true,
        json: async () => ({
          thread: { id: 't1' },
          messages: [
            {
              id: 'm-user',
              role: 'user',
              content: 'What is in this image?',
              attachments: [{ type: 'image', data: 'abc123', mimeType: 'image/png', name: 'screen.png' }],
              timestamp: 1,
            },
          ],
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });

  render(<ChatPanel projectId="p1" threadId="t1" onBusyConflict={noop} />);

  const image = await screen.findByAltText('screen.png');
  expect(image).toHaveAttribute('src', 'data:image/png;base64,abc123');
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npm --workspace=src/frontend test -- ChatPanel.test.tsx
```

Expected: test fails because `MessageBubble` renders text only.

- [ ] **Step 3: Implement attachment rendering**

In `MessageBubble`, before text content, render user attachments:

```tsx
{isUser && msg.attachments && msg.attachments.length > 0 && (
  <div className="mb-2 grid grid-cols-2 gap-2">
    {msg.attachments.map((image, index) => (
      <img
        key={`${image.name ?? 'image'}-${index}`}
        src={`data:${image.mimeType};base64,${image.data}`}
        alt={image.name ?? `Attached image ${index + 1}`}
        className="max-h-40 rounded-lg border border-subtle object-cover"
      />
    ))}
  </div>
)}
```

Keep existing message text rendering unchanged so text-only messages are unaffected.

- [ ] **Step 4: Run frontend tests**

Run:

```bash
npm --workspace=src/frontend test -- ChatPanel.test.tsx
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/ChatPanel.tsx src/frontend/src/components/ChatPanel.test.tsx
git commit -m "feat: render chat image attachments"
```

---

### Task 7: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run backend test suite**

Run:

```bash
npm test --workspace=src/backend
```

Expected: all backend tests pass.

- [ ] **Step 2: Run frontend test suite**

Run:

```bash
npm --workspace=src/frontend test
```

Expected: all frontend tests pass.

- [ ] **Step 3: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: TypeScript checks pass across shared, backend, and frontend workspaces.

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: all workspace builds complete without errors.

- [ ] **Step 5: Manual browser verification**

Run the app:

```bash
npm run dev:backend
npm run dev:frontend
```

Open the frontend in the in-app browser. In a chat session with a vision-capable model:

- Drag one PNG into the chat pane.
- Confirm the full-pane `Release to attach images` overlay appears during drag.
- Drop the image and confirm one thumbnail appears above the textarea.
- Paste a second image and confirm it appears beside the first thumbnail.
- Remove one thumbnail and confirm it disappears.
- Try adding six images and confirm only five remain with a cap warning.
- Switch to a text-only model and confirm Send is disabled with the model warning.
- Switch back to a vision-capable model, send the message, and confirm the user bubble displays the image thumbnail.
- Reload the thread and confirm the image thumbnail remains visible.

- [ ] **Step 6: Commit any verification-only fixes**

If verification required small fixes, commit them:

```bash
git add src/backend src/frontend
git commit -m "fix: stabilize chat image attachments"
```

If no fixes were needed, skip this step.

