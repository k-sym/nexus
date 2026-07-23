import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizeTool,
  createToolPolicyResolver,
  isSideEffectful,
  resolveToolDecision,
  DEFAULT_CATEGORY_POLICY,
  UNGATED_TOOL_NAMES,
  type ToolPolicyResolver,
} from '../pi/tool-policy';

const call = (toolName: string, input: unknown = {}) => ({ toolName, input });

test('tools are classified, and anything unrecognised is side-effectful', () => {
  assert.equal(categorizeTool('bash'), 'exec');
  assert.equal(categorizeTool('edit'), 'write');
  assert.equal(categorizeTool('grep'), 'read');
  assert.equal(categorizeTool('memory_recall'), 'read');
  assert.equal(categorizeTool('monday_post_update'), 'network');
  assert.equal(categorizeTool('question'), 'interactive');

  // The point of the `unknown` default: a tool nobody classified — including
  // one a future extension registers — is treated as capable of side effects.
  assert.equal(categorizeTool('docker_service'), 'unknown');
  assert.equal(isSideEffectful('docker_service'), true);
  assert.equal(isSideEffectful('bash'), true);
  assert.equal(isSideEffectful('grep'), false);
});

test('Phase 1 defaults change nothing: unsupervised gates nothing', () => {
  const policy = createToolPolicyResolver({ isSupervised: () => false });
  for (const tool of ['bash', 'edit', 'grep', 'read', 'question', 'docker_service']) {
    assert.equal(policy(call(tool)), 'allow', `${tool} should be ungated when not supervised`);
  }
  assert.ok(
    Object.values(DEFAULT_CATEGORY_POLICY).every((d) => d === 'allow'),
    'Phase 1 ships allow-everything defaults so no existing thread changes behaviour',
  );
});

test('Supervise still means confirm everything gateable', () => {
  const policy = createToolPolicyResolver({ isSupervised: () => true });
  assert.equal(policy(call('bash')), 'confirm');
  assert.equal(policy(call('edit')), 'confirm');
  assert.equal(policy(call('grep')), 'confirm');
  // ...except the one tool that owns its own approval path.
  assert.ok(UNGATED_TOOL_NAMES.has('question'));
  assert.equal(policy(call('question')), 'allow');
});

test('a single tool can be gated without gating the rest of the thread', () => {
  // The whole point of #266: this was impossible with a boolean.
  const policy = createToolPolicyResolver({
    isSupervised: () => false,
    categoryPolicy: () => ({ services: 'confirm', exec: 'confirm' }),
  });
  assert.equal(policy(call('bash')), 'confirm');
  assert.equal(policy(call('grep')), 'allow');
  assert.equal(policy(call('read')), 'allow');
  assert.equal(policy(call('edit')), 'allow');
});

test('policy is read live — no session rebuild needed', () => {
  let supervised = false;
  let categories: Record<string, string> = {};
  const policy = createToolPolicyResolver({
    isSupervised: () => supervised,
    categoryPolicy: () => categories as never,
  });

  assert.equal(policy(call('bash')), 'allow');
  supervised = true;
  assert.equal(policy(call('bash')), 'confirm', 'Supervise toggle lands on the next call');
  supervised = false;
  categories = { exec: 'deny' };
  assert.equal(policy(call('bash')), 'deny', 'category change lands on the next call');
});

test('deny is a floor: a lower-precedence source cannot downgrade it', () => {
  // Supervise is higher precedence and says `confirm`, but a category `deny`
  // must not be softened into a prompt someone can click through.
  const policy = createToolPolicyResolver({
    isSupervised: () => true,
    categoryPolicy: () => ({ exec: 'deny' }),
  });
  assert.equal(policy(call('bash')), 'deny');

  // The reverse direction still escalates: supervised turns an allowed
  // category into a confirm.
  const escalating = createToolPolicyResolver({
    isSupervised: () => true,
    categoryPolicy: () => ({ read: 'allow' }),
  });
  assert.equal(escalating(call('grep')), 'confirm');
});

test('resolveToolDecision fails closed on a throwing policy', () => {
  const boom: ToolPolicyResolver = () => { throw new Error('bad rule'); };
  assert.equal(resolveToolDecision(boom, call('bash')), 'confirm');
  assert.equal(resolveToolDecision(boom, call('docker_service')), 'confirm');
  // Read-only tools stay allowed: a broken policy must not wedge every grep.
  assert.equal(resolveToolDecision(boom, call('grep')), 'allow');
  // ...and an ungated tool is still never parked, even on the failure path,
  // because doing so would deadlock the thread.
  assert.equal(resolveToolDecision(boom, call('question')), 'allow');
});

test('resolveToolDecision treats a malformed decision like a thrown one', () => {
  const nonsense = (() => 'maybe') as unknown as ToolPolicyResolver;
  assert.equal(resolveToolDecision(nonsense, call('bash')), 'confirm');
  assert.equal(resolveToolDecision(nonsense, call('grep')), 'allow');

  const nothing = (() => undefined) as unknown as ToolPolicyResolver;
  assert.equal(resolveToolDecision(nothing, call('edit')), 'confirm');
});

test('resolveToolDecision passes through well-formed decisions unchanged', () => {
  for (const decision of ['allow', 'confirm', 'deny'] as const) {
    assert.equal(resolveToolDecision(() => decision, call('bash')), decision);
  }
});
