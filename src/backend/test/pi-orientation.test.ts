import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrientationBlock, modelKeyHasVision, type OrientationInput } from '../pi/orientation';

const NONE: OrientationInput = { hasMemory: false, hasDocker: false, hasBrowser: false, hasVision: false };

test('the block always orients to Nexus and points at project_docs', () => {
  const block = buildOrientationBlock(NONE);
  assert.match(block, /Working in Nexus/);
  assert.match(block, /project_docs/);
  // With no capabilities, it must not claim any tool exists.
  assert.doesNotMatch(block, /memory_recall/);
  assert.doesNotMatch(block, /docker_service/);
  assert.doesNotMatch(block, /browser/i);
});

test('each line appears only when its capability is present', () => {
  assert.match(buildOrientationBlock({ ...NONE, hasMemory: true }), /memory_recall/);
  assert.match(buildOrientationBlock({ ...NONE, hasDocker: true }), /docker_service/);
  assert.match(buildOrientationBlock({ ...NONE, hasBrowser: true }), /verify front-end work in a real browser/);
});

test('screenshots are mentioned only for a vision-capable model', () => {
  // Browser without vision: interaction, but no screenshot claim.
  const noVision = buildOrientationBlock({ ...NONE, hasBrowser: true, hasVision: false });
  assert.match(noVision, /interact with it/);
  assert.doesNotMatch(noVision, /screenshot/i);

  // Browser with vision: the screenshot clause appears.
  const vision = buildOrientationBlock({ ...NONE, hasBrowser: true, hasVision: true });
  assert.match(vision, /screenshot it to see the result/);

  // Vision without the browser tools is meaningless — no screenshot line, since
  // there's no browser to screenshot.
  assert.doesNotMatch(buildOrientationBlock({ ...NONE, hasVision: true }), /screenshot/i);
});

test('the browser line advertises the full surface — emulation and the live preview', () => {
  // The tools self-advertise via their promptSnippets; the orientation framing
  // should still point at the capabilities a model might not think to reach for.
  const block = buildOrientationBlock({ ...NONE, hasBrowser: true });
  assert.match(block, /resize the viewport/, 'responsive checks');
  assert.match(block, /prefers-color-scheme/, 'theme checks');
  assert.match(block, /responsive and dark-mode/);
  // The page is shown to the human live, so the model knows the work is visible.
  assert.match(block, /mirrored live/);
});

test('a fully-capable session gets every line', () => {
  const block = buildOrientationBlock({ hasMemory: true, hasDocker: true, hasBrowser: true, hasVision: true });
  assert.match(block, /memory_recall/);
  assert.match(block, /docker_service/);
  assert.match(block, /real browser/);
  assert.match(block, /screenshot/);
  assert.match(block, /project_docs/);
});

// ── vision resolution ─────────────────────────────────────────────────────────

const find = (models: Record<string, Array<'text' | 'image'>>) =>
  (provider: string, id: string) => {
    const input = models[`${provider}/${id}`];
    return input ? { input } : undefined;
  };

test('modelKeyHasVision resolves image capability from a provider/id key', () => {
  const lookup = find({ 'anthropic/claude': ['text', 'image'], 'local/tiny': ['text'] });
  assert.equal(modelKeyHasVision('anthropic/claude', lookup), true);
  assert.equal(modelKeyHasVision('local/tiny', lookup), false);
});

test('modelKeyHasVision is false for an unresolvable or malformed key', () => {
  const lookup = find({});
  assert.equal(modelKeyHasVision(undefined, lookup), false);
  assert.equal(modelKeyHasVision('', lookup), false);
  assert.equal(modelKeyHasVision('default', lookup), false, 'no slash → no provider/id');
  assert.equal(modelKeyHasVision('/leading-slash', lookup), false);
  assert.equal(modelKeyHasVision('anthropic/unknown', lookup), false, 'key not in the registry');
});
