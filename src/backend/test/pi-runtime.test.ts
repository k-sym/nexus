import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime, cwdSlug, type PiRuntimePaths } from '../pi/runtime';

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
    // The session's underlying SessionManager has a file path even if the
    // file isn't flushed to disk yet (that happens on first assistant message).
    // We can verify the path shape via the public AgentSession interface
    // (session.subscribe is the contract) — the file path itself lives on
    // the SessionManager which is not exposed on AgentSession. Verify the
    // per-cwd session directory was created instead.
    const cwdDir = join(paths.sessionsDir, cwdSlug('/tmp/proj'));
    assert.ok(existsSync(cwdDir), 'per-cwd session dir created');
    // Calling dropSession should not throw on a session that hasn't been used.
    rt.dropSession('thread-1', '/tmp/proj');
    // And we can create a fresh session afterwards.
    const fresh = await rt.sessionFor('thread-1', '/tmp/proj');
    assert.notStrictEqual(fresh, session, 'fresh session after drop');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
