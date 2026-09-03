import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_MODELS, CLAUDE_CODE_PROVIDER, findClaudeModel, toSdkThinking } from '../engines/claude/models.js';
import { capabilitiesFromModel } from '../pi/model-capabilities.js';

test('every catalog model is claude-code, vision-capable and keyed by its SDK id', () => {
  for (const model of CLAUDE_CODE_MODELS) {
    assert.equal(model.provider, CLAUDE_CODE_PROVIDER);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.match(model.id, /^claude-/);
  }
  assert.ok(findClaudeModel('claude-opus-5'));
  assert.equal(findClaudeModel('gpt-5'), undefined);
});

test('capability resolver derives Nexus thinking levels from the catalog', () => {
  const opus = capabilitiesFromModel(findClaudeModel('claude-opus-5')!);
  assert.deepEqual(opus.reasoning.levels, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(opus.imageInput, 'supported');
  const fable = capabilitiesFromModel(findClaudeModel('claude-fable-5-1')!);
  assert.equal(fable.reasoning.mandatory, true);
  assert.ok(!fable.reasoning.levels.includes('off'));
  const haiku = capabilitiesFromModel(findClaudeModel('claude-haiku-4-5')!);
  assert.equal(haiku.reasoning.supported, false);
});

test('toSdkThinking maps Nexus levels onto SDK effort and disabled-thinking', () => {
  const opus = findClaudeModel('claude-opus-5')!;
  const fable = findClaudeModel('claude-fable-5-1')!;
  assert.deepEqual(toSdkThinking(opus, undefined), {});
  assert.deepEqual(toSdkThinking(opus, 'minimal'), { effort: 'low' });
  assert.deepEqual(toSdkThinking(opus, 'xhigh'), { effort: 'xhigh' });
  assert.deepEqual(toSdkThinking(opus, 'off'), { thinking: { type: 'disabled' } });
  // Fable rejects disabled thinking (400): "off" degrades to the lowest effort.
  assert.deepEqual(toSdkThinking(fable, 'off'), { effort: 'low' });
});
