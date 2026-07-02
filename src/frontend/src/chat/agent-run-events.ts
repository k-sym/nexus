import type { AgentRunAction } from './agent-run-state';

/** A backend NDJSON stream event (run lifecycle uses `kind`, everything else `type`). */
export type StreamEvent = Record<string, any>;

/** Join tool/message content blocks (or a bare string) into text. */
export function extractStreamText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' && typeof (c as any).text === 'string' ? (c as any).text : '')).join('');
  }
  return '';
}

/**
 * Map one backend stream event to the agent-run reducer action(s) it implies.
 * Shared by the Projects (pi) stream and the Assistant (Hermes) stream so both
 * build an identical AgentRunView. Events that don't affect run state → [].
 */
export function agentRunActionsFor(ev: StreamEvent, now: number): AgentRunAction[] {
  if (ev?.kind === 'run_start') return [{ type: 'RUN_STARTED', run: ev.run }];
  if (ev?.kind === 'run_end') return [{ type: 'RUN_ENDED', run: ev.run }];

  switch (ev?.type) {
    case 'message_update': {
      const ame = ev.assistantMessageEvent;
      if (ame?.type === 'thinking_delta' || ame?.type === 'text_delta') return [{ type: 'MODEL_RESPONDING', at: now }];
      if (ame?.type === 'toolcall_end' && ame.toolCall) {
        return [{ type: 'TOOL_QUEUED', id: ame.toolCall.id, name: ame.toolCall.name, args: ame.toolCall.arguments ?? {}, at: now }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{ type: 'TOOL_STARTED', id: ev.toolCallId, name: ev.toolName, args: ev.args ?? {}, at: now }];
    case 'tool_execution_update':
      return [{ type: 'TOOL_OUTPUT', id: ev.toolCallId, output: extractStreamText(ev.partialResult?.content), at: now }];
    case 'tool_execution_end':
      return [{ type: 'TOOL_FINISHED', id: ev.toolCallId, result: extractStreamText(ev.result?.content), details: ev.result?.details, isError: !!ev.isError, at: now }];
    default:
      return [];
  }
}
