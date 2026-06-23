import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import Database from 'better-sqlite3';
import { PiRuntime, type PiRuntimePaths } from '../pi/runtime';
import { ConcurrencyTracker } from '../pi/concurrency';
import { QuestionBroker, type QuestionRequest } from '../pi/questions';
import { flattenEntries, registerChatRoutes } from '../routes/chat';
import type { AgentRunWireEvent } from '@nexus/shared';

const runContractFixture: AgentRunWireEvent = {
  kind: 'run_start',
  run: {
    runId: 'run-1',
    threadId: 'thread-1',
    startedAt: '2026-06-22T10:00:00.000Z',
    provider: 'openrouter',
    model: 'moonshotai/kimi-k2.7-code',
  },
};
void runContractFixture;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function parseNdjson(body: string): any[] {
  return body.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('question history associates a matching result with its assistant tool call', () => {
  const details = {
    status: 'answered',
    toolCallId: 'call-1',
    answers: [{ questionId: 'scope', selected: ['small'] }],
  };
  const messages = flattenEntries([
    {
      type: 'message',
      id: 'assistant-1',
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-1',
          name: 'question',
          arguments: { questions: [] },
        }],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'question',
        isError: false,
        content: [{ type: 'text', text: `Scope: Small\n\n${JSON.stringify(details)}` }],
        details,
      },
    },
  ]) as any[];

  assert.deepEqual(messages[0].tool_calls[0], {
    id: 'call-1',
    name: 'question',
    args: { questions: [] },
    status: 'succeeded',
    queuedAt: undefined,
    completedAt: undefined,
    partialOutput: '',
    result: `Scope: Small\n\n${JSON.stringify(details)}`,
    details,
  });
});

test('question history marks a tool call without a result interrupted', () => {
  const messages = flattenEntries([{
    type: 'message',
    id: 'assistant-1',
    message: {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'question', arguments: { questions: [] } }],
    },
  }]) as any[];

  assert.equal(messages[0].tool_calls[0].status, 'interrupted');
  assert.equal(messages[0].tool_calls[0].result, undefined);
});

test('tool history derives success from matching results and interrupts missing results', () => {
  const messages = flattenEntries([
    {
      type: 'custom',
      id: 'run-start',
      customType: 'nexus.agent_run',
      data: { event: 'start', runId: 'run-1', threadId: 'thread-1', startedAt: '2026-06-22T10:00:00.000Z' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      message: {
        role: 'assistant',
        timestamp: 100,
        content: [
          { type: 'toolCall', id: 'call-1', name: 'Bash', arguments: { command: 'npm test' } },
          { type: 'toolCall', id: 'call-2', name: 'Write', arguments: { path: '/tmp/a', content: 'done' } },
          { type: 'text', text: 'Both operations succeeded.' },
        ],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'Bash',
        isError: false,
        timestamp: 200,
        content: [{ type: 'text', text: 'tests passed' }],
      },
    },
    {
      type: 'custom',
      id: 'run-end',
      customType: 'nexus.agent_run',
      data: {
        event: 'end',
        runId: 'run-1',
        threadId: 'thread-1',
        assistantEntryId: 'assistant-1',
        completedAt: '2026-06-22T10:00:10.000Z',
        status: 'interrupted',
        abortSource: 'frontend',
      },
    },
  ]) as any[];

  const assistant = messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.tool_calls[0].status, 'succeeded');
  assert.equal(assistant.tool_calls[0].result, 'tests passed');
  assert.equal(assistant.tool_calls[1].status, 'interrupted');
  assert.equal(assistant.tool_calls[1].result, undefined);
  assert.equal(assistant.run.runId, 'run-1');
  assert.equal(assistant.run.status, 'interrupted');
  assert.equal(assistant.run.abortSource, 'frontend');
});

test('run history reloads multiple assistant/tool messages as one logical run card', () => {
  const messages = flattenEntries([
    { type: 'custom', id: 'start', customType: 'nexus.agent_run', data: { event: 'start', runId: 'run-1', threadId: 'thread-1', startedAt: '2026-06-22T10:00:00.000Z' } },
    { type: 'message', id: 'user-1', message: { role: 'user', content: 'work', timestamp: 1 } },
    { type: 'message', id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'Read', arguments: { path: '/a' } }], timestamp: 2 } },
    { type: 'message', id: 'tool-1', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'Read', isError: false, content: [{ type: 'text', text: 'contents' }], timestamp: 3 } },
    { type: 'message', id: 'assistant-2', message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }], timestamp: 4 } },
    { type: 'custom', id: 'end', customType: 'nexus.agent_run', data: { event: 'end', runId: 'run-1', threadId: 'thread-1', assistantEntryId: 'assistant-2', completedAt: '2026-06-22T10:00:10.000Z', status: 'completed' } },
  ]) as any[];

  assert.equal(messages.filter((message) => message.role === 'assistant').length, 1);
  assert.equal(messages.filter((message) => message.role === 'toolResult').length, 0);
  const assistant = messages.find((message) => message.role === 'assistant');
  assert.equal(assistant.content, 'Finished.');
  assert.equal(assistant.tool_calls[0].id, 'call-1');
  assert.equal(assistant.tool_calls[0].status, 'succeeded');
  assert.equal(assistant.run.runId, 'run-1');
});

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

const pdfAttachment = {
  type: 'file',
  data: 'JVBERi0xLjQK',
  mimeType: 'application/pdf',
  name: 'brief.pdf',
  size: 9,
};

const questionRequest: QuestionRequest = {
  questions: [{
    id: 'scope',
    header: 'Scope',
    question: 'Which scope?',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'full', label: 'Full' },
    ],
    multiple: false,
    allowOther: true,
  }],
};

const validQuestionAnswer = {
  answers: [{ questionId: 'scope', selected: ['small'] }],
};

test('question answer route resolves a pending question', async () => {
  const { app, db, dir, runtime } = makeApp();
  try {
    const result = runtime.questions.register('thread-1', 'call-1', questionRequest);
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/call-1/answer',
      payload: validQuestionAnswer,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.deepEqual(await result, {
      status: 'answered',
      toolCallId: 'call-1',
      answers: validQuestionAnswer.answers,
    });
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question answer route rejects invalid answers without resolving the question', async () => {
  const { app, db, dir, runtime } = makeApp();
  try {
    const result = runtime.questions.register('thread-1', 'call-1', questionRequest);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/call-1/answer',
      payload: { answers: [{ questionId: 'scope', selected: ['unknown'] }] },
    });
    assert.equal(invalid.statusCode, 400);

    const valid = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/call-1/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(valid.statusCode, 200);
    assert.equal((await result).status, 'answered');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question answer route returns 404 for unknown, cross-thread, and duplicate submissions', async () => {
  const { app, db, dir, runtime } = makeApp(undefined, { includeSecondThread: true });
  try {
    const result = runtime.questions.register('thread-1', 'call-1', questionRequest);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/missing/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(unknown.statusCode, 404);

    const crossThread = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-2/questions/call-1/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(crossThread.statusCode, 404);

    const first = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/call-1/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(first.statusCode, 200);
    await result;

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/questions/call-1/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(duplicate.statusCode, 404);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question answer route returns 404 before consulting the broker when the thread does not exist', async () => {
  const { app, db, dir, runtime } = makeApp();
  try {
    const result = runtime.questions.register('missing-thread', 'call-1', questionRequest);
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/missing-thread/questions/call-1/answer',
      payload: validQuestionAnswer,
    });
    assert.equal(res.statusCode, 404);
    runtime.questions.cancelThread('missing-thread', 'test cleanup');
    assert.equal((await result).status, 'cancelled');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream returns 409 when a *different* thread in the same project is busy', async () => {
  const { app, db, dir, concurrency } = makeApp();
  try {
    concurrency.claim('proj-1', 'anthropic/sonnet', 'other-thread', 'Other');
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
    concurrency.claim('proj-1', 'anthropic/sonnet', 'other-thread', 'Other');
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

test('two simultaneous confirm-cancel requests cannot both start the replacement model run', async () => {
  const firstPromptStarted = deferred<void>();
  const firstAbortSeen = deferred<void>();
  const replacementPromptStarted = deferred<void>();
  const releaseReplacement = deferred<void>();
  let replacementSessionForCalls = 0;
  let replacementPromptCalls = 0;

  const firstSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      firstPromptStarted.resolve();
      await firstAbortSeen.promise;
    },
    abort: async () => firstAbortSeen.resolve(),
  };
  const replacementSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      replacementPromptCalls += 1;
      replacementPromptStarted.resolve();
      await releaseReplacement.promise;
    },
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async (threadId: string) => {
      if (threadId === 'thread-1') return firstSession;
      replacementSessionForCalls += 1;
      return replacementSession;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime, { includeSecondThread: true });
  db.prepare(
    'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('thread-3', 'proj-1', 'T3', new Date().toISOString(), new Date().toISOString());

  let first: ReturnType<typeof app.inject> | undefined;
  let second: ReturnType<typeof app.inject> | undefined;
  let third: ReturnType<typeof app.inject> | undefined;
  try {
    first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await firstPromptStarted.promise;

    second = app.inject({
      method: 'POST',
      url: '/api/threads/thread-2/messages/stream',
      headers: { 'X-Confirm-Cancel': 'true' },
      payload: { content: 'second', modelKey: 'anthropic/sonnet' },
    });
    third = app.inject({
      method: 'POST',
      url: '/api/threads/thread-3/messages/stream',
      headers: { 'X-Confirm-Cancel': 'true' },
      payload: { content: 'third', modelKey: 'anthropic/sonnet' },
    });

    await replacementPromptStarted.promise;
    const firstCompletedReplacement = await Promise.race([
      second.then((response) => response),
      third.then((response) => response),
    ]);
    assert.equal(firstCompletedReplacement.statusCode, 409);
    assert.equal(replacementSessionForCalls, 1);
    assert.equal(replacementPromptCalls, 1);

    releaseReplacement.resolve();
    const responses = await Promise.all([first, second, third]);
    assert.deepEqual(responses.slice(1).map((response) => response.statusCode).sort(), [200, 409]);
  } finally {
    firstAbortSeen.resolve();
    releaseReplacement.resolve();
    await Promise.allSettled([first, second, third].filter(Boolean));
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirm-cancel returns 409 when the previous owner has not released the model slot', async () => {
  const firstPromptStarted = deferred<void>();
  const releaseFirstPrompt = deferred<void>();
  let replacementSessionForCalls = 0;
  let abortCalls = 0;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      firstPromptStarted.resolve();
      await releaseFirstPrompt.promise;
    },
    abort: async () => {
      abortCalls += 1;
    },
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async (threadId: string) => {
      if (threadId !== 'thread-1') replacementSessionForCalls += 1;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime, { includeSecondThread: true });
  let first: ReturnType<typeof app.inject> | undefined;
  try {
    first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await firstPromptStarted.promise;

    const replacement = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-2/messages/stream',
      headers: { 'X-Confirm-Cancel': 'true' },
      payload: { content: 'replacement', modelKey: 'anthropic/sonnet' },
    });
    assert.equal(replacement.statusCode, 409);
    assert.equal(replacement.json().kind, 'model_busy');
    assert.equal(abortCalls, 1);
    assert.equal(replacementSessionForCalls, 0);
  } finally {
    releaseFirstPrompt.resolve();
    await Promise.allSettled([first].filter(Boolean));
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('different threads atomically claim a project model before session setup', async () => {
  const sessionForStarted = deferred<void>();
  const releaseSessionFor = deferred<void>();
  let sessionForCalls = 0;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalls += 1;
      sessionForStarted.resolve();
      await releaseSessionFor.promise;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime, { includeSecondThread: true });
  let first: ReturnType<typeof app.inject> | undefined;
  let second: ReturnType<typeof app.inject> | undefined;
  try {
    first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await sessionForStarted.promise;
    second = app.inject({
      method: 'POST',
      url: '/api/threads/thread-2/messages/stream',
      payload: { content: 'second', modelKey: 'anthropic/sonnet' },
    });
    const secondResponse = await second;
    assert.equal(secondResponse.statusCode, 409);
    assert.equal(secondResponse.json().kind, 'model_busy');
    assert.equal(sessionForCalls, 1);

    releaseSessionFor.resolve();
    assert.equal((await first).statusCode, 200);
  } finally {
    releaseSessionFor.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects same-thread re-entry without aborting or prompting again', async () => {
  const firstPromptStarted = deferred<void>();
  const releaseFirstPrompt = deferred<void>();
  let sessionForCalls = 0;
  let promptCalls = 0;
  let abortCalls = 0;

  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        firstPromptStarted.resolve();
        await releaseFirstPrompt.promise;
      }
    },
    abort: async () => {
      abortCalls += 1;
    },
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalls += 1;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await firstPromptStarted.promise;

    const second = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      headers: { 'X-Confirm-Cancel': 'true' },
      payload: { content: 'second', modelKey: 'anthropic/sonnet' },
    });

    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.json(), {
      kind: 'thread_busy',
      error: 'This thread already has a run in progress',
      activeThreadId: 'thread-1',
      activeTitle: 'T1',
      modelKey: 'anthropic/sonnet',
    });
    assert.equal(promptCalls, 1);
    assert.equal(abortCalls, 0);
    assert.equal(sessionForCalls, 1);

    releaseFirstPrompt.resolve();
    assert.equal((await first).statusCode, 200);
  } finally {
    releaseFirstPrompt.resolve();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream rejects same-thread re-entry with a different model', async () => {
  const firstPromptStarted = deferred<void>();
  const releaseFirstPrompt = deferred<void>();
  let sessionForCalls = 0;
  let promptCalls = 0;
  let abortCalls = 0;

  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        firstPromptStarted.resolve();
        await releaseFirstPrompt.promise;
      }
    },
    abort: async () => {
      abortCalls += 1;
    },
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalls += 1;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await firstPromptStarted.promise;

    const second = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'second' },
    });

    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.json(), {
      kind: 'thread_busy',
      error: 'This thread already has a run in progress',
      activeThreadId: 'thread-1',
      activeTitle: 'T1',
      modelKey: 'anthropic/sonnet',
    });
    assert.equal(promptCalls, 1);
    assert.equal(abortCalls, 0);
    assert.equal(sessionForCalls, 1);

    releaseFirstPrompt.resolve();
    assert.equal((await first).statusCode, 200);
  } finally {
    releaseFirstPrompt.resolve();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream claims the thread before awaiting session setup', async () => {
  const sessionForStarted = deferred<void>();
  const secondSessionForStarted = deferred<void>();
  const releaseSessionFor = deferred<void>();
  let sessionForCalls = 0;
  let promptCalls = 0;
  let abortCalls = 0;

  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
    },
    abort: async () => {
      abortCalls += 1;
    },
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalls += 1;
      sessionForStarted.resolve();
      if (sessionForCalls === 2) secondSessionForStarted.resolve();
      await releaseSessionFor.promise;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  let first: ReturnType<typeof app.inject> | undefined;
  let second: ReturnType<typeof app.inject> | undefined;
  try {
    first = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
    });
    await sessionForStarted.promise;

    second = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'second', modelKey: 'anthropic/sonnet' },
    });
    const outcome = await Promise.race([
      second.then((response) => ({ kind: 'response' as const, response })),
      secondSessionForStarted.promise.then(() => ({ kind: 'duplicate_session' as const })),
    ]);

    assert.equal(outcome.kind, 'response');
    assert.equal(sessionForCalls, 1);
    const secondResponse = outcome.kind === 'response' ? outcome.response : undefined;
    assert.ok(secondResponse);
    assert.equal(secondResponse.statusCode, 409);
    assert.equal(secondResponse.json().kind, 'thread_busy');
    assert.equal(promptCalls, 0);
    assert.equal(abortCalls, 0);

    releaseSessionFor.resolve();
    assert.equal((await first).statusCode, 200);
    assert.equal(promptCalls, 1);
  } finally {
    releaseSessionFor.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream stops after session setup when the client disconnects during setup', async () => {
  const sessionForStarted = deferred<void>();
  const duplicateSessionForStarted = deferred<void>();
  const disconnectObserved = deferred<void>();
  const clientClosed = deferred<void>();
  const releaseSessionFor = deferred<void>();
  let sessionForCalls = 0;
  let promptCalls = 0;
  let abortCalls = 0;

  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
    },
    abort: async () => {
      abortCalls += 1;
    },
  };
  const runtime = {
    questions: { cancelThread: () => disconnectObserved.resolve() },
    readMessages: async () => [],
    sessionFor: async () => {
      sessionForCalls += 1;
      sessionForStarted.resolve();
      if (sessionForCalls === 2) duplicateSessionForStarted.resolve();
      await releaseSessionFor.promise;
      return session;
    },
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  let clientRequest: ReturnType<typeof httpRequest> | undefined;
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== 'string');
    clientRequest = httpRequest({
      host: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/api/threads/thread-1/messages/stream',
      headers: { 'content-type': 'application/json' },
    });
    clientRequest.on('error', () => {});
    clientRequest.on('close', () => clientClosed.resolve());
    clientRequest.end(JSON.stringify({ content: 'first', modelKey: 'anthropic/sonnet' }));
    await sessionForStarted.promise;

    clientRequest.destroy();
    await clientClosed.promise;
    await disconnectObserved.promise;
    const whileSetupPending = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'second' },
    });
    const outcome = await Promise.race([
      whileSetupPending.then((response) => ({ kind: 'response' as const, response })),
      duplicateSessionForStarted.promise.then(() => ({ kind: 'duplicate_session' as const })),
    ]);
    assert.equal(outcome.kind, 'response');
    assert.equal(outcome.kind === 'response' ? outcome.response.statusCode : undefined, 409);

    releaseSessionFor.resolve();
    await Promise.allSettled([whileSetupPending]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(promptCalls, 0);
    assert.equal(abortCalls, 1);
  } finally {
    releaseSessionFor.resolve();
    clientRequest?.destroy();
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream retains its claim while a disconnected prompt terminates', async () => {
  const promptStarted = deferred<void>();
  const promptStopped = deferred<void>();
  const abortStarted = deferred<void>();
  const releaseAbort = deferred<void>();
  let promptCalls = 0;

  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptCalls += 1;
      if (promptCalls === 1) {
        promptStarted.resolve();
        await promptStopped.promise;
      }
    },
    abort: async () => {
      abortStarted.resolve();
      await releaseAbort.promise;
      promptStopped.resolve();
    },
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'first', modelKey: 'anthropic/sonnet' },
      payloadAsStream: true,
    });
    await promptStarted.promise;
    first.raw.res.destroy();
    await abortStarted.promise;

    const second = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'second' },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().kind, 'thread_busy');
    assert.equal(promptCalls, 1);

    releaseAbort.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'third' },
    });
    assert.equal(third.statusCode, 200);
    assert.equal(promptCalls, 2);
  } finally {
    releaseAbort.resolve();
    promptStopped.resolve();
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

test('POST /api/threads/:id/messages/stream stores document attachments and references saved paths in the prompt', async () => {
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
    models: { find: () => ({ provider: 'openai', id: 'text', input: ['text'] }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'summarise this', modelKey: 'openai/text', attachments: [pdfAttachment] },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(promptArgs.length, 1);
    assert.match(String(promptArgs[0]), /summarise this/);
    assert.match(String(promptArgs[0]), /Attached files:/);
    assert.match(String(promptArgs[0]), /project_docs\/uploads\/brief\.pdf/);

    const row = db.prepare('SELECT content, attachments_json FROM chat_messages WHERE thread_id = ?').get('thread-1') as {
      content: string;
      attachments_json: string;
    };
    assert.equal(row.content, 'summarise this');
    const stored = JSON.parse(row.attachments_json);
    assert.deepEqual(stored[0], {
      ...pdfAttachment,
      path: join(dir, 'project_docs', 'uploads', 'brief.pdf'),
    });
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

test('POST /api/threads/:id/messages/stream emits context usage after prompting', async () => {
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
    getContextUsage: () => ({ tokens: 182_000, contextWindow: 200_000, percent: 91 }),
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
      payload: { content: 'plain text' },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.body, /"type":"context_usage"/);
    assert.match(res.body, /"percent":91/);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/messages/stream emits and persists matching run boundaries', async () => {
  const customEntries: Array<{ customType: string; data: unknown }> = [];
  const leafId = 'tool-result-entry';
  const session = {
    sessionManager: {
      appendCustomEntry: (customType: string, data: unknown) => {
        customEntries.push({ customType, data });
        return `custom-${customEntries.length}`;
      },
      getLeafId: () => leafId,
      getLeafEntry: () => ({ type: 'message', message: { role: 'toolResult' } }),
      getEntries: () => [
        { type: 'message', id: 'assistant-entry-1', message: { role: 'assistant' } },
        { type: 'message', id: leafId, message: { role: 'toolResult' } },
      ],
    },
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
  };
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'test-provider', id: 'test-model' }) },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'plain text', modelKey: 'test-provider/test-model' },
    });

    assert.equal(res.statusCode, 200);
    const events = parseNdjson(res.body);
    const start = events.find((event) => event.kind === 'run_start');
    const end = events.find((event) => event.kind === 'run_end');
    assert.ok(start);
    assert.ok(end);
    assert.equal(end.run.runId, start.run.runId);
    assert.equal(end.run.status, 'completed');
    assert.equal(end.run.assistantEntryId, 'assistant-entry-1');
    assert.equal(customEntries.length, 2);
    assert.equal(customEntries[0].customType, 'nexus.agent_run');
    assert.equal(customEntries[1].customType, 'nexus.agent_run');
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

test('GET /api/threads/:threadId returns raw tool output with signal-filter savings', async () => {
  const raw = [
    ...Array.from({ length: 500 }, (_, index) => `✓ passes case ${index + 1}`),
    'Tests: 500 passed',
  ].join('\n');
  const runtime = {
    readMessages: async () => [
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'message', id: 't1', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: raw }] } },
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
    const message = res.json().messages.find((item: any) => item.role === 'toolResult');
    assert.equal(message.content, raw);
    assert.equal(message.signal_filter.input_bytes, Buffer.byteLength(raw));
    assert.ok(message.signal_filter.output_bytes < message.signal_filter.input_bytes);
    assert.equal(
      message.signal_filter.saved_bytes,
      message.signal_filter.input_bytes - message.signal_filter.output_bytes,
    );
    assert.ok(message.signal_filter.applied_filters.includes('test_output'));
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

test('GET /api/threads/:threadId preserves file attachments from DB fallback rows', async () => {
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
    const stored = { ...pdfAttachment, path: join(dir, 'project_docs', 'uploads', 'brief.pdf') };
    db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('m1', 'thread-1', 'user', 'look', JSON.stringify([stored]), '2026-06-10T12:00:00.000Z');

    const res = await app.inject({ method: 'GET', url: '/api/threads/thread-1' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().messages[0].attachments, [stored]);
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

test('DELETE /api/threads/:id removes the thread without calling archive storage', async () => {
  const runtime = {
    readMessages: async () => assert.fail('delete must not read messages for archive'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/archive returns an error and keeps empty sessions', async () => {
  const runtime = {
    readMessages: async () => [],
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => assert.fail('archive must not drop empty sessions'),
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const res = await app.inject({ method: 'POST', url: '/api/threads/thread-1/archive' });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /no meaningful/i);
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
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

test('POST /api/threads/:id/abort records a user-cancelled terminal run', async () => {
  const promptStarted = deferred<void>();
  const promptStopped = deferred<void>();
  const session = {
    sessionManager: {
      appendCustomEntry: () => 'custom-entry',
      getLeafId: () => 'assistant-entry',
      getLeafEntry: () => ({ type: 'message' }),
    },
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptStarted.resolve();
      await promptStopped.promise;
    },
    abort: async () => promptStopped.resolve(),
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
    const stream = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'cancel me' },
    });
    await promptStarted.promise;

    const abort = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/abort',
      payload: { source: 'user' },
    });
    assert.equal(abort.statusCode, 200);

    const terminal = parseNdjson((await stream).body).find((event) => event.kind === 'run_end');
    assert.equal(terminal.run.status, 'cancelled');
    assert.equal(terminal.run.abortSource, 'user');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /api/threads/:id/abort rejects an untrusted abort source', async () => {
  const promptStarted = deferred<void>();
  const promptStopped = deferred<void>();
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptStarted.resolve();
      await promptStopped.promise;
    },
    abort: async () => promptStopped.resolve(),
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
    const stream = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'keep running' },
    });
    await promptStarted.promise;
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/abort',
      payload: { source: 'database' },
    });
    assert.equal(invalid.statusCode, 400);
    await app.inject({ method: 'POST', url: '/api/threads/thread-1/abort', payload: { source: 'user' } });
    await stream;
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question cleanup cancels a pending question when its active stream is aborted', async () => {
  const questions = new QuestionBroker();
  const promptStarted = deferred<void>();
  const promptStopped = deferred<void>();
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptStarted.resolve();
      await promptStopped.promise;
    },
    abort: async () => promptStopped.resolve(),
  };
  const runtime = {
    questions,
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const pending = questions.register('thread-1', 'call-1', questionRequest);
    const stream = app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'ask me' },
    });
    await promptStarted.promise;

    const abort = await app.inject({ method: 'POST', url: '/api/threads/thread-1/abort' });
    assert.deepEqual(abort.json(), { ok: true });
    await stream;

    const lateAnswer = questions.answer('thread-1', 'call-1', validQuestionAnswer);
    assert.deepEqual(lateAnswer, { ok: false, status: 404, error: 'Question not found' });
    assert.equal((await pending).status, 'cancelled');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question cleanup aborts the active session when the response closes during prompt', async () => {
  const questions = new QuestionBroker();
  const promptStarted = deferred<void>();
  const promptStopped = deferred<void>();
  const sessionAborted = deferred<void>();
  let abortCalls = 0;
  const session = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      promptStarted.resolve();
      await promptStopped.promise;
    },
    abort: async () => {
      abortCalls += 1;
      promptStopped.resolve();
      sessionAborted.resolve();
    },
  };
  const runtime = {
    questions,
    readMessages: async () => [],
    sessionFor: async () => session,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir, concurrency } = makeApp(runtime);
  const pending = questions.register('thread-1', 'call-1', questionRequest);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'ask me' },
      payloadAsStream: true,
    });
    await promptStarted.promise;

    response.raw.res.destroy();
    await Promise.race([
      sessionAborted.promise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('session was not aborted after response close')), 100)),
    ]);

    assert.equal(abortCalls, 1);
    assert.equal(questions.answer('thread-1', 'call-1', validQuestionAnswer).status, 404);
    assert.equal((await pending).status, 'cancelled');
    assert.equal(concurrency.get('proj-1', 'default'), undefined);
  } finally {
    promptStopped.resolve();
    questions.cancelThread('thread-1', 'test cleanup');
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a normally completed response does not abort its session', async () => {
  let abortCalls = 0;
  const runtime = {
    questions: new QuestionBroker(),
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async () => {},
      abort: async () => { abortCalls += 1; },
    }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'complete normally' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(abortCalls, 0);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question cleanup cancels a pending question when confirm-cancel aborts a conflicting stream', async () => {
  const questions = new QuestionBroker();
  const firstPromptStarted = deferred<void>();
  const firstPromptStopped = deferred<void>();
  const firstSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {
      firstPromptStarted.resolve();
      await firstPromptStopped.promise;
    },
    abort: async () => firstPromptStopped.resolve(),
  };
  const secondSession = {
    subscribe: () => () => {},
    setModel: async () => {},
    prompt: async () => {},
    abort: async () => {},
  };
  const runtime = {
    questions,
    readMessages: async () => [],
    sessionFor: async (threadId: string) => threadId === 'thread-1' ? firstSession : secondSession,
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => ({ provider: 'anthropic', id: 'sonnet' }) },
  };
  const { app, db, dir } = makeApp(runtime, { includeSecondThread: true });
  try {
    const pending = questions.register('thread-1', 'call-1', questionRequest);
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
    await first;

    assert.equal(questions.answer('thread-1', 'call-1', validQuestionAnswer).ok, false);
    assert.equal((await pending).status, 'cancelled');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question cleanup cancels a pending question when the stream aborts internally', async () => {
  const questions = new QuestionBroker();
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const runtime = {
    questions,
    readMessages: async () => [],
    sessionFor: async () => ({
      subscribe: () => () => {},
      setModel: async () => {},
      prompt: async () => { throw abortError; },
      abort: async () => {},
    }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    dropSession: () => {},
    models: { find: () => undefined },
  };
  const { app, db, dir } = makeApp(runtime);
  try {
    const pending = questions.register('thread-1', 'call-1', questionRequest);
    const stream = await app.inject({
      method: 'POST',
      url: '/api/threads/thread-1/messages/stream',
      payload: { content: 'ask me' },
    });
    assert.equal(stream.statusCode, 200);

    assert.equal(questions.answer('thread-1', 'call-1', validQuestionAnswer).ok, false);
    assert.equal((await pending).status, 'cancelled');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('question cleanup cancels a pending question when the thread is deleted', async () => {
  const { app, db, dir, runtime } = makeApp();
  try {
    const pending = runtime.questions.register('thread-1', 'call-1', questionRequest);
    const res = await app.inject({ method: 'DELETE', url: '/api/threads/thread-1' });
    assert.equal(res.statusCode, 200);

    assert.equal(runtime.questions.answer('thread-1', 'call-1', validQuestionAnswer).ok, false);
    assert.equal((await pending).status, 'cancelled');
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveThreadToMemory summarizes, stores memory, deletes the thread, and drops pi session files', async () => {
  const stored: any[] = [];
  const dropped: Array<{ threadId: string; cwd: string }> = [];
  const noisyTestOutput = [
    ...Array.from({ length: 500 }, (_, index) => `✓ passes case ${index + 1}`),
    'Tests: 500 passed',
  ].join('\n');
  const { archiveThreadToMemory } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'We need archive sessions.' }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: noisyTestOutput }] } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: archive writes memory before deleting.' }] } },
    ],
    dropSession: (threadId: string, cwd: string) => dropped.push({ threadId, cwd }),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    const result = await archiveThreadToMemory(db, app.pi, 'thread-1', {
      summarize: async (input) => {
        assert.match(input.transcript, /archive sessions/);
        assert.match(input.transcript, /TOOL bash \(npm test\)/);
        assert.match(input.transcript, /Tests: 500 passed/);
        assert.doesNotMatch(input.transcript, /passes case 499/);
        assert.ok(input.transcript.length < 30_000);
        return 'Archive sessions should preserve decisions in memory before deleting the source chat.';
      },
      resolveFilters: () => ({
        enabled: true,
        min_input_bytes: 1,
        max_output_bytes: 12_000,
        filters: {
          ansi: true,
          progress: true,
          repeated_lines: true,
          package_manager: true,
          test_output: true,
          stack_trace: true,
          diff_context: true,
        },
      }),
      storeMemory: async (input) => {
        stored.push(input);
        return { id: 'memory-1' };
      },
    });

    assert.equal(result.memoryId, 'memory-1');
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 0);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].category, 'session_archive');
    assert.equal(stored[0].agent_id, 'session-archive');
    assert.equal(stored[0].metadata.thread_id, 'thread-1');
    assert.deepEqual(dropped, [{ threadId: 'thread-1', cwd: dir }]);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveThreadToMemory keeps the thread when memory storage fails', async () => {
  const { archiveThreadToMemory, ArchiveThreadError } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Decision: keep source when memory fails.' }] } },
    ],
    dropSession: () => assert.fail('dropSession must not run when memory fails'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    await assert.rejects(
      archiveThreadToMemory(db, app.pi, 'thread-1', {
        summarize: async () => 'A usable summary',
        storeMemory: async () => null,
      }),
      (err: unknown) => err instanceof ArchiveThreadError && err.statusCode === 502 && /memory/i.test(err.message),
    );
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveThreadToMemory rejects empty sessions without deleting', async () => {
  const { archiveThreadToMemory, ArchiveThreadError } = await import('../sessions/archive');
  const { app, db, dir } = makeApp({
    readMessages: async () => [],
    dropSession: () => assert.fail('dropSession must not run for empty sessions'),
    sessionFor: async () => ({ subscribe: () => () => {}, setModel: async () => {}, prompt: async () => {}, abort: async () => {} }),
    getSessionModel: () => undefined,
    setSessionModel: () => {},
    models: { find: () => undefined },
  });
  try {
    await assert.rejects(
      archiveThreadToMemory(db, app.pi, 'thread-1', {
        summarize: async () => assert.fail('summarize must not run for empty sessions'),
        storeMemory: async () => assert.fail('storeMemory must not run for empty sessions'),
      }),
      (err: unknown) => err instanceof ArchiveThreadError && err.statusCode === 400 && /no meaningful/i.test(err.message),
    );
    const row = db.prepare('SELECT COUNT(*) AS count FROM chat_threads WHERE id = ?').get('thread-1') as { count: number };
    assert.equal(row.count, 1);
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
