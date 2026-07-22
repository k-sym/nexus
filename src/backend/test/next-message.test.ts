import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CONTEXT_CHARS,
  MAX_TURNS,
  MAX_TURN_CHARS,
  parseTranscript,
  renderTranscript,
  suggestNextMessage,
} from '../sessions/next-message';

const turns = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', text: `m${i}` }));

test('parseTranscript rejects anything that is not an array of turns', () => {
  assert.equal(parseTranscript(undefined), null);
  assert.equal(parseTranscript('nope'), null);
  assert.equal(parseTranscript({}), null);
  assert.equal(parseTranscript([{ role: 'system', text: 'x' }]), null);
  assert.equal(parseTranscript([{ role: 'user' }]), null);
});

test('parseTranscript accepts a well-formed transcript', () => {
  assert.deepEqual(parseTranscript([{ role: 'user', text: 'hi' }]), [{ role: 'user', text: 'hi' }]);
});

test('parseTranscript keeps only the last MAX_TURNS turns', () => {
  const parsed = parseTranscript(turns(MAX_TURNS + 5));
  assert.equal(parsed?.length, MAX_TURNS);
  assert.equal(parsed?.[parsed.length - 1].text, `m${MAX_TURNS + 4}`);
});

test('parseTranscript caps each turn at MAX_TURN_CHARS', () => {
  const parsed = parseTranscript([{ role: 'user', text: 'x'.repeat(MAX_TURN_CHARS + 500) }]);
  assert.equal(parsed?.[0].text.length, MAX_TURN_CHARS);
});

test('renderTranscript labels turns and caps total context', () => {
  assert.equal(
    renderTranscript([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }]),
    'User: hi\n\nAssistant: hello',
  );
  const long = renderTranscript(
    Array.from({ length: MAX_TURNS }, () => ({ role: 'user' as const, text: 'x'.repeat(MAX_TURN_CHARS) })),
  );
  assert.ok(long.length <= MAX_CONTEXT_CHARS);
});

test('renderTranscript keeps the most recent turns when it has to truncate', () => {
  const rendered = renderTranscript([
    { role: 'user', text: 'x'.repeat(MAX_CONTEXT_CHARS) },
    { role: 'assistant', text: 'the newest thing' },
  ]);
  assert.ok(rendered.endsWith('the newest thing'));
});

test('suggestNextMessage skips the model when there is no assistant turn', async () => {
  let called = false;
  const suggestion = await suggestNextMessage([{ role: 'user', text: 'hi' }], {
    generate: async () => { called = true; return 'run the tests'; },
  });
  assert.equal(suggestion, '');
  assert.equal(called, false);
});

test('suggestNextMessage returns the generated suggestion', async () => {
  const suggestion = await suggestNextMessage(
    [{ role: 'user', text: 'add a test' }, { role: 'assistant', text: 'done' }],
    { generate: async () => 'run the tests' },
  );
  assert.equal(suggestion, 'run the tests');
});

test('suggestNextMessage swallows a generator failure', async () => {
  const suggestion = await suggestNextMessage(
    [{ role: 'user', text: 'add a test' }, { role: 'assistant', text: 'done' }],
    { generate: async () => { throw new Error('daemon unreachable'); } },
  );
  assert.equal(suggestion, '');
});
