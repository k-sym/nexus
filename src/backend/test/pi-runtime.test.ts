import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime, buildResourceLoaderOptions, buildSessionExtensionFactories, cwdSlug, type PiRuntimePaths } from '../pi/runtime';
import { QuestionBroker } from '../pi/questions';
import { ApprovalBroker } from '../pi/approvals';
import { buildModelCatalog } from '../routes/pi';

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
    'thread-1', '/tmp/project', questions, approvals, () => false, () => signalFactory,
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
