import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { buildNexusToolDefinitions, collectPiTools, zodShapeFor } from '../engines/claude/pi-tools-bridge.js';
import { ToolUseCorrelator } from '../engines/claude/tool-use-correlator.js';
import { createQuestionExtension, QuestionBroker } from '../pi/questions.js';
import { createMemoryExtension } from '../pi/memory-tool.js';
import { ApprovalBroker, createApprovalExtension } from '../pi/approvals.js';
import type { ToolPolicyResolver } from '../pi/tool-policy.js';

const allowAll: ToolPolicyResolver = () => 'allow';

function context(overrides: Partial<Parameters<typeof buildNexusToolDefinitions>[1]> = {}) {
  return {
    cwd: '/repo',
    correlator: new ToolUseCorrelator(),
    signal: () => undefined,
    onUpdate: () => {},
    onDetails: () => {},
    ...overrides,
  };
}

test('collectPiTools keeps registerTool() calls and ignores hook-only factories', async () => {
  const tools = await collectPiTools([
    createQuestionExtension('t', new QuestionBroker()),
    createApprovalExtension('t', '/repo', new ApprovalBroker(), allowAll),
    createMemoryExtension('/repo', async () => ['m1', 'm2']),
  ]);
  assert.deepEqual(tools.map((t) => t.name), ['question', 'memory_recall']);
});

test('zodShapeFor turns a TypeBox object schema into a zod raw shape that validates', () => {
  const shape = zodShapeFor(Type.Object({
    query: Type.String({ description: 'q' }),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  }));
  assert.deepEqual(Object.keys(shape), ['query', 'limit']);
  assert.equal(shape.query.safeParse('x').success, true);
  assert.equal(shape.limit.safeParse(undefined).success, true);
  assert.equal(shape.limit.safeParse(0).success, false);
  assert.throws(() => zodShapeFor(Type.String()), /object schema/);
});

test('bridged handler runs the Pi tool under the correlated tool_use id and side-channels details', async () => {
  const tools = await collectPiTools([createMemoryExtension('/repo', async () => ['m1', 'm2'])]);
  const details: Array<[string, unknown]> = [];
  const ctx = context({ onDetails: (id, d) => { details.push([id, d]); } });
  ctx.correlator.remember('mcp__nexus__memory_recall', 'toolu_7', { query: 'x' });
  const [def] = buildNexusToolDefinitions(tools, ctx);
  assert.equal(def.name, 'memory_recall');
  const result = await def.handler({ query: 'x' } as any, {});
  assert.deepEqual(result.content, [{ type: 'text', text: '- m1\n- m2' }]);
  assert.equal(result.isError, false);
  assert.deepEqual(details, [['toolu_7', { status: 'ok', query: 'x', count: 2 }]]);
});

test('a throwing Pi tool becomes an MCP error result instead of a crash', async () => {
  const tools = await collectPiTools([createMemoryExtension('/repo', async () => { throw new Error('daemon down'); })]);
  const [def] = buildNexusToolDefinitions(tools, context());
  const result = await def.handler({ query: 'x' } as any, {});
  assert.equal(result.isError, true);
  assert.deepEqual(result.content, [{ type: 'text', text: 'daemon down' }]);
});
