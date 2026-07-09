import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuestionBroker,
  createQuestionExtension,
  formatQuestionResult,
  normalizeQuestionRequest,
  validateQuestionAnswers,
  type QuestionRequest,
} from '../pi/questions';

const validInput = {
  questions: [{
    id: ' scope ',
    header: ' Scope ',
    question: ' Which scope? ',
    options: [
      { value: ' small ', label: ' Small ', description: ' Minimal change ' },
      { value: 'full', label: 'Full', description: 'Complete change' },
    ],
  }],
};

function validRequest(): QuestionRequest {
  const result = normalizeQuestionRequest(validInput);
  assert.equal(result.ok, true);
  return result.value;
}

test('question contract normalizes a valid request and applies defaults', () => {
  const result = normalizeQuestionRequest(validInput);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, {
    questions: [{
      id: 'scope',
      header: 'Scope',
      question: 'Which scope?',
      options: [
        { value: 'small', label: 'Small', description: 'Minimal change' },
        { value: 'full', label: 'Full', description: 'Complete change' },
      ],
      multiple: false,
      allowOther: true,
    }],
  });
});

test('question contract rejects malformed and ambiguous requests', () => {
  const cases = [
    { name: 'empty questions', value: { questions: [] } },
    { name: 'duplicate question IDs', value: { questions: [validInput.questions[0], validInput.questions[0]] } },
    { name: 'duplicate option values', value: { questions: [{ ...validInput.questions[0], options: [
      { value: 'same', label: 'One' }, { value: ' same ', label: 'Two' },
    ] }] } },
    { name: 'fewer than two options', value: { questions: [{ ...validInput.questions[0], options: [{ value: 'one', label: 'One' }] }] } },
    { name: 'empty ID', value: { questions: [{ ...validInput.questions[0], id: ' ' }] } },
    { name: 'empty label', value: { questions: [{ ...validInput.questions[0], options: [
      { value: 'one', label: ' ' }, { value: 'two', label: 'Two' },
    ] }] } },
  ];

  for (const item of cases) {
    const result = normalizeQuestionRequest(item.value);
    assert.equal(result.ok, false, item.name);
  }
});

test('question contract validates single, multiple, and custom answers', () => {
  const request = validRequest();
  const single = validateQuestionAnswers(request, { answers: [
    { questionId: 'scope', selected: ['small'] },
  ] });
  assert.deepEqual(single, { ok: true, value: { answers: [
    { questionId: 'scope', selected: ['small'] },
  ] } });

  const multipleRequestResult = normalizeQuestionRequest({ questions: [{
    ...validInput.questions[0], multiple: true,
  }] });
  assert.equal(multipleRequestResult.ok, true);
  const multiple = validateQuestionAnswers(multipleRequestResult.value, { answers: [
    { questionId: 'scope', selected: ['small', 'full'], custom: '  Add docs  ' },
  ] });
  assert.deepEqual(multiple, { ok: true, value: { answers: [
    { questionId: 'scope', selected: ['small', 'full'], custom: 'Add docs' },
  ] } });

  const custom = validateQuestionAnswers(request, { answers: [
    { questionId: 'scope', selected: [], custom: ' A different scope ' },
  ] });
  assert.deepEqual(custom, { ok: true, value: { answers: [
    { questionId: 'scope', selected: [], custom: 'A different scope' },
  ] } });
});

test('question contract rejects invalid answer submissions', () => {
  const request = validRequest();
  const cases = [
    { name: 'unknown selection', value: { answers: [{ questionId: 'scope', selected: ['other'] }] } },
    { name: 'multiple single-select values', value: { answers: [{ questionId: 'scope', selected: ['small', 'full'] }] } },
    { name: 'unanswered question', value: { answers: [{ questionId: 'scope', selected: [] }] } },
    { name: 'missing answer', value: { answers: [] } },
    { name: 'extra answer', value: { answers: [
      { questionId: 'scope', selected: ['small'] }, { questionId: 'extra', selected: ['x'] },
    ] } },
  ];

  for (const item of cases) {
    const result = validateQuestionAnswers(request, item.value);
    assert.equal(result.ok, false, item.name);
  }

  const noOtherResult = normalizeQuestionRequest({ questions: [{
    ...validInput.questions[0], allowOther: false,
  }] });
  assert.equal(noOtherResult.ok, true);
  assert.equal(validateQuestionAnswers(noOtherResult.value, { answers: [
    { questionId: 'scope', selected: [], custom: 'Custom' },
  ] }).ok, false);
});

test('question broker remains pending until a valid answer resolves it', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  let settled = false;
  const pending = broker.register('thread-1', 'call-1', request).then((result) => {
    settled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  assert.deepEqual(broker.answer('thread-2', 'call-1', { answers: [{ questionId: 'scope', selected: ['small'] }] }), {
    ok: false, status: 404, error: 'Question not found',
  });
  assert.deepEqual(broker.answer('thread-1', 'unknown', { answers: [{ questionId: 'scope', selected: ['small'] }] }), {
    ok: false, status: 404, error: 'Question not found',
  });
  assert.equal(broker.answer('thread-1', 'call-1', { answers: [{ questionId: 'scope', selected: ['unknown'] }] }).status, 400);
  await Promise.resolve();
  assert.equal(settled, false, 'invalid answer leaves the question pending');

  assert.deepEqual(broker.answer('thread-1', 'call-1', { answers: [{ questionId: 'scope', selected: ['small'] }] }), { ok: true });
  assert.deepEqual(await pending, {
    status: 'answered', toolCallId: 'call-1', answers: [{ questionId: 'scope', selected: ['small'] }],
  });
  assert.equal(broker.answer('thread-1', 'call-1', { answers: [{ questionId: 'scope', selected: ['full'] }] }).status, 404);
});

test('question broker pushes pending then resolved to subscribers', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  const events: any[] = [];
  const unsub = broker.subscribe((e) => events.push(e));

  const pending = broker.register('thread-1', 'call-1', request);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'pending');
  assert.equal(events[0].view.threadId, 'thread-1');
  assert.equal(events[0].view.toolCallId, 'call-1');
  assert.deepEqual(events[0].view.request, request);

  assert.deepEqual(broker.answer('thread-1', 'call-1', { answers: [{ questionId: 'scope', selected: ['small'] }] }), { ok: true });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { type: 'resolved', threadId: 'thread-1', toolCallId: 'call-1' });
  await pending;

  unsub();
  const other = broker.register('thread-1', 'call-2', request);
  assert.equal(events.length, 2, 'no events after unsubscribe');
  broker.cancelThread('thread-1', 'cleanup');
  await other;
});

test('question broker emits resolved on deny, cancelThread and abort', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  const resolved: string[] = [];
  broker.subscribe((e) => { if (e.type === 'resolved') resolved.push(e.toolCallId); });

  const p1 = broker.register('t', 'a', request);
  assert.equal(broker.cancel('t', 'a', 'denied'), true);
  await p1;

  const p2 = broker.register('t', 'b', request);
  broker.cancelThread('t', 'dropped');
  await p2;

  const controller = new AbortController();
  const p3 = broker.register('t', 'c', request, controller.signal);
  controller.abort('client gone');
  await p3;

  assert.deepEqual([...resolved].sort(), ['a', 'b', 'c']);
});

test('question broker isolates a throwing subscriber from resolution', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  broker.subscribe(() => { throw new Error('boom'); });
  const pending = broker.register('t', 'call-1', request);
  // A subscriber that throws must not prevent the question from resolving.
  assert.deepEqual(broker.answer('t', 'call-1', { answers: [{ questionId: 'scope', selected: ['small'] }] }), { ok: true });
  assert.equal((await pending).status, 'answered');
});

test('question broker rejects duplicate registration', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  const first = broker.register('thread-1', 'call-1', request);
  await assert.rejects(broker.register('thread-1', 'call-1', request), /already pending/i);
  broker.cancelThread('thread-1', 'test cleanup');
  await first;
});

test('question broker cancelThread resolves and removes all thread entries', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  const first = broker.register('thread-1', 'call-1', request);
  const second = broker.register('thread-1', 'call-2', request);
  const other = broker.register('thread-2', 'call-1', request);

  broker.cancelThread('thread-1', 'Run aborted');
  assert.deepEqual(await first, { status: 'cancelled', toolCallId: 'call-1', error: 'Run aborted' });
  assert.deepEqual(await second, { status: 'cancelled', toolCallId: 'call-2', error: 'Run aborted' });
  assert.equal(broker.answer('thread-1', 'call-1', { answers: [{ questionId: 'scope', selected: ['small'] }] }).status, 404);

  broker.cancelThread('thread-2', 'cleanup');
  await other;
});

test('question broker reports pending question counts by thread', async () => {
  const broker = new QuestionBroker();
  const request = validRequest();
  const one = broker.register('thread-1', 'call-1', request);
  const two = broker.register('thread-1', 'call-2', request);
  const other = broker.register('thread-2', 'call-3', request);

  assert.equal(broker.pendingCount('thread-1'), 2);
  assert.equal(broker.hasPending('thread-1'), true);
  assert.equal(broker.pendingCount('missing'), 0);
  assert.equal(broker.hasPending('missing'), false);

  broker.cancelThread('thread-1', 'done');
  assert.equal((await one).status, 'cancelled');
  assert.equal((await two).status, 'cancelled');
  assert.equal(broker.pendingCount('thread-1'), 0);
  broker.cancelThread('thread-2', 'cleanup');
  await other;
});

test('question broker abort signals cancel registration and format results deterministically', async () => {
  const broker = new QuestionBroker();
  const controller = new AbortController();
  const pending = broker.register('thread-1', 'call-1', validRequest(), controller.signal);
  controller.abort('Client disconnected');
  const result = await pending;
  assert.deepEqual(result, { status: 'cancelled', toolCallId: 'call-1', error: 'Client disconnected' });

  assert.equal(formatQuestionResult({
    status: 'answered', toolCallId: 'call-2', answers: [{ questionId: 'scope', selected: ['small'] }],
  }, validRequest()), 'Scope: Small\n\n{"toolCallId":"call-2","answers":[{"questionId":"scope","selected":["small"]}]}');
});

test('question extension registers a structured tool and waits for its broker answer', async () => {
  const broker = new QuestionBroker();
  let tool: any;
  createQuestionExtension('thread-1', broker)({
    registerTool(value: unknown) { tool = value; },
  } as any);

  assert.equal(tool.name, 'question');
  assert.ok(tool.description.length > 0);
  assert.equal(tool.parameters.type, 'object');

  let settled = false;
  const pending = tool.execute('call-1', validInput, undefined, undefined, {}).then((value: unknown) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);

  assert.deepEqual(broker.answer('thread-1', 'call-1', {
    answers: [{ questionId: 'scope', selected: ['small'] }],
  }), { ok: true });
  assert.deepEqual(await pending, {
    content: [{
      type: 'text',
      text: 'Scope: Small\n\n{"toolCallId":"call-1","answers":[{"questionId":"scope","selected":["small"]}]}',
    }],
    details: {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [{ questionId: 'scope', selected: ['small'] }],
    },
  });
});

test('question extension reports invalid arguments as a tool error', async () => {
  const broker = new QuestionBroker();
  let tool: any;
  createQuestionExtension('thread-1', broker)({
    registerTool(value: unknown) { tool = value; },
  } as any);

  const result = await tool.execute('call-1', { questions: [] }, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /questions must be a non-empty array/);
});

test('question extension reports broker cancellation as a tool error', async () => {
  const broker = new QuestionBroker();
  let tool: any;
  createQuestionExtension('thread-1', broker)({
    registerTool(value: unknown) { tool = value; },
  } as any);

  const pending = tool.execute('call-1', validInput, undefined, undefined, {});
  await Promise.resolve();
  broker.cancelThread('thread-1', 'Client disconnected');

  const result = await pending;
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    status: 'cancelled',
    toolCallId: 'call-1',
    error: 'Client disconnected',
  });
});
