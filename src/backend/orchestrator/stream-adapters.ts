/**
 * Per-provider stream adapters.
 *
 * Each CLI/HTTP provider emits progress in its own format; an adapter normalizes
 * that raw stdout (or HTTP delta) into `delta`/`session` events for the live
 * preview. These are best-effort — the authoritative final reply still comes from
 * the provider's ProviderResult.output, so coarse or slightly-off deltas are fine
 * (the `done` event replaces them).
 *
 * Event shapes (probed against the real CLIs):
 *  - Claude  (`--output-format stream-json --verbose`): {type:'assistant', message:{content:[{type:'text',text}]}}, session_id on every event.
 *  - Codex   (`--json`): {type:'item.completed', item:{type:'agent_message', text}}, thread_id on `thread.started`.
 *  - OpenCode (`--format json`): {type:'text', part:{text, sessionID}}.
 *  - HTTP (OpenAI SSE via runOpenAICompatible): onOutput already yields text deltas → passthrough.
 */
import type { ChatStreamEvent, Provider, ToolCallInfo } from '@nexus/shared';

/** The subset of stream events an adapter produces (the endpoint adds done/error). */
export type StreamChunkEvent = Extract<ChatStreamEvent, { kind: 'delta' } | { kind: 'thinking' } | { kind: 'tool_start' } | { kind: 'tool_update' } | { kind: 'tool_end' } | { kind: 'session' }>;

export interface StreamAdapter {
  /** Feed a raw stdout/HTTP chunk; get back any normalized events it completed. */
  push(chunk: string): StreamChunkEvent[];
}

/** Buffers a byte stream into complete newline-delimited lines. */
function lineSplitter(): (chunk: string, onLine: (line: string) => void) => void {
  let buf = '';
  return (chunk, onLine) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}

/** Build an NDJSON adapter from a function that maps one parsed event → chunk events. */
function ndjsonAdapter(map: (ev: any, emitSession: (id: unknown) => void) => StreamChunkEvent[]): StreamAdapter {
  const feed = lineSplitter();
  let sessionSent = false;
  const emitSession = (id: unknown, out: StreamChunkEvent[]) => {
    if (!sessionSent && typeof id === 'string' && id) { sessionSent = true; out.push({ kind: 'session', session_id: id }); }
  };
  return {
    push(chunk) {
      const out: StreamChunkEvent[] = [];
      feed(chunk, line => {
        let ev: any;
        try { ev = JSON.parse(line); } catch { return; }
        out.push(...map(ev, id => emitSession(id, out)));
      });
      return out;
    },
  };
}

function claudeAdapter(): StreamAdapter {
  return ndjsonAdapter((ev, emitSession) => {
    emitSession(ev?.session_id);
    const out: StreamChunkEvent[] = [];

    // Content block deltas — text, thinking, and tool_use input_json
    if (ev?.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) {
        out.push({ kind: 'delta', text: ev.delta.text });
      } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
        out.push({ kind: 'thinking', text: ev.delta.thinking });
      } else if (ev.delta.type === 'input_json_delta' && ev.delta.partial_json) {
        // Accumulate tool input JSON — emit as tool_update with partial args
        const contentIdx = ev.index;
        out.push({ kind: 'tool_update', id: `tool-${contentIdx}`, patch: { args: { _partial_json: ev.delta.partial_json } } });
      }
    }

    // Content block start — tool_use blocks
    if (ev?.type === 'content_block_start' && ev.content_block) {
      if (ev.content_block.type === 'tool_use') {
        out.push({
          kind: 'tool_start',
          tool: {
            id: ev.content_block.id,
            name: ev.content_block.name,
            args: {},
            status: 'running',
          },
        });
      }
    }

    // Content block stop — tool_use completed
    if (ev?.type === 'content_block_stop' && ev.content_block) {
      if (ev.content_block.type === 'tool_use') {
        out.push({
          kind: 'tool_end',
          tool: {
            id: ev.content_block.id,
            name: ev.content_block.name,
            args: ev.content_block.input || {},
            status: 'completed',
          },
        });
      }
    }

    // Legacy assistant message format (backward compat)
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type === 'text' && b.text) out.push({ kind: 'delta', text: b.text });
        if (b?.type === 'thinking' && b.thinking) out.push({ kind: 'thinking', text: b.thinking });
        if (b?.type === 'tool_use') {
          out.push({ kind: 'tool_start', tool: { id: b.id, name: b.name, args: b.input || {}, status: 'running' } });
          out.push({ kind: 'tool_end', tool: { id: b.id, name: b.name, args: b.input || {}, status: 'completed' } });
        }
      }
    }

    return out;
  });
}

function codexAdapter(): StreamAdapter {
  return ndjsonAdapter((ev, emitSession) => {
    emitSession(ev?.thread_id);
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) {
      return [{ kind: 'delta', text: ev.item.text as string }];
    }
    return [];
  });
}

function openCodeAdapter(): StreamAdapter {
  return ndjsonAdapter((ev, emitSession) => {
    emitSession(ev?.sessionID ?? ev?.part?.sessionID);
    if (ev?.type === 'text' && ev.part?.text) {
      return [{ kind: 'delta', text: ev.part.text as string }];
    }
    return [];
  });
}

/** HTTP providers stream clean text deltas via onOutput already — just forward. */
function passthroughAdapter(): StreamAdapter {
  return { push: chunk => (chunk ? [{ kind: 'delta', text: chunk }] : []) };
}

/** Pick the adapter for a persona's provider (provider record kind, or legacy enum). */
export function adapterFor(providerKind: string | undefined): StreamAdapter {
  switch (providerKind) {
    case 'claude_code': return claudeAdapter();
    case 'codex': return codexAdapter();
    case 'opencode': return openCodeAdapter();
    default: return passthroughAdapter(); // openai_compat, hermes, openrouter, local, …
  }
}

/** Resolve the provider kind from a Provider record or the legacy persona enum. */
export function providerKindOf(provider: Provider | undefined, legacy: string | undefined): string | undefined {
  if (provider) return provider.kind;
  if (legacy === 'openrouter' || legacy === 'local' || legacy === 'ollama') return 'openai_compat';
  return legacy;
}
