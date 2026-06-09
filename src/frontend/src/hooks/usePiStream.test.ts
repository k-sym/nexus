import { describe, it, expect } from 'vitest';
import { INITIAL_STATE, streamReducer } from './usePiStream';

describe('streamReducer', () => {
  it('START_STREAM seeds a user + empty assistant bubble', () => {
    const next = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'hi' });
    expect(next.isRunning).toBe(true);
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe('user');
    expect(next.streamingMessage?.role).toBe('assistant');
    expect(next.streamingMessage?.isStreaming).toBe(true);
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

  it('ABORT_STREAM preserves any partial content', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const delta = streamReducer(start, { type: 'TEXT_DELTA', delta: 'partial' });
    const abort = streamReducer(delta, { type: 'ABORT_STREAM' });
    expect(abort.isRunning).toBe(false);
    expect(abort.messages).toHaveLength(2);
    expect(abort.messages[1].content).toBe('partial');
  });

  it('RESET clears to initial', () => {
    const start = streamReducer(INITIAL_STATE, { type: 'START_STREAM', prompt: 'x' });
    const reset = streamReducer(start, { type: 'RESET' });
    expect(reset).toEqual(INITIAL_STATE);
  });
});
