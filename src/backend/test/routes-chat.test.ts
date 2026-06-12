import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { PiRuntime, type PiRuntimePaths } from '../pi/runtime';
import { ConcurrencyTracker } from '../pi/concurrency';
import { registerChatRoutes } from '../routes/chat';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApp(runtimeOverride?: unknown, options: { includeSecondThread?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-chat-test-'));
  const db = new Database(join(dir, 'test.db'));
  // Minimal schema: projects + chat_threads + chat_messages. (chat_messages
  // will be dropped in Phase 5; routes still write to it for backward compat.)
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      repo_path TEXT NOT NULL,
      config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'New Session',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      last_model_key TEXT
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments_json TEXT DEFAULT '[]',
      message_type TEXT DEFAULT 'text',
      structured_json TEXT,
      thinking TEXT,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );
  `);
  const projectId = 'proj-1';
  db.prepare(
    'INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(projectId, 'demo', 'Demo', dir, new Date().toISOString(), new Date().toISOString());
  const threadId = 'thread-1';
  db.prepare(
    'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(threadId, projectId, 'T1', new Date().toISOString(), new Date().toISOString());
  if (options.includeSecondThread) {
    db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('thread-2', projectId, 'T2', new Date().toISOString(), new Date().toISOString());
  }
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  const runtime = runtimeOverride ?? new PiRuntime(paths);
  const concurrency = new ConcurrencyTracker();
  const app = Fastify({ logger: false });
  app.decorate('db', db);
  app.decorate('pi', runtime);
  app.decorate('chatConcurrency', concurrency);
  app.register(registerChatRoutes);
  return { app, db, dir, runtime, concurrency };
}

const pngImage = {
  type: 'image',
  data: 'iVBORw0KGgo=',
  mimeType: 'image/png',
  name: 'screenshot.png',
  size: 10,
};

test('POST /api/threads/:id/messages/stream returns 409 when a *different* thread in the same project is busy', async () => {
  const { app, db, dir, concurrency } = makeApp();
  try {
    concurrency.set('proj-1', 'anthropic/sonnet', 'other-thread', 'Other');
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', modelKey: 'anthropic/sonnet' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.kind, 'model_busy');
    assert.equal(body.activeThreadId, 'other-thread');
    assert.equal(body.activeTitle, 'Other');
    assert.equal(body.modelKey, 'anthropic/sonnet');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream returns 409 for a *different* busy thread in the same project', async () => {
  const { app, db, dir, concurrency } = makeApp();
  try {
    concurrency.set('proj-1', 'anthropic/sonnet', 'other-thread', 'Other');
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', modelKey: 'anthropic/sonnet' },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.activeThreadId, 'other-thread');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream aborts the active session when confirm-cancel is set', async () => {
  const firstPromptStarted = deferred<void>();
  const firstAbortSeen = deferred<void>();
  let firstAborted = false;

  const firstSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      firstPromptStarted.resolve();
      await firstAbortSeen.promise;
    },
    abort: async () => {
      firstAborted = true;
      firstAbortSeen.resolve();
    },
  };
  const secondSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async (threadId: string) => (threadId === 'thread-1' ? firstSession : secondSession),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime, { includeSecondThread: true });
  try {
    const first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await firstPromptStarted.promise;

    const second = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-2/messages/stream',
      headers: { 'X-Confirm-Cancel': 'true' },
      payload: { content: 'second', modelKey: 'anthropic/sonnet' },
    });

    assert.equal(second.statusCode, 200);
    assert.equal(firstAborted, true);
    const firstRes = await first;
    assert.equal(firstRes.statusCode, 200);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream returns model selection errors before prompting', async () => {
  let promptCalled = false;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {
      throw new Error("The model 'claude-3-5-haiku-latest' is deprecated");
    },
    prompt: async () => {
      promptCalled = true;
    },
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'claude-3-5-haiku-latest' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', modelKey: 'anthropic/claude-3-5-haiku-latest' },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /deprecated/);
    assert.equal(promptCalled, false);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects too many images', async () => {
  let promptCalled = false;
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async () => {
        promptCalled = true;
      },
      abort: async () => {},
    }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', images: Array.from({ length: 6 }, () => pngImage) },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /at most 5 images/i);
    assert.equal(promptCalled, false);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects unsupported image MIME types', async () => {
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async () => {},
      abort: async () => {},
    }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', images: [{ ...pngImage, mimeType: 'image/svg+xml' }] },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /unsupported image MIME type/i);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream forwards and persists accepted images', async () => {
  let promptArgs: unknown[] = [];
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async (...args: unknown[]) => {
        promptArgs = args;
      },
      abort: async () => {},
    }),
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
      payload: { content: 'see this', modelKey: 'openai/vision', images: [pngImage] },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(promptArgs, ['see this', { images: [pngImage] }]);
    const row = db.prepare('SELECT content, attachments_json FROM chat_messages WHERE thread_id = ?').get('thread-1') as {
      content: string;
      attachments_json: string;
    };
    assert.equal(row.content, 'see this');
    assert.deepEqual(JSON.parse(row.attachments_json), [pngImage]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects images for text-only models', async () => {
  let promptCalled = false;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalled = true;
    },
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'openai', id: 'text-only', input: ['text'] }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'look', modelKey: 'openai/text-only', images: [pngImage] },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /does not support image input/i);
    assert.equal(promptCalled, false);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects images without a selected image-capable model', async () => {
  let promptCalled = false;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalled = true;
    },
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'look', images: [pngImage] },
    });

    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /does not support image input/i);
    assert.equal(promptCalled, false);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream accepts screenshot-sized image payloads', async () => {
  let promptCalled = false;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalled = true;
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
    const largeImage = {
      type: 'image',
      data: 'a'.repeat(1_500_000),
      mimeType: 'image/png',
      name: 'large-screenshot.png',
      size: 1_125_000,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'look', modelKey: 'openai/vision', images: [largeImage] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(promptCalled, true);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream preserves text-only prompt behavior', async () => {
  let promptArgs: unknown[] = [];
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async (...args: unknown[]) => {
        promptArgs = args;
      },
      abort: async () => {},
    }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'plain text' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(promptArgs, ['plain text']);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream keeps Anthropic OAuth on the Pi session path', async () => {
  let sessionForCalled = false;
  let promptCalled = false;
  const runtime = {
    auth: { get: () => ({ type: 'oauth' }) },
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalled = true;
      return {
        subscribe: (handler: (event: unknown) => void) => {
          handler({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
          return () => {};
        },
        setModel: async () => {},
        prompt: async () => {
          promptCalled = true;
        },
        abort: async () => {},
      };
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'claude-haiku-4-5-20251001' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'hi', modelKey: 'anthropic/claude-haiku-4-5-20251001' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(sessionForCalled, true);
    assert.equal(promptCalled, true);
    assert.match(res.body, /text_delta/);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/projects/:projectId/threads creates a thread row', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects/proj-1/threads',
      payload: { title: 'New chat' },
    });
    assert.equal(res.statusCode, 200);
    const thread = res.json();
    assert.equal(thread.project_id, 'proj-1');
    assert.equal(thread.title, 'New chat');
    assert.ok(thread.id);
    // Phase 5: agent_id is gone; threads no longer have a persona binding.
    assert.equal(thread.title, 'New chat');
    assert.equal(thread.id, thread.id);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId returns the thread + empty messages for a fresh thread', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.thread.id, 'thread-1');
    assert.deepEqual(body.messages, []);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId surfaces persisted assistant provider errors', async () => {
  const runtime = {
    readMessages: async () => [
      {
        type: 'message',
        id: 'u1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          timestamp: 1,
        },
      },
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage:
            '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage."}}',
          timestamp: 2,
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
    const assistant = res.json().messages.find((message: any) => message.role === 'assistant');
    assert.equal(assistant.isError, true);
    assert.match(assistant.content, /Third-party apps now draw/);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId preserves image attachments from Pi user entries', async () => {
  const runtime = {
    readMessages: async () => [
      {
        type: 'message',
        id: 'u1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            pngImage,
          ],
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
    assert.deepEqual(res.json().messages[0].attachments, [pngImage]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId falls back to DB messages when no Pi session exists', async () => {
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
      'INSERT INTO chat_messages (id, thread_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run('m1', 'thread-1', 'user', 'hi', '2026-06-10T12:00:00.000Z');
    db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, thinking, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m2', 'thread-1', 'assistant', 'hello', 'thinking', '2026-06-10T12:00:01.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      res.json().messages.map((message: any) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        thinking: message.thinking,
      })),
      [
        { id: 'm1', role: 'user', content: 'hi', thinking: null },
        { id: 'm2', role: 'assistant', content: 'hello', thinking: 'thinking' },
      ],
    );
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/threads/:threadId preserves image attachments from DB fallback rows', async () => {
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
    ).run('m1', 'thread-1', 'user', 'look', JSON.stringify([pngImage]), '2026-06-10T12:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages[0].attachments, [pngImage]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/threads/:threadId renames the thread', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/thread-1',
      payload: { title: 'Renamed' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().title, 'Renamed');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PATCH /api/threads/:threadId rejects empty titles', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/thread-1',
      payload: { title: '   ' },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DELETE /api/threads/:threadId removes the row', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const after = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });
    assert.equal(after.json().thread, undefined);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /api/projects/:projectId/threads returns threads for the project', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'GET', url: '/api/projects/proj-1/threads' });
    assert.equal(res.statusCode, 200);
    const threads = res.json();
    assert.equal(threads.length, 1);
    assert.equal(threads[0].id, 'thread-1');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/abort returns no_run when nothing is in flight', async () => {
  const { app, db, dir } = makeApp();
  try {
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/abort' });
    assert.equal(res.json().ok, false);
    assert.equal(res.json().reason, 'no_run');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
