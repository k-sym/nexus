/**
 * `memory_recall` — the agent's read path into the memory daemon.
 *
 * Memory is pull-based on purpose. The daemon runs HyDE on every recall
 * (~4s median, ~8s p90 on a warm local model stack), so injecting memories
 * into every turn would tax turns that never needed them. Instead the model
 * calls this tool when it decides the project's history is relevant, and pays
 * the latency only then.
 *
 * The write half of the loop is chat's `memory_archive` (see routes/chat.ts);
 * this is what makes those archived memories readable again.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Recall bound to a cwd. Returns formatted memory strings, most relevant first. */
export type MemoryRecallFn = (cwd: string, query: string, limit?: number) => Promise<string[]>;

/** Structured result surfaced alongside the text, for UI rendering and diagnostics. */
export interface MemoryRecallDetails {
  status: 'ok' | 'empty';
  query: string;
  count: number;
}

const MemoryRecallSchema = Type.Object({
  query: Type.String({
    description: 'What to recall, as a natural-language description of the topic — not keywords',
  }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 20,
    description: 'Maximum number of memories to return (default 5)',
  })),
});

export function createMemoryExtension(cwd: string, recall: MemoryRecallFn): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'memory_recall',
      label: 'Recall memory',
      description:
        'Recall memories saved from earlier work on this project — past decisions, their rationale, '
        + 'and conventions that are not recorded in the code. Use it when the answer may depend on '
        + 'history you cannot read from the repo. Takes a few seconds, so skip it for questions the '
        + 'current files already answer.',
      promptSnippet: 'memory_recall: recall decisions and context saved from earlier work on this project',
      parameters: MemoryRecallSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<MemoryRecallDetails>> {
        // Pi's agent loop owns error signalling: a throw becomes an error tool
        // result handed back to the model, and the turn continues. So throw
        // rather than returning a pseudo-error the model has to parse.
        const query = params.query?.trim() ?? '';
        if (!query) throw new Error('memory_recall needs a non-empty query.');

        const memories = await recall(cwd, query, params.limit);

        if (memories.length === 0) {
          // Deliberately "nothing matched", not "this project has no memories" —
          // recall also comes back empty when the daemon is unreachable.
          return {
            content: [{ type: 'text', text: `No memories matched: ${query}` }],
            details: { status: 'empty', query, count: 0 } satisfies MemoryRecallDetails,
          };
        }
        return {
          content: [{ type: 'text', text: memories.map((m) => `- ${m}`).join('\n') }],
          details: { status: 'ok', query, count: memories.length } satisfies MemoryRecallDetails,
        };
      },
    });
  };
}
