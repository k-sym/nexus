import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionEventStream } from '../pi/events';

test('SessionEventStream pipes through an EventEmitter and supports abort', () => {
  const s = new SessionEventStream();
  const events: string[] = [];
  s.on('data', (e: { type: string }) => events.push(e.type));
  s.emit({ type: 'message_start' });
  s.emit({ type: 'text_delta', text: 'hi' });
  s.abort('user-cancel');
  s.emit({ type: 'message_start' });
  assert.deepEqual(events, ['message_start', 'text_delta']);
  assert.equal(s.abortReason(), 'user-cancel');
});

test('SessionEventStream defaults to not aborted', () => {
  const s = new SessionEventStream();
  assert.equal(s.abortReason(), null);
});
