import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermesMessagesToTranscript } from '../hermes/transcript';
import type { HermesSessionMessage } from '../hermes/client';

// Mirrors the real shape pulled from state.db for the "Baker's Daily Health
// Check" session: an assistant row with OpenAI-shape tool_calls, followed by
// standalone role:'tool' rows whose tool_call_id matches the call id.
const messages: HermesSessionMessage[] = [
  { id: 'm1', role: 'user', content: 'Morning Baker. Time for your health check.', created_at: '2026-07-17T08:59:00.000Z' },
  {
    id: 'm2',
    role: 'assistant',
    content: 'Morning Keith! Let me run the full sweep.',
    created_at: '2026-07-17T08:59:05.000Z',
    tool_calls: [
      { id: 'toolu_a', type: 'function', function: { name: 'terminal', arguments: '{"command":"uptime"}' } },
      { id: 'toolu_b', type: 'function', function: { name: 'cronjob', arguments: '{"action":"list"}' } },
    ],
  },
  { id: 'm3', role: 'tool', tool_call_id: 'toolu_a', tool_name: 'terminal', content: '=== SYSTEM ===\nload 3.40 2.36 1.98' },
  { id: 'm4', role: 'tool', tool_call_id: 'toolu_b', tool_name: 'cronjob', content: '{"success":true,"count":5}' },
  {
    id: 'm5',
    role: 'assistant',
    content: 'Three jobs errored this morning. Let me pull the logs.',
    created_at: '2026-07-17T08:59:40.000Z',
    tool_calls: [
      { id: 'toolu_c', type: 'function', function: { name: 'cronjob', arguments: '{"action":"run"}' } },
    ],
  },
  { id: 'm6', role: 'tool', tool_call_id: 'toolu_c', tool_name: 'cronjob', content: 'job output' },
];

test('hermesMessagesToTranscript folds tool output into the owning assistant message', () => {
  const out = hermesMessagesToTranscript(messages);

  // Only user + assistant messages survive — no standalone raw-output rows.
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.ok(!out.some((m) => m.content.includes('=== SYSTEM ===')), 'tool output never leaks into a message body');

  const first = out[1];
  assert.equal(first.content, 'Morning Keith! Let me run the full sweep.');
  assert.equal(first.tool_calls?.length, 2);

  const [terminal, cronjob] = first.tool_calls!;
  assert.equal(terminal.name, 'terminal');
  assert.deepEqual(terminal.args, { command: 'uptime' });      // arguments JSON string → object
  assert.equal(terminal.status, 'succeeded');                   // paired with its tool result
  assert.equal(terminal.result, '=== SYSTEM ===\nload 3.40 2.36 1.98');
  assert.equal(cronjob.name, 'cronjob');
  assert.equal(cronjob.result, '{"success":true,"count":5}');

  const second = out[2];
  assert.equal(second.tool_calls?.[0].name, 'cronjob');
  assert.equal(second.tool_calls?.[0].result, 'job output');
});

test('hermesMessagesToTranscript marks an unpaired tool call as interrupted (mid-run capture)', () => {
  const midRun: HermesSessionMessage[] = [
    { id: 'u', role: 'user', content: 'go' },
    {
      id: 'a',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'toolu_x', type: 'function', function: { name: 'terminal', arguments: '{"command":"sleep 9"}' } }],
    },
    // No tool row yet — the tool hasn't returned.
  ];
  const out = hermesMessagesToTranscript(midRun);
  assert.equal(out[1].tool_calls?.[0].status, 'interrupted');
  assert.equal(out[1].tool_calls?.[0].result, undefined);
});

test('hermesMessagesToTranscript tolerates flat name/arguments and skips malformed calls', () => {
  const flat: HermesSessionMessage[] = [
    {
      id: 'a',
      role: 'assistant',
      content: 'hi',
      // Provider variant: name/arguments on the object instead of nested under function.
      tool_calls: [
        { id: 'toolu_flat', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function', function: { name: 'nameless' } } as any, // no id → dropped
      ],
    },
    { id: 't', role: 'tool', tool_call_id: 'toolu_flat', tool_name: 'search', content: 'result' },
  ];
  const out = hermesMessagesToTranscript(flat);
  assert.equal(out[0].tool_calls?.length, 1);
  assert.equal(out[0].tool_calls?.[0].name, 'search');
  assert.deepEqual(out[0].tool_calls?.[0].args, { q: 'x' });
  assert.equal(out[0].tool_calls?.[0].result, 'result');
});
