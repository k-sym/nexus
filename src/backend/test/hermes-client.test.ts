import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHermesClient,
  normalizeHermesBaseUrl,
  parseResponsesEvent,
  type HermesFetch,
} from '../hermes/client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
}

function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

test('normalizeHermesBaseUrl accepts root, /v1, and /v1/chat/completions URLs', () => {
  assert.equal(normalizeHermesBaseUrl('http://127.0.0.1:8642'), 'http://127.0.0.1:8642');
  assert.equal(normalizeHermesBaseUrl('http://127.0.0.1:8642/v1'), 'http://127.0.0.1:8642');
  assert.equal(
    normalizeHermesBaseUrl('http://127.0.0.1:8642/v1/chat/completions'),
    'http://127.0.0.1:8642',
  );
  assert.equal(normalizeHermesBaseUrl(' http://127.0.0.1:8642/v1/ '), 'http://127.0.0.1:8642');
});

test('startRun posts to /v1/runs with bearer auth and session correlation', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const fetchImpl: HermesFetch = async (url, init) => {
    requestedUrl = String(url);
    requestedInit = init;
    return jsonResponse({ run_id: 'run-123', status: 'started' });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642/v1', key: 'secret', fetchImpl });
  const run = await client.startRun({
    input: 'Do this overnight',
    sessionId: 'session-1',
    sessionKey: 'nexus:assistant:session-1',
    instructions: 'Be concise.',
  });

  assert.deepEqual(run, { runId: 'run-123', status: 'started' });
  assert.equal(requestedUrl, 'http://127.0.0.1:8642/v1/runs');
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.equal((requestedInit?.headers as Record<string, string>)['X-Hermes-Session-Key'], 'nexus:assistant:session-1');
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    input: 'Do this overnight',
    session_id: 'session-1',
    instructions: 'Be concise.',
  });
});

test('getRun maps Hermes run status output and usage', async () => {
  const fetchImpl: HermesFetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8642/v1/runs/run-123');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    return jsonResponse({
      object: 'hermes.run',
      run_id: 'run-123',
      status: 'completed',
      session_id: 'session-1',
      model: 'hermes-agent',
      output: 'Done.',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  assert.deepEqual(await client.getRun('run-123'), {
    runId: 'run-123',
    status: 'completed',
    sessionId: 'session-1',
    model: 'hermes-agent',
    output: 'Done.',
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
});

test('stopRun posts to the Hermes stop endpoint', async () => {
  let requestedUrl = '';
  let requestedMethod = '';
  const fetchImpl: HermesFetch = async (url, init) => {
    requestedUrl = String(url);
    requestedMethod = init?.method ?? '';
    return jsonResponse({ status: 'stopping' });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  await client.stopRun('run-123');

  assert.equal(requestedUrl, 'http://127.0.0.1:8642/v1/runs/run-123/stop');
  assert.equal(requestedMethod, 'POST');
});

test('sessionChat posts multimodal input to a Hermes persisted session', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const fetchImpl: HermesFetch = async (url, init) => {
    requestedUrl = String(url);
    requestedInit = init;
    return jsonResponse({
      object: 'hermes.session.chat.completion',
      session_id: 'session-1',
      message: { role: 'assistant', content: 'I can see it.' },
      usage: { total_tokens: 11 },
    });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  const result = await client.sessionChat({
    sessionId: 'session-1',
    sessionKey: 'nexus:assistant:session-1',
    input: [
      { type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
    ],
  });

  assert.equal(requestedUrl, 'http://127.0.0.1:8642/api/sessions/session-1/chat');
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, 'Bearer secret');
  assert.equal((requestedInit?.headers as Record<string, string>)['X-Hermes-Session-Key'], 'nexus:assistant:session-1');
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    input: [
      { type: 'text', text: 'Describe this.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } },
    ],
  });
  assert.deepEqual(result, {
    sessionId: 'session-1',
    output: 'I can see it.',
    usage: { total_tokens: 11 },
  });
});

test('createSession and deleteSession call Hermes session control endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: HermesFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init?.method === 'POST') {
      return jsonResponse({ object: 'hermes.session', session: { id: 'session-1' } }, { status: 201 });
    }
    return jsonResponse({ object: 'hermes.session.deleted', id: 'session-1', deleted: true });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  assert.deepEqual(await client.createSession({ sessionId: 'session-1', title: 'Vision' }), { sessionId: 'session-1' });
  await client.deleteSession('session-1');

  assert.equal(calls[0].url, 'http://127.0.0.1:8642/api/sessions');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { id: 'session-1', title: 'Vision' });
  assert.equal(calls[1].url, 'http://127.0.0.1:8642/api/sessions/session-1');
  assert.equal(calls[1].init?.method, 'DELETE');
});

test('streamChatCompletions extracts OpenAI-compatible streamed text deltas', async () => {
  const stream = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const fetchImpl: HermesFetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8642/v1/chat/completions');
    assert.deepEqual(JSON.parse(String(init?.body)).messages, [{ role: 'user', content: 'Hi' }]);
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  const client = createHermesClient({ url: 'http://127.0.0.1:8642/v1/chat/completions', key: 'secret', fetchImpl });
  const deltas: string[] = [];
  for await (const delta of client.streamChatCompletions([{ role: 'user', content: 'Hi' }])) {
    deltas.push(delta);
  }

  assert.deepEqual(deltas, ['Hel', 'lo']);
});

test('streamResponses parses text deltas, function calls, outputs, and completion', async () => {
  let captured: { url: string; body: any } | null = null;
  const fetchImpl: HermesFetch = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) };
    return sseResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","id":"call_1","name":"read_file","arguments":{"path":"/tmp/x"}}}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"call_1","output":"file contents"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1"}}\n\n',
      'data: [DONE]\n\n',
    ]);
  };
  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'secret', fetchImpl });
  const events = await collect(client.streamResponses({ input: 'hi', sessionId: 's1', sessionKey: 'nexus:assistant:s1' }));

  assert.equal(captured!.url, 'http://127.0.0.1:8642/v1/responses');
  assert.equal(captured!.body.stream, true);
  assert.equal(captured!.body.input, 'hi');
  assert.equal(captured!.body.session_id, 's1');
  assert.deepEqual(events, [
    { kind: 'created', responseId: 'resp_1' },
    { kind: 'text_delta', delta: 'Hel' },
    { kind: 'text_delta', delta: 'lo' },
    { kind: 'function_call', id: 'call_1', name: 'read_file', args: { path: '/tmp/x' } },
    { kind: 'function_call_output', callId: 'call_1', output: 'file contents', isError: false },
    { kind: 'completed', responseId: 'resp_1' },
  ]);
});

test('streamResponses maps a failed response to a failed event', async () => {
  const fetchImpl: HermesFetch = async () => sseResponse([
    'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const client = createHermesClient({ url: 'http://127.0.0.1:8642', key: 'k', fetchImpl });
  const events = await collect(client.streamResponses({ input: 'x' }));
  assert.deepEqual(events, [{ kind: 'failed', error: 'boom' }]);
});
