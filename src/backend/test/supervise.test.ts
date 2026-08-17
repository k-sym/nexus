import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  createHealthProbe,
  createListenerWatchdog,
  installShutdownHandlers,
  watchServerClose,
} from '../supervise.js';

/** A probe whose answers are scripted, so ticks are deterministic. */
function scriptedProbe(answers: boolean[]) {
  let i = 0;
  return () => Promise.resolve(answers[Math.min(i++, answers.length - 1)]);
}

test('watchdog stays quiet until the failures are consecutive and reach the threshold', async () => {
  const reasons: string[] = [];
  const watchdog = createListenerWatchdog({
    probe: scriptedProbe([false, false, true, false, false, false]),
    threshold: 3,
    onDead: (reason) => reasons.push(reason),
  });

  await watchdog.tick();
  await watchdog.tick();
  assert.equal(watchdog.failures(), 2);
  assert.deepEqual(reasons, [], 'two failures is short of the threshold');

  await watchdog.tick(); // succeeds
  assert.equal(watchdog.failures(), 0, 'a good probe clears the streak');
  assert.deepEqual(reasons, [], 'the earlier failures must not carry over');

  await watchdog.tick();
  await watchdog.tick();
  assert.deepEqual(reasons, [], 'the streak restarts from zero');
  await watchdog.tick();
  assert.equal(reasons.length, 1, 'three in a row is the wedge');
  assert.match(reasons[0], /3 consecutive probes/);
});

test('watchdog reports the dead listener only once', async () => {
  const reasons: string[] = [];
  const watchdog = createListenerWatchdog({
    probe: scriptedProbe([false]),
    threshold: 1,
    onDead: (reason) => reasons.push(reason),
  });

  await watchdog.tick();
  await watchdog.tick();
  await watchdog.tick();
  assert.equal(reasons.length, 1, 'the caller is exiting; further reports only muddy the log');
});

test('watchdog does not stack probes that outlive their interval', async () => {
  let started = 0;
  let release!: (ok: boolean) => void;
  const watchdog = createListenerWatchdog({
    probe: () => {
      started += 1;
      return new Promise<boolean>((resolve) => { release = resolve; });
    },
    threshold: 1,
    onDead: () => {},
  });

  const first = watchdog.tick();
  await watchdog.tick(); // returns immediately: one is already in flight
  assert.equal(started, 1, 'a slow probe must not be re-entered');

  release(true);
  await first;

  const second = watchdog.tick();
  assert.equal(started, 2, 'once settled, the next tick probes again');
  release(true);
  await second;
});

test('shutdown exits after cleanup finishes', async () => {
  const codes: number[] = [];
  let cleaned = false;
  installShutdownHandlers({
    signals: ['SIGUSR2'],
    cleanup: async () => { cleaned = true; },
    exit: (code) => { codes.push(code); },
  });

  process.emit('SIGUSR2');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(cleaned, 'cleanup ran');
  assert.deepEqual(codes, [0]);
  process.removeAllListeners('SIGUSR2');
});

test('shutdown exits even when cleanup never settles', async () => {
  const codes: number[] = [];
  const handle = installShutdownHandlers({
    signals: ['SIGUSR2'],
    graceMs: 10,
    cleanup: () => new Promise<void>(() => {}), // a browser that will not close
    exit: (code) => { codes.push(code); },
  });

  assert.equal(handle.isShuttingDown(), false);
  process.emit('SIGUSR2');
  assert.equal(handle.isShuttingDown(), true, 'the flag flips before cleanup resolves');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(codes, [0], 'the grace timer terminates a hung cleanup');

  // The wedge that made `launchctl kickstart -k` look like a no-op.
  process.emit('SIGUSR2');
  assert.deepEqual(codes, [0, 1], 'a second signal exits immediately');
  process.removeAllListeners('SIGUSR2');
});

test('shutdown exits when cleanup rejects', async () => {
  const codes: number[] = [];
  installShutdownHandlers({
    signals: ['SIGUSR2'],
    cleanup: async () => { throw new Error('browser refused'); },
    exit: (code) => { codes.push(code); },
  });

  process.emit('SIGUSR2');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(codes, [0], 'a failed cleanup is still a clean exit');
  process.removeAllListeners('SIGUSR2');
});

test('an unexpected server close is reported, a deliberate one is not', () => {
  const reported: string[] = [];
  const surprise = createServer();
  watchServerClose(surprise, (reason) => reported.push(reason), () => false);
  surprise.emit('close');
  assert.equal(reported.length, 1);

  const deliberate = createServer();
  watchServerClose(deliberate, (reason) => reported.push(reason), () => true);
  deliberate.emit('close');
  assert.equal(reported.length, 1, 'a requested shutdown is not the wedge');
});

test('the health probe answers true for a live listener and false once it is gone', async () => {
  const server = createServer((_req, res) => { res.statusCode = 200; res.end('{}'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const probe = createHealthProbe({ port, timeoutMs: 2_000 });
  assert.equal(await probe(), true);

  // Exactly the incident: the listener goes away, the process does not.
  server.close();
  await once(server, 'close');
  assert.equal(await probe(), false, 'a refused connection is a failed probe');
});

test('the health probe treats a 5xx as a failure', async () => {
  const server = createServer((_req, res) => { res.statusCode = 503; res.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;

  const probe = createHealthProbe({ port, timeoutMs: 2_000 });
  assert.equal(await probe(), false, 'listening but broken is not healthy');

  server.close();
  await once(server, 'close');
});
