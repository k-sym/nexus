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
import type { ChatStreamEvent, Provider } from '@nexus/shared';

/** The subset of stream events an adapter produces (the endpoint adds done/error). */
export type StreamChunkEvent = Extract<ChatStreamEvent, { kind: 'delta' } | { kind: 'session' }>;

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
    if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
      return ev.message.content
        .filter((b: any) => b?.type === 'text' && b.text)
        .map((b: any) => ({ kind: 'delta', text: b.text as string }));
    }
    return [];
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
