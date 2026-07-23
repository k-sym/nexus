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

  assert.equal(categorizeTool('docker_service'), 'services');

  // The point of the `unknown` default: a tool nobody classified — including
  // one a future extension registers — is treated as capable of side effects.
  assert.equal(categorizeTool('not_a_real_tool'), 'unknown');
  assert.equal(isSideEffectful('not_a_real_tool'), true);
  assert.equal(isSideEffectful('docker_service'), true);
  assert.equal(isSideEffectful('bash'), true);
  assert.equal(isSideEffectful('grep'), false);
});

test('defaults leave every pre-existing tool ungated when not supervised', () => {
  const policy = createToolPolicyResolver({ isSupervised: () => false });
  // Everything Nexus shipped before the policy layer must behave exactly as it
  // did — introducing the layer changed no thread's behaviour.
  for (const tool of ['bash', 'edit', 'grep', 'read', 'question', 'not_a_real_tool']) {
    assert.equal(policy(call(tool)), 'allow', `${tool} should be ungated when not supervised`);
  }
  const { services, ...rest } = DEFAULT_CATEGORY_POLICY;
  assert.ok(
    Object.values(rest).every((d) => d === 'allow'),
    'every category that existed before #264 still defaults to allow',
  );
  assert.equal(services, 'confirm');
});

test('docker_service asks before it acts, even unsupervised', () => {
  // The first real use of the policy layer: starting containers binds host
  // ports and can mount host paths, so it confirms by default rather than
  // relying on the thread being supervised.
  const policy = createToolPolicyResolver({ isSupervised: () => false });
  assert.equal(policy(call('docker_service', { action: 'up' })), 'confirm');
  // ...and a project can still opt out of the prompt explicitly.
  const relaxed = createToolPolicyResolver({
    isSupervised: () => false,
    categoryPolicy: () => ({ services: 'allow' }),
  });
  assert.equal(relaxed(call('docker_service', { action: 'up' })), 'allow');
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
