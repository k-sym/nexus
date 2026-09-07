import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { daemon, DaemonTimeoutError, HEALTH_TIMEOUT_MS } from '../memory/client';
import { initMemorySystem } from '../memory/index';

/**
 * Reproduces the 2026-09-07 wedge: the daemon's port accepts TCP connections but
 * never writes a byte of HTTP response. Without a bound, fetch() waits forever and
 * the backend never reaches app.listen().
 */
async function silentServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Accept, read whatever arrives, respond with nothing.
    socket.on('data', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('unexpected server address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    }),
  };
}

async function withSilentDaemon<T>(fn: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.MEMORY_DAEMON_URL;
  const server = await silentServer();
  process.env.MEMORY_DAEMON_URL = server.url;
  try {
    return await fn();
  } finally {
    if (previousUrl === undefined) delete process.env.MEMORY_DAEMON_URL;
    else process.env.MEMORY_DAEMON_URL = previousUrl;
    await server.close();
  }
}

test('daemon requests reject with DaemonTimeoutError when the daemon accepts but never responds', async () => {
  await withSilentDaemon(async () => {
    const started = Date.now();
    await assert.rejects(
      daemon.health({ timeoutMs: 200 }),
      (err: unknown) => {
        assert.ok(err instanceof DaemonTimeoutError, `expected DaemonTimeoutError, got ${String(err)}`);
        assert.equal(err.timeoutMs, 200);
        assert.match(err.message, /did not respond within 200ms \(GET \/health\)/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2_000, `timed out after ${elapsed}ms, expected ~200ms`);
  });
});

test('initMemorySystem resolves within the health bound and warns instead of hanging boot', async () => {
  await withSilentDaemon(async () => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    const started = Date.now();
    try {
      // The real boot path calls health() with no override, so this exercises HEALTH_TIMEOUT_MS.
      await initMemorySystem(null as never);
    } finally {
      console.warn = originalWarn;
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= HEALTH_TIMEOUT_MS - 50, `resolved suspiciously early after ${elapsed}ms`);
    assert.ok(elapsed < HEALTH_TIMEOUT_MS + 2_000, `boot probe took ${elapsed}ms, expected ~${HEALTH_TIMEOUT_MS}ms`);
    assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /\[memory\] daemon unreachable at boot/);
    assert.match(warnings[0], new RegExp(`did not respond within ${HEALTH_TIMEOUT_MS}ms`));
  });
});
