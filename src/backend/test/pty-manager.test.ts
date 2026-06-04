import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PtyManager, type PtyLike } from '../pty/manager';

function fakePty() {
  const calls = { writes: [] as string[], resizes: [] as [number, number][], killed: false };
  let dataCb: ((d: string) => void) | null = null;
  let exitCb: (() => void) | null = null;
  const pty: PtyLike = {
    onData: cb => { dataCb = cb; },
    onExit: cb => { exitCb = cb; },
    write: d => { calls.writes.push(d); },
    resize: (c, r) => { calls.resizes.push([c, r]); },
    kill: () => { calls.killed = true; exitCb?.(); },
  };
  return { pty, calls, emit: (d: string) => dataCb?.(d) };
}

test('creating a session writes the launch command and spawns once', () => {
  const f = fakePty();
  let spawned = 0;
  const mgr = new PtyManager({ spawn: () => { spawned++; return f.pty; }, now: () => 1000 });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: 'claude' });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: 'claude' }); // second attach reuses
  assert.equal(spawned, 1, 'spawns one PTY per threadId');
  assert.ok(f.calls.writes.includes('claude'), 'pre-types the launch command');
});

test('a newly attached client receives the scrollback snapshot', () => {
  const f = fakePty();
  const mgr = new PtyManager({ spawn: () => f.pty });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  f.emit('hello world');
  const received: string[] = [];
  mgr.attach('t1', d => received.push(d));
  assert.ok(received.join('').includes('hello world'), 'replays scrollback to new client');
});

test('input and resize reach the PTY', () => {
  const f = fakePty();
  const mgr = new PtyManager({ spawn: () => f.pty });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  mgr.input('t1', 'ls\r');
  mgr.resize('t1', 120, 40);
  assert.ok(f.calls.writes.includes('ls\r'));
  assert.deepEqual(f.calls.resizes.at(-1), [120, 40]);
});

test('close kills the PTY and forgets the session', () => {
  const f = fakePty();
  let spawned = 0;
  const mgr = new PtyManager({ spawn: () => { spawned++; return f.pty; } });
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  mgr.close('t1');
  assert.ok(f.calls.killed, 'kills the PTY');
  mgr.open('t1', { cwd: '/repo', cols: 80, rows: 24, launchCommand: '' });
  assert.equal(spawned, 2, 'a fresh PTY spawns after close');
});
