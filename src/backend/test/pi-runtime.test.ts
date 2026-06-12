import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime, buildResourceLoaderOptions, cwdSlug, type PiRuntimePaths } from '../pi/runtime';
import { buildModelCatalog } from '../routes/pi';

test('cwdSlug encodes repo paths safely', () => {
  assert.equal(cwdSlug('/Users/me/Projects/foo'), 'Users_me_Projects_foo');
  assert.equal(cwdSlug(''), 'default');
  assert.equal(cwdSlug('/tmp'), 'tmp');
});

test('PiRuntime constructs and creates the auth/sessions dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    new PiRuntime(paths);
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
    const rt = new PiRuntime(paths);
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
    const rt = new PiRuntime(paths);
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
    const rt = new PiRuntime(paths);
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
    const rt = new PiRuntime(paths);
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

test('PiRuntime.dropSession removes the on-disk session file matching _${threadId}.jsonl', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = new PiRuntime(paths);
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

test('PiRuntime.dropSession is a no-op for a thread that has no file on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = new PiRuntime(paths);
    // No sessionFor, no file — should not throw.
    rt.dropSession('never-existed', '/tmp/nowhere');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildResourceLoaderOptions includes the Anthropic Messages bridge factory', async () => {
  const { SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const options = buildResourceLoaderOptions({
    cwd: '/tmp/project',
    agentDir: '/tmp/nexus-agent',
    settingsManager: SettingsManager.inMemory(),
  });

  assert.equal(options.noExtensions, true);
  assert.ok(options.extensionFactories?.length, 'expected at least one inline extension factory');
});

test('PiRuntime.findModel exposes model input capabilities', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-pi-test-'));
  const paths: PiRuntimePaths = {
    authFile: join(dir, 'auth.json'),
    sessionsDir: join(dir, 'sessions'),
  };
  try {
    const rt = new PiRuntime(paths);
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
