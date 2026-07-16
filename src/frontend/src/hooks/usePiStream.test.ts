import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ChatBusyError, INITIAL_STATE, streamReducer, usePiStream } from './usePiStream';

describe('streamReducer', () => {
  it('START_STREAM seeds a user + empty assistant bubble', () => {
    const next = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'hi' });
    expect(next.isRunning).toBe(true);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe('user');
    expect(next.streamingMessage?.role).toBe('assistant');
    expect(next.streamingMessage?.isStreaming).toBe(true);
  });

  it('START_STREAM stores image attachments on the optimistic user message', () => {
    const attachments = [
      {
        type: 'image' as const,
        data: 'data:image/png;base64,abc',
        mimeType: 'image/png',
        name: 'sketch.png',
        size: 123,
      },
    ];
    const next = streamReducer(INITIAL_STATE, {
      type: 'START_STREAM',
      prompt: 'describe this',
      attachments,
    });

    expect(next.messages[0].attachments).toEqual(attachments);
  });

  it('TEXT_DELTA appends to the streaming message', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const next = streamReducer(start, { type: 'TEXT_DELTA', delta: 'hello' });
    expect(next.streamingMessage?.content).toBe('hello');
    expect(next.status).toBe('responding');
  });

  it('THINKING_DELTA appends to thinking', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const next = streamReducer(start, { type: 'THINKING_DELTA', delta: 'hmm' });
    expect(next.streamingMessage?.thinking).toBe('hmm');
    expect(next.status).toBe('thinking');
  });

  it('TOOL_CALL_START adds a tool call to the streaming message', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const next = streamReducer(start, {
      type: 'TOOL_CALL_START',
      toolCall: { id: 't1', name: 'read', args: { path: '/x' } },
    });
    expect(next.streamingMessage?.toolCalls).toHaveLength(1);
    expect(next.streamingMessage?.toolCalls?.[0].name).toBe('read');
    expect(next.status).toBe('tool_call');
  });

  it('separates prose resumed after a tool call into a new paragraph', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const beforeTool = streamReducer(start, { type: 'TEXT_DELTA', delta: 'I will inspect it.' });
    const tool = streamReducer(beforeTool, {
      type: 'TOOL_CALL_START',
      toolCall: { id: 't1', name: 'read', args: { path: '/x' } },
    });
    const afterTool = streamReducer(tool, { type: 'TEXT_DELTA', delta: 'Now I will fix it.' });

    expect(afterTool.streamingMessage?.content).toBe('I will inspect it.\n\nNow I will fix it.');
  });

  it('does not duplicate a model-provided newline after a tool call', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const beforeTool = streamReducer(start, { type: 'TEXT_DELTA', delta: 'Inspecting.' });
    const tool = streamReducer(beforeTool, {
      type: 'TOOL_CALL_START',
      toolCall: { id: 't1', name: 'read', args: {} },
    });
    const afterTool = streamReducer(tool, { type: 'TEXT_DELTA', delta: '\n\nFixed.' });

    expect(afterTool.streamingMessage?.content).toBe('Inspecting.\n\nFixed.');
  });

  it('preserves question arguments and completed result details', () => {
    const args = { questions: [{ id: 'scope', question: 'Which scope?' }] };
    const details = {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [{ questionId: 'scope', selected: ['small'] }],
    };
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const called = streamReducer(start, {
      type: 'TOOL_CALL_START',
      toolCall: { id: 'call-1', name: 'question', args },
    });
    const completed = streamReducer(called, {
      type: 'TOOL_CALL_UPDATE',
      id: 'call-1',
      patch: { status: 'completed', result: 'Scope: Small', details },
    });

    expect(completed.streamingMessage?.toolCalls?.[0]).toMatchObject({
      args,
      status: 'completed',
      result: 'Scope: Small',
      details,
    });
  });

  it('STREAM_COMPLETE finalizes the message', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const delta = streamReducer(start, { type: 'TEXT_DELTA', delta: 'hi' });
    const done = streamReducer(delta, { type: 'STREAM_COMPLETE' });
    expect(done.isRunning).toBe(false);
    expect(done.messages).toHaveLength(2);
    expect(done.streamingMessage).toBeNull();
  });

  it('STREAM_ERROR sets error and stops', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const err = streamReducer(start, { type: 'STREAM_ERROR', error: 'boom' });
    expect(err.isRunning).toBe(false);
    expect(err.status).toBe('error');
    expect(err.error).toBe('boom');
  });

  it('CONTEXT_USAGE stores the latest context window saturation', () => {
    const next = streamReducer(INITIAL_STATE, {
      type: 'CONTEXT_USAGE',
      usage: { tokens: 170_000, contextWindow: 200_000, percent: 85 },
    });

    expect(next.contextUsage).toEqual({ tokens: 170_000, contextWindow: 200_000, percent: 85 });
  });

  it('ABORT_STREAM preserves any partial content', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const delta = streamReducer(start, { type: 'TEXT_DELTA', delta: 'partial' });
    const abort = streamReducer(delta, { type: 'ABORT_STREAM' });
    expect(abort.isRunning).toBe(false);
    expect(abort.messages).toHaveLength(2);
    expect(abort.messages[1].content).toBe('partial');
  });

  it('ABORT_STREAM preserves a started run before content arrives', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const withRun = streamReducer(start, {
      type: 'RUN_ACTION',
      action: {
        type: 'RUN_STARTED',
        run: {
          runId: 'run-1',
          threadId: 'thread-1',
          startedAt: '2026-06-22T10:00:00.000Z',
        },
      },
    });
    const abort = streamReducer(withRun, { type: 'ABORT_STREAM', source: 'user' });

    expect(abort.isRunning).toBe(false);
    expect(abort.messages).toHaveLength(2);
    expect(abort.messages[1].run).toMatchObject({
      runId: 'run-1',
      status: 'cancelled',
      abortSource: 'user',
    });
  });

  it('RESET clears to initial', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const reset = streamReducer(start, { type: 'RESET' });
    expect(reset).toEqual(INITIAL_STATE);
  });
});

describe('usePiStream', () => {
  it('reduces run boundaries and tool events into a terminal run', async () => {
    const encoder = new TextEncoder();
    const events = [
      { kind: 'run_start', run: { runId: 'run-1', threadId: 'thread-1', startedAt: '2026-06-22T10:00:00.000Z', provider: 'test', model: 'model' } },
      { type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'npm test' } } } },
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'Bash', args: { command: 'npm test' } },
      { type: 'tool_execution_update', toolCallId: 'call-1', partialResult: { content: [{ type: 'text', text: 'running' }] } },
      { type: 'tool_execution_end', toolCallId: 'call-1', isError: false, result: { content: [{ type: 'text', text: 'passed' }] } },
      { kind: 'run_end', run: { runId: 'run-1', threadId: 'thread-1', completedAt: '2026-06-22T10:00:10.000Z', status: 'completed' } },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          controller.close();
        },
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'run tests');
    });

    expect(result.current.state.messages[1].run).toMatchObject({
      runId: 'run-1',
      status: 'completed',
      provider: 'test',
      model: 'model',
    });
    expect(result.current.state.messages[1].run?.tools[0]).toMatchObject({
      id: 'call-1',
      status: 'succeeded',
      result: 'passed',
    });
  });

  it('marks a started run interrupted when the stream closes without run_end', async () => {
    const encoder = new TextEncoder();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'run_start', run: { runId: 'run-1', threadId: 'thread-1', startedAt: '2026-06-22T10:00:00.000Z' } })}\n`));
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'Write', args: {} })}\n`));
          controller.close();
        },
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'write');
    });

    expect(result.current.state.messages[1].run?.status).toBe('interrupted');
    expect(result.current.state.messages[1].run?.tools[0].status).toBe('interrupted');
  });

  it('treats a mid-stream transport drop as a soft interruption, not a hard error', async () => {
    const encoder = new TextEncoder();
    const onError = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(streamController) {
          controller = streamController;
        },
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    let streamPromise!: Promise<unknown>;
    act(() => {
      streamPromise = result.current.startStream('thread-1', 'hi', { onError });
    });
    // The run starts on the backend...
    act(() => {
      controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'run_start', run: { runId: 'run-1', threadId: 'thread-1', startedAt: '2026-06-22T10:00:00.000Z' } })}\n`));
    });
    await waitFor(() => expect(result.current.state.activeRun?.runId).toBe('run-1'));
    // ...then the connection drops (WebKit surfaces this as a TypeError "Load failed").
    act(() => {
      controller.error(new TypeError('Load failed'));
    });
    await act(async () => {
      await streamPromise;
    });

    // The backend keeps the run alive and the poller reconciles it, so we must
    // NOT raise a hard error for a transport drop.
    expect(result.current.state.status).not.toBe('error');
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isRunning).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    // The started run is preserved as interrupted (recoverable), not lost.
    expect(result.current.state.messages[1]?.run?.status).toBe('interrupted');
  });

  it('treats a failed initial fetch (cold-start "Load failed") as a soft disconnect, not a hard error', async () => {
    const onError = vi.fn();
    // WebKit rejects the very first connection before any Response arrives.
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Load failed'));
    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi', { onError });
    });

    expect(result.current.state.status).not.toBe('error');
    expect(result.current.state.error).toBeNull();
    expect(result.current.state.isRunning).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.lastOutcomeRef.current).toBe('disconnected');
  });

  it('detects a transport drop by message even when the error is not a TypeError', async () => {
    const encoder = new TextEncoder();
    const onError = vi.fn();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(c) { controller = c; } }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    let streamPromise!: Promise<unknown>;
    act(() => {
      streamPromise = result.current.startStream('thread-1', 'hi', { onError });
    });
    act(() => {
      controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'run_start', run: { runId: 'run-1', threadId: 'thread-1', startedAt: 1 } })}\n`));
    });
    await waitFor(() => expect(result.current.state.activeRun?.runId).toBe('run-1'));
    act(() => {
      // A plain Error (not a TypeError) whose message is WebKit's "Load failed".
      controller.error(new Error('Load failed'));
    });
    await act(async () => { await streamPromise; });

    expect(result.current.state.status).not.toBe('error');
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.lastOutcomeRef.current).toBe('disconnected');
  });

  it('detaches the visible stream without aborting the transport or backend run after the visible thread changes', async () => {
    const requestedUrls: string[] = [];
    let requestSignal: AbortSignal | undefined;
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/abort')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      requestSignal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start() {},
        }),
      } as Response;
    });
    const { result } = renderHook(() => usePiStream());

    let streamPromise!: Promise<unknown>;
    act(() => {
      streamPromise = result.current.startStream('thread-old', 'hello');
    });
    act(() => result.current.setActiveThread('thread-new'));
    act(() => result.current.detachStream());
    await Promise.race([
      streamPromise.then(() => {
        throw new Error('detached stream should keep the transport open');
      }),
      new Promise((resolve) => setTimeout(resolve, 10)),
    ]);

    expect(requestedUrls.some((url) => url.endsWith('/abort'))).toBe(false);
    expect(requestSignal?.aborted).toBe(false);
  });

  it('stopRun cancels a backend-owned run via the /abort endpoint without a local stream', async () => {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    });
    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.stopRun('thread-resumed', 'user');
    });

    const abortCall = calls.find((c) => c.url.endsWith('/api/threads/thread-resumed/abort'));
    expect(abortCall).toBeDefined();
    expect(abortCall!.method).toBe('POST');
    expect(abortCall!.body).toEqual({ source: 'user' });
    // No local stream state was touched — the reducer stays idle for re-attached runs.
    expect(result.current.state.isRunning).toBe(false);
  });

  it('surfaces same-thread busy responses as normal errors without throwing a conflict', async () => {
    const onError = vi.fn();
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      body: null,
      json: async () => ({
        kind: 'thread_busy',
        error: 'This thread already has a run in progress',
        activeThreadId: 'thread-1',
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    let response: unknown;
    await act(async () => {
      response = await result.current.startStream('thread-1', 'second', { onError });
    });

    expect(response).toBeNull();
    expect(result.current.state).toMatchObject({
      status: 'error',
      error: 'This thread already has a run in progress',
    });
    expect(onError).toHaveBeenCalledWith('This thread already has a run in progress');
  });

  it('keeps different-thread model busy responses on the confirmable conflict path', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      body: null,
      json: async () => ({
        kind: 'model_busy',
        activeThreadId: 'thread-2',
        activeTitle: 'Other thread',
        modelKey: 'anthropic/sonnet',
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.startStream('thread-1', 'second');
      } catch (error) {
        thrown = error;
      }
    });

    expect(thrown).toEqual(new ChatBusyError('thread-2', 'Other thread', 'anthropic/sonnet'));
  });

  it('keeps a question running when message_end arrives before tool_execution_end', async () => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(streamController) {
          controller = streamController;
        },
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    let streamPromise!: Promise<unknown>;
    act(() => {
      streamPromise = result.current.startStream('thread-1', 'hi');
    });
    act(() => {
      controller.enqueue(encoder.encode(`${JSON.stringify({
        event: {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'question',
          args: { questions: [{ id: 'scope', question: 'Which scope?' }] },
        },
      })}\n`));
      controller.enqueue(encoder.encode(`${JSON.stringify({
        event: {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'call-1',
              name: 'question',
              arguments: { questions: [{ id: 'scope', question: 'Which scope?' }] },
            }],
            timestamp: 123,
          },
        },
      })}\n`));
    });

    await waitFor(() => {
      expect(result.current.state.streamingMessage?.toolCalls?.[0]).toMatchObject({
        id: 'call-1',
        status: 'running',
      });
    });

    act(() => {
      controller.enqueue(encoder.encode(`${JSON.stringify({
        event: {
          type: 'tool_execution_end',
          toolCallId: 'call-1',
          isError: false,
          result: { content: [{ type: 'text', text: 'Scope: Small' }] },
        },
      })}\n`));
      controller.enqueue(encoder.encode(`${JSON.stringify({ kind: 'done' })}\n`));
      controller.close();
    });
    await act(async () => {
      await streamPromise;
    });

    expect(result.current.state.messages[1].toolCalls?.[0]).toMatchObject({
      id: 'call-1',
      status: 'completed',
      result: 'Scope: Small',
    });
  });

  it('preserves question tool result details from stream events', async () => {
    const details = {
      status: 'answered',
      toolCallId: 'call-1',
      answers: [{ questionId: 'scope', selected: ['small'] }],
    };
    const encoder = new TextEncoder();
    const events = [
      { event: { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'question', args: { questions: [] } } },
      { event: { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'question', isError: false, result: { content: [{ type: 'text', text: 'Scope: Small' }], details } } },
      { kind: 'done' },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          controller.close();
        },
      }),
    } as Response);
    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi');
    });

    expect(result.current.state.messages[1].toolCalls?.[0]).toMatchObject({
      id: 'call-1',
      args: { questions: [] },
      status: 'completed',
      result: 'Scope: Small',
      details,
    });
  });

  it('shows assistant error event messages from the stream', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              event: {
                type: 'message_update',
                assistantMessageEvent: {
                  type: 'error',
                  message: "The model 'claude-3-5-haiku-latest' is deprecated",
                },
              },
            }) + '\n',
          ),
        );
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body,
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi', {
        modelKey: 'anthropic/claude-3-5-haiku-latest',
      });
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
      expect(result.current.state.error).toContain('deprecated');
    });
  });

  it('shows API error bodies when stream setup fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      body: null,
      json: async () => ({
        error: "The model 'claude-3-5-haiku-latest' is deprecated",
      }),
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi', {
        modelKey: 'anthropic/claude-3-5-haiku-latest',
      });
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
      expect(result.current.state.error).toContain('deprecated');
    });
  });

  it('sends images in the stream request body when provided', async () => {
    const images = [
      {
        type: 'image' as const,
        data: 'data:image/jpeg;base64,abc',
        mimeType: 'image/jpeg',
        name: 'photo.jpg',
        size: 456,
      },
    ];
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'what is this?', {
        modelKey: 'anthropic/claude-sonnet-4',
        images,
      });
    });

    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      content: 'what is this?',
      modelKey: 'anthropic/claude-sonnet-4',
      images,
    });
  });

  it('renders final message_end content when no text deltas arrive', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              event: {
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [{ type: 'text', text: 'final anthropic response' }],
                  timestamp: 123,
                },
              },
            }) + '\n',
          ),
        );
        controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body,
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi');
    });

    await waitFor(() => {
      expect(result.current.state.messages.some((message) => message.content === 'final anthropic response')).toBe(true);
    });
  });

  it('records context usage events from the stream and returns the latest usage', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              event: {
                type: 'context_usage',
                usage: { tokens: 190_000, contextWindow: 200_000, percent: 95 },
              },
            }) + '\n',
          ),
        );
        controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body,
    } as Response);

    const { result } = renderHook(() => usePiStream());

    let usage;
    await act(async () => {
      usage = await result.current.startStream('thread-1', 'hi');
    });

    expect(usage).toEqual({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
    await waitFor(() => {
      expect(result.current.state.contextUsage).toEqual({ tokens: 190_000, contextWindow: 200_000, percent: 95 });
    });
  });

  it('shows Anthropic thinking_end content as thinking feedback', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              event: {
                type: 'message_update',
                assistantMessageEvent: {
                  type: 'thinking_end',
                  content: 'I am checking the request.',
                },
              },
            }) + '\n',
          ),
        );
        controller.enqueue(encoder.encode(JSON.stringify({ kind: 'done' }) + '\n'));
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body,
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi');
    });

    await waitFor(() => {
      expect(result.current.state.messages.some((message) => message.thinking === 'I am checking the request.')).toBe(true);
    });
  });

  it('shows assistant message_end provider errors', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              event: {
                type: 'message_end',
                message: {
                  role: 'assistant',
                  content: [],
                  stopReason: 'error',
                  errorMessage:
                    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage."}}',
                },
              },
            }) + '\n',
          ),
        );
        controller.close();
      },
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body,
    } as Response);

    const { result } = renderHook(() => usePiStream());

    await act(async () => {
      await result.current.startStream('thread-1', 'hi');
    });

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
      expect(result.current.state.error).toContain('Third-party apps now draw');
    });
  });
});
