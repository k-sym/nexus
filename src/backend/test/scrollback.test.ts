import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollbackBuffer } from '../pty/scrollback';

test('accumulates appended chunks in order', () => {
  const b = new ScrollbackBuffer(1000);
  b.append('foo'); b.append('bar');
  assert.equal(b.snapshot(), 'foobar');
});

test('trims oldest chunks when exceeding the byte cap', () => {
  const b = new ScrollbackBuffer(5); // tiny cap
  b.append('aaa'); b.append('bbb'); b.append('ccc');
  // oldest chunks dropped until under cap; newest always retained
  const snap = b.snapshot();
  assert.ok(snap.endsWith('ccc'), 'keeps newest chunk');
  assert.ok(snap.length <= 6, `trimmed near cap, got ${snap.length}`);
});
