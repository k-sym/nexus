import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ModelCapabilityResolver,
  capabilitiesFromModel,
  normalizeThinkingLevel,
} from '../pi/model-capabilities.js';

test('catalog capabilities keep stale OpenRouter text-only metadata unknown', () => {
  const capabilities = capabilitiesFromModel({
    provider: 'openrouter',
    id: 'vendor/vision-model',
    reasoning: false,
    input: ['text'],
  });

  assert.equal(capabilities.imageInput, 'unknown');
  assert.equal(capabilities.reasoning.supported, false);
});

test('live OpenRouter capabilities expose image input and mandatory reasoning levels', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    data: {
      architecture: { input_modalities: ['text', 'image'] },
      reasoning: {
        supported_efforts: ['high', 'medium', 'low'],
        default_effort: 'medium',
        default_enabled: true,
        mandatory: true,
      },
    },
  }), { status: 200 });
  const resolver = new ModelCapabilityResolver(fetchImpl as typeof fetch);

  const capabilities = await resolver.resolve({
    provider: 'openrouter',
    id: 'openai/gpt-test',
    reasoning: true,
    input: ['text'],
  });

  assert.equal(capabilities.source, 'provider');
  assert.equal(capabilities.imageInput, 'supported');
  assert.equal(capabilities.reasoning.mandatory, true);
  assert.equal(capabilities.reasoning.defaultLevel, 'medium');
  assert.deepEqual(capabilities.reasoning.levels, ['low', 'medium', 'high']);
  assert.equal(normalizeThinkingLevel(capabilities, undefined), 'medium');
  assert.equal(normalizeThinkingLevel(capabilities, 'off'), 'medium');
});

test('failed OpenRouter lookup falls back to advisory catalog capabilities', async () => {
  const resolver = new ModelCapabilityResolver(async () => {
    throw new Error('offline');
  });

  const capabilities = await resolver.resolve({
    provider: 'openrouter',
    id: 'openai/gpt-test',
    reasoning: true,
    input: ['text'],
  });

  assert.equal(capabilities.source, 'catalog');
  assert.equal(capabilities.imageInput, 'unknown');
  assert.equal(normalizeThinkingLevel(capabilities, undefined), 'medium');
});
