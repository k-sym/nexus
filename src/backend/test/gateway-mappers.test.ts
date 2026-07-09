import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toMs,
  messagesToTranscriptEvents,
  questionToApproval,
  translateGlassesAnswer,
} from '../gateway/mappers';
import type { QuestionRequest, PendingQuestionView } from '../pi/questions';

test('toMs coerces ISO strings and epoch ms, rejects junk', () => {
  assert.equal(toMs(1720000000000), 1720000000000);
  assert.equal(toMs('2026-07-08T00:00:00.000Z'), Date.parse('2026-07-08T00:00:00.000Z'));
  assert.equal(toMs('not a date'), undefined);
  assert.equal(toMs(undefined), undefined);
  assert.equal(toMs(NaN), undefined);
});

test('messagesToTranscriptEvents expands assistant text + tool calls, skips toolResult', () => {
  const messages = [
    { role: 'user', content: 'hi', timestamp: '2026-07-08T00:00:00.000Z' },
    {
      role: 'assistant',
      content: 'on it',
      tool_calls: [{ id: 't1', name: 'bash', args: { command: 'ls' } }],
      timestamp: 1720000000000,
    },
    { role: 'toolResult', toolCallId: 't1', content: 'file.txt', timestamp: 1720000000001 },
  ];
  const events = messagesToTranscriptEvents(messages);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['user', 'assistant_text', 'tool_use'],
  );
  assert.equal(events[0].text, 'hi');
  assert.equal(events[1].text, 'on it');
  assert.equal(events[2].name, 'bash');
  assert.deepEqual(events[2].input, { command: 'ls' });
});

test('messagesToTranscriptEvents omits empty assistant text and keeps last N', () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: i }));
  const events = messagesToTranscriptEvents(many, 40);
  assert.equal(events.length, 40);
  assert.equal(events[0].text, 'm10');
  assert.equal(events.at(-1)!.text, 'm49');

  const noText = messagesToTranscriptEvents([
    { role: 'assistant', content: '   ', tool_calls: [{ name: 'read', args: { path: 'a' } }] },
  ]);
  assert.deepEqual(noText.map((e) => e.kind), ['tool_use']);
});

const request: QuestionRequest = {
  questions: [
    {
      id: 'q1',
      header: 'Deploy?',
      question: 'Ship to prod now?',
      options: [
        { value: 'yes', label: 'Yes', description: 'ship it' },
        { value: 'no', label: 'No' },
      ],
      multiple: false,
      allowOther: true,
    },
  ],
};

test('questionToApproval maps to the glasses AskUserQuestion shape', () => {
  const view: PendingQuestionView = { threadId: 'thread-1', toolCallId: 'call-1', request, requestedAt: 42 };
  const approval = questionToApproval(view, '/repo');
  assert.equal(approval.id, 'call-1');
  assert.equal(approval.kind, 'question');
  assert.equal(approval.session_id, 'thread-1');
  assert.equal(approval.tool_name, 'AskUserQuestion');
  assert.equal(approval.cwd, '/repo');
  assert.equal(approval.createdAt, 42);
  const input = approval.tool_input as { questions: Array<{ question: string; multiSelect: boolean; options: Array<{ label: string }> }> };
  assert.equal(input.questions[0].question, 'Ship to prod now?');
  assert.equal(input.questions[0].multiSelect, false);
  assert.deepEqual(input.questions[0].options.map((o) => o.label), ['Yes', 'No']);
});

test('translateGlassesAnswer maps option label → value, keyed by question text', () => {
  const out = translateGlassesAnswer(request, { 'Ship to prod now?': 'No' });
  assert.deepEqual(out.answers, [{ questionId: 'q1', selected: ['no'] }]);
});

test('translateGlassesAnswer falls back to header key and lone value', () => {
  assert.deepEqual(translateGlassesAnswer(request, { 'Deploy?': 'Yes' }).answers, [
    { questionId: 'q1', selected: ['yes'] },
  ]);
  // single-question prompt, value not keyed by text/header
  assert.deepEqual(translateGlassesAnswer(request, { anything: 'Yes' }).answers, [
    { questionId: 'q1', selected: ['yes'] },
  ]);
});

test('translateGlassesAnswer routes unknown labels to custom when allowOther', () => {
  const out = translateGlassesAnswer(request, { 'Ship to prod now?': 'maybe later' });
  assert.deepEqual(out.answers, [{ questionId: 'q1', selected: [], custom: 'maybe later' }]);
});
