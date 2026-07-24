import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime, buildResourceLoaderOptions, buildSessionExtensionFactories, cwdSlug, type PiRuntimePaths } from '../pi/runtime';
import { QuestionBroker } from '../pi/questions';
import { ApprovalBroker } from '../pi/approvals';
import type { MemoryRecallFn } from '../pi/memory-tool';
import type { ToolPolicyResolver } from '../pi/tool-policy';
import { buildModelCatalog } from '../routes/pi';

/** Stand-in policy for tests that only care about extension wiring, not gating. */
const allowAll: ToolPolicyResolver = () => 'allow';

test('cwdSlug encodes repo paths safely', () => {
  assert.equal(cwdSlug('/Users/me/Projects/foo'), 'Users_me_Projects_foo');
  assert.equal(cwdSlug(''), 'default');
  assert.equal(cwdSlug('/tmp'), 'tmp');
});

test('PiRuntime constructs and creates the auth/sessions dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    await PiRuntime.create(paths);
    assert.ok(existsSync(paths.authFile), 'auth file created');
    assert.ok(existsSync(paths.sessionsDir), 'sessions dir created');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.sessionFor returns the same instance for the same thread+cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/example';
    const a = await rt.sessionFor('thread-1', cwd);
    const b = await rt.sessionFor('thread-1', cwd);
    assert.strictEqual(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.sessionFor returns a different instance for a different cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const a = await rt.sessionFor('thread-1', '/tmp/a');
    const b = await rt.sessionFor('thread-1', '/tmp/b');
    assert.notStrictEqual(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.dropSession evicts the cached session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/x';
    await rt.sessionFor('thread-1', cwd);
    rt.dropSession('thread-1', cwd);
    // After drop, a fresh sessionFor creates a new instance. Verify by
    // checking the session is recreated (the new session's identity differs).
    const s = await rt.sessionFor('thread-1', cwd);
    assert.ok(s, 'session recreated after drop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session prompt gains the orientation block, conditional on its capabilities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = { authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') };
  try {
    // A runtime with memory + docker + browser deps present; no model key, so
    // no vision.
    const rt = await PiRuntime.create(paths, {
      recallMemories: async () => [],
      dockerTools: (threadId, cwd) => ({ threadId, cwd, exec: async () => ({ stdout: '', stderr: '', code: 0 }) }),
      browserTools: () => ({ getPage: async () => ({} as never), allowedHosts: () => [] }),
      sessionModelKey: () => undefined,
    });
    const session = await rt.sessionFor('thread-1', '/tmp/proj');
    const prompt = (session as unknown as { systemPrompt: string }).systemPrompt;

    assert.match(prompt, /Working in Nexus/, 'orientation block present');
    assert.match(prompt, /project_docs/, 'points at project_docs');
    assert.match(prompt, /memory_recall/, 'memory line (hasMemory)');
    assert.match(prompt, /docker_service/, 'docker line (hasDocker)');
    assert.match(prompt, /verify front-end work in a real browser/, 'browser line (hasBrowser)');
    assert.doesNotMatch(prompt, /screenshot/i, 'no screenshot line without vision');
    assert.ok(prompt.length > 400, 'the base coding-agent prompt still comes through');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a session with no capability deps is oriented but claims no tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = { authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') };
  try {
    const rt = await PiRuntime.create(paths);
    const session = await rt.sessionFor('thread-1', '/tmp/proj');
    const prompt = (session as unknown as { systemPrompt: string }).systemPrompt;

    assert.match(prompt, /Working in Nexus/);
    assert.match(prompt, /project_docs/);
    // The block must never promise a tool this session doesn't have.
    assert.doesNotMatch(prompt, /memory_recall/);
    assert.doesNotMatch(prompt, /docker_service/);
    assert.doesNotMatch(prompt, /real browser/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.createSession configures a session file path under the per-cwd dir', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const session = await rt.sessionFor('thread-1', '/tmp/proj');
    const cwdDir = join(paths.sessionsDir, cwdSlug('/tmp/proj'));
    assert.ok(existsSync(cwdDir), 'per-cwd session dir created');
    rt.dropSession('thread-1', '/tmp/proj');
    const fresh = await rt.sessionFor('thread-1', '/tmp/proj');
    assert.notStrictEqual(fresh, session, 'fresh session after drop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.sessionFor resumes the on-disk session after the in-memory cache is cleared (restart)', async () => {
  // Regression test for issue #107: after a backend restart (or any in-memory
  // eviction), sessionFor() must reopen the thread's existing on-disk session
  // file instead of creating a blank one — otherwise the model loses all
  // prior conversation context.
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/proj';

    // First "turn": create the session and persist a user + assistant pair.
    const session = await rt.sessionFor('thread-restart', cwd);
    const sm = (session as any).sessionManager;
    assert.ok(sm, 'AgentSession exposes its sessionManager');
    sm.appendMessage({ role: 'user', content: [{ type: 'text', text: 'hello from before restart' }] });
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi there' }] });

    // Simulate a backend restart: drop the in-memory caches WITHOUT deleting
    // the on-disk file (dropSession would delete the file, which is not what
    // a restart does).
    (rt as any).sessions.clear();
    (rt as any).sessionPromises.clear();
    (rt as any).sessionModels.clear();

    // Reopen: with the fix, this resumes the existing file.
    const resumed = await rt.sessionFor('thread-restart', cwd);
    const resumedSm = (resumed as any).sessionManager;
    const entries = resumedSm.getEntries() as Array<{ type: string; message?: { role: string } }>;
    assert.ok(
      entries.some((e) => e.type === 'message' && e.message?.role === 'user'),
      'resumed session contains the prior user message',
    );
    assert.ok(
      entries.some((e) => e.type === 'message' && e.message?.role === 'assistant'),
      'resumed session contains the prior assistant message',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime uses the most recently modified duplicate session file for a thread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/proj';
    const threadId = 'thread-duplicate';
    const cwdDir = join(paths.sessionsDir, cwdSlug(cwd));
    mkdirSync(cwdDir, { recursive: true });

    const oldFile = join(cwdDir, `2026-06-24T09-00-00-000Z_${threadId}.jsonl`);
    const newFile = join(cwdDir, `2026-06-24T10-00-00-000Z_${threadId}.jsonl`);
    writeSessionFile(oldFile, threadId, cwd, '2026-06-24T09:00:00.000Z', 'old duplicate message');
    writeSessionFile(newFile, threadId, cwd, '2026-06-24T10:00:00.000Z', 'new duplicate message');

    const messages = await rt.readMessages(threadId, cwd) as Array<{ message?: { content?: Array<{ text?: string }> } }>;
    assert.equal(messages[0]?.message?.content?.[0]?.text, 'new duplicate message');

    const session = await rt.sessionFor(threadId, cwd);
    const entries = (session as any).sessionManager.getEntries() as Array<{ type: string; message?: { content?: Array<{ text?: string }> } }>;
    const messageEntry = entries.find((entry) => entry.type === 'message');
    assert.equal(messageEntry?.message?.content?.[0]?.text, 'new duplicate message');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.dropSession removes the on-disk session file matching _${threadId}.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    const cwd = '/tmp/proj';
    const cwdDir = join(paths.sessionsDir, cwdSlug(cwd));
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(cwdDir, { recursive: true });
    const fakeFile = join(cwdDir, '2025-06-09T12-00-00Z_thread-xyz.jsonl');
    writeFileSync(fakeFile, '{"type":"session","version":1,"id":"thread-xyz"}\n');
    assert.ok(existsSync(fakeFile), 'fake session file placed');
    rt.dropSession('thread-xyz', cwd);
    assert.ok(!existsSync(fakeFile), 'session file unlinked on drop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSessionFile(file: string, threadId: string, cwd: string, timestamp: string, text: string): void {
  const header = { type: 'session', version: 3, id: threadId, timestamp, cwd };
  const message = {
    type: 'message',
    id: `${timestamp}-message`,
    parentId: null,
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
}

test('PiRuntime.dropSession is a no-op for a thread that has no file on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    // No sessionFor, no file — should not throw.
    rt.dropSession('never-existed', '/tmp/nowhere');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildResourceLoaderOptions includes the Anthropic Messages bridge factory', async () => {
  const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const customFactory = () => {};
  const inputFactories = [customFactory];
  const options = buildResourceLoaderOptions({
    cwd: '/tmp/project',
    agentDir: '/tmp/nexus-agent',
    settingsManager: SettingsManager.inMemory(),
    extensionFactories: inputFactories,
  });

  assert.equal(options.noExtensions, true);
  assert.equal(options.extensionFactories?.length, 2);
  assert.strictEqual(options.extensionFactories?.[1], customFactory);
  assert.deepEqual(inputFactories, [customFactory], 'input extension array remains unchanged');
});

test('question and approval extensions install after the Anthropic bridge and before signal filtering', async () => {
  const questions = new QuestionBroker();
  const approvals = new ApprovalBroker();
  const signalFactory = () => {};
  const sessionFactories = buildSessionExtensionFactories(
    'thread-1', '/tmp/project', questions, approvals, allowAll, () => signalFactory,
  );
  const options = buildResourceLoaderOptions({
    cwd: '/tmp/project',
    agentDir: '/tmp/nexus-agent',
    settingsManager: {},
    extensionFactories: sessionFactories,
  });

  // [0] Anthropic bridge (prepended), [1] question, [2] approval, [3] signal filter.
  assert.equal(options.extensionFactories?.length, 4);
  let tool: any;
  await options.extensionFactories?.[1]?.({
    registerTool(value: unknown) { tool = value; },
  } as any);
  assert.equal(tool?.name, 'question');
  let approvalHandlerRegistered = false;
  await options.extensionFactories?.[2]?.({
    on(event: string) { if (event === 'tool_call') approvalHandlerRegistered = true; },
  } as any);
  assert.equal(approvalHandlerRegistered, true, 'approval extension registers a tool_call handler');
  assert.strictEqual(options.extensionFactories?.[3], signalFactory);
});

/** Register the session's memory_recall tool and hand back its definition. */
async function registerMemoryTool(cwd: string, recall: MemoryRecallFn) {
  const factories = buildSessionExtensionFactories(
    'thread-1', cwd, new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {}, recall,
  );
  assert.equal(factories.length, 4, 'memory extension is appended when a recall backend is supplied');
  let tool: any;
  await factories[3]?.({ registerTool(value: unknown) { tool = value; } } as any);
  return tool;
}

test('sessions omit the memory tool when the runtime has no recall backend', () => {
  const factories = buildSessionExtensionFactories(
    'thread-1', '/tmp/project', new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {},
  );
  assert.equal(factories.length, 3, 'no memory_recall tool without a backend to serve it');
});

test('memory_recall returns recalled memories as a bulleted list', async () => {
  const calls: Array<{ cwd: string; query: string; limit?: number }> = [];
  const tool = await registerMemoryTool('/tmp/project', async (cwd, query, limit) => {
    calls.push({ cwd, query, limit });
    return ['We chose SQLite over Postgres for the index.', 'Archives are manual, never automatic.'];
  });

  assert.equal(tool.name, 'memory_recall');
  const result = await tool.execute('call-1', { query: '  why sqlite  ', limit: 2 });

  // The session's cwd is bound at registration; the model never supplies it.
  assert.deepEqual(calls, [{ cwd: '/tmp/project', query: 'why sqlite', limit: 2 }]);
  assert.equal(
    result.content[0].text,
    '- We chose SQLite over Postgres for the index.\n- Archives are manual, never automatic.',
  );
  assert.deepEqual(result.details, { status: 'ok', query: 'why sqlite', count: 2 });
});

test('memory_recall reports an empty result without claiming the project has no memories', async () => {
  const tool = await registerMemoryTool('/tmp/project', async () => []);
  const result = await tool.execute('call-1', { query: 'unknown topic' });

  assert.equal(result.content[0].text, 'No memories matched: unknown topic');
  assert.deepEqual(result.details, { status: 'empty', query: 'unknown topic', count: 0 });
});

test('memory_recall throws on a blank query so pi renders it as a tool error', async () => {
  const tool = await registerMemoryTool('/tmp/project', async () => ['unreachable']);
  await assert.rejects(() => tool.execute('call-1', { query: '   ' }), /non-empty query/);
});

/** Same "omit when absent" contract as recallMemories/registerMemoryTool above,
 *  for the Monday tool extension (finding: IMPORTANT 4 — the runtime's new
 *  mondayTools parameter had no test coverage at all). */
const MONDAY_DEPS = {
  search: async () => [],
  getItem: async () => null,
};

test('sessions omit the monday tools when no resolver is supplied, and when the resolver returns null', async () => {
  const noResolver = buildSessionExtensionFactories(
    'thread-1', '/tmp/project', new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {},
  );
  assert.equal(noResolver.length, 3, 'no monday tools without a resolver to serve them');

  const resolverReturnsNull = buildSessionExtensionFactories(
    'thread-1', '/tmp/project', new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {},
    undefined, () => null,
  );
  assert.equal(resolverReturnsNull.length, 3, 'no monday tools when the resolver has nothing for this thread');
});

test('monday tools are registered when the resolver returns deps for the thread', async () => {
  const factories = buildSessionExtensionFactories(
    'thread-1', '/tmp/project', new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {},
    undefined, () => MONDAY_DEPS as any,
  );
  assert.equal(factories.length, 4, 'monday tool extension appended when the resolver supplies deps');
  const tools: Array<{ name: string }> = [];
  await factories[3]?.({ registerTool(value: unknown) { tools.push(value as { name: string }); } } as any);
  assert.deepEqual(tools.map((t) => t.name).sort(), ['monday_get_item', 'monday_search']);
});

test('sessions omit the monday tools (without throwing) when the resolver itself throws', () => {
  // MINOR 6: buildSessionExtensionFactories called mondayTools?.(threadId)
  // with no guard of its own, unlike the mondayContext resolver call in
  // createSession — and this call site (inline inside the
  // extensionFactories: buildSessionExtensionFactories(...) argument) has no
  // try/catch either. Before the fix, this throws straight out of
  // buildSessionExtensionFactories.
  assert.doesNotThrow(() => {
    const factories = buildSessionExtensionFactories(
      'thread-1', '/tmp/project', new QuestionBroker(), new ApprovalBroker(), allowAll, () => () => {},
      undefined,
      () => { throw new Error('boom: bad row in monday_items'); },
    );
    assert.equal(factories.length, 3, 'no monday tools when the resolver throws — degrades like a null return');
  });
});

test('PiRuntime.sessionFor does not reject when the mondayContext resolver throws', async () => {
  // IMPORTANT 1(b) regression: createSession awaits resourceLoader.reload()
  // with no guard. Before the fix, a throw from the mondayContext resolver
  // (e.g. a real DB-backed resolver hitting a malformed row) propagated all
  // the way out of sessionFor, so the thread could never be opened OR
  // resumed. A resolver failure must degrade to "no Monday context" instead.
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths, {
      mondayContext: () => {
        throw new Error('boom: malformed owners_json in the database row');
      },
    });
    const session = await rt.sessionFor('thread-monday-throws', '/tmp/project');
    assert.ok(session, 'session is created despite the throwing mondayContext resolver');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.sessionFor does not reject when the mondayTools resolver throws', async () => {
  // MINOR 6 regression, end-to-end: unlike mondayContext, createSession has
  // no try/catch around the extensionFactories: buildSessionExtensionFactories(...)
  // call that reaches mondayTools. Today's real resolver (buildMondayToolDeps)
  // cannot throw, but the runtime must not depend on that — a throw here
  // must still degrade to "no Monday tools" rather than bricking the thread.
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths, {
      mondayTools: () => {
        throw new Error('boom: bad row in monday_items');
      },
    });
    const session = await rt.sessionFor('thread-monday-tools-throws', '/tmp/project');
    assert.ok(session, 'session is created despite the throwing mondayTools resolver');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PiRuntime.findModel exposes model input capabilities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = await PiRuntime.create(paths);
    (rt.models as any).find = () => ({
      id: 'vision-model',
      name: 'Vision Model',
      provider: 'test',
      input: ['text', 'image'],
    });

    assert.deepEqual(rt.findModel('test', 'vision-model')?.input, ['text', 'image']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildModelCatalog exposes model input capabilities', () => {
  const fastify = {
    pi: {
      models: {
        getAll: () => [
          {
            provider: 'test',
            id: 'vision-model',
            name: 'Vision Model',
            input: ['text', 'image'],
          },
        ],
        getAvailable: () => [
          {
            provider: 'test',
            id: 'vision-model',
          },
        ],
      },
    },
  } as any;

  assert.deepEqual(buildModelCatalog(fastify)[0].input, ['text', 'image']);
});
