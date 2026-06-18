import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG } from '../signal-filters/config';
import { registerSignalFilterHandlers } from '../signal-filters/extension';
import { projectToolResultMessages } from '../signal-filters/messages';

const resolved = {
  ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
  min_input_bytes: 1,
};

function conversation(raw: string) {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      content: [
        { type: 'text', text: raw },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
      ],
    },
  ] as any[];
}

test('projectToolResultMessages filters copies and recovers the command', () => {
  const raw = `${'✓ passes case\n'.repeat(500)}Tests: 500 passed\n`;
  const messages = conversation(raw);
  const image = messages[1].content[1];
  const projected = projectToolResultMessages(messages as any, '/tmp/repo', resolved);

  assert.equal(messages[1].content[0].text, raw);
  assert.ok((projected.messages[1] as any).content[0].text.length < raw.length);
  assert.strictEqual((projected.messages[1] as any).content[1], image);
  assert.strictEqual(projected.messages[0], messages[0]);
  assert.equal(projected.resultsByToolCallId.get('call-1')?.context.command, 'npm test');
  assert.equal(projected.resultsByToolCallId.get('call-1')?.rawText, raw);
});

test('projectToolResultMessages fails open when a filter throws', () => {
  const raw = 'raw output';
  const messages = conversation(raw);
  const projected = projectToolResultMessages(messages as any, '/tmp/repo', resolved, {
    filter: () => { throw new Error('broken filter'); },
  });

  assert.equal((projected.messages[1] as any).content[0].text, raw);
  assert.equal(projected.resultsByToolCallId.get('call-1')?.stats.inputBytes, Buffer.byteLength(raw));
  assert.equal(projected.resultsByToolCallId.get('call-1')?.stats.outputBytes, Buffer.byteLength(raw));
  assert.deepEqual(projected.resultsByToolCallId.get('call-1')?.appliedFilters, []);
});

test('extension projects provider context without mutating the source', async () => {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
  registerSignalFilterHandlers(pi, '/tmp/repo', () => ({ signal_filters: { ...resolved, projects: {} } } as any));
  const raw = `${'PASS noisy\n'.repeat(300)}Tests: 300 passed`;
  const messages = conversation(raw);

  const response = await handlers.get('context')?.({ messages }, {});
  assert.equal(messages[1].content[0].text, raw);
  assert.ok(response.messages[1].content[0].text.length < raw.length);
});

test('extension projects compaction arrays without mutating branch entries', async () => {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
  registerSignalFilterHandlers(pi, '/tmp/repo', () => ({ signal_filters: { ...resolved, projects: {} } } as any));
  const raw = `${'PASS noisy\n'.repeat(300)}Tests: 300 passed`;
  const messages = conversation(raw);
  const prefix = conversation(raw);
  const branchEntries = [{ type: 'message', message: messages[1] }];
  const event = {
    preparation: { messagesToSummarize: messages, turnPrefixMessages: prefix },
    branchEntries,
  } as any;

  await handlers.get('session_before_compact')?.(event, {});
  assert.ok(event.preparation.messagesToSummarize[1].content[0].text.length < raw.length);
  assert.ok(event.preparation.turnPrefixMessages[1].content[0].text.length < raw.length);
  assert.equal(messages[1].content[0].text, raw);
  assert.equal(branchEntries[0].message.content[0].text, raw);
});

test('extension fails open when config loading throws', async () => {
  const handlers = new Map<string, Function>();
  const pi = { on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
  registerSignalFilterHandlers(pi, '/tmp/repo', () => { throw new Error('config unavailable'); });
  const messages = conversation('raw');
  const context = await handlers.get('context')?.({ messages }, {});
  assert.strictEqual(context.messages, messages);

  const preparation = { messagesToSummarize: messages, turnPrefixMessages: messages };
  await handlers.get('session_before_compact')?.({ preparation, branchEntries: [] }, {});
  assert.strictEqual(preparation.messagesToSummarize, messages);
  assert.strictEqual(preparation.turnPrefixMessages, messages);
});
