import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelCurationStore, type ModelCatalogItem } from '../pi/model-curation';

const catalog: ModelCatalogItem[] = [
  { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet', configured: true },
  { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4 Codex', configured: true },
  { provider: 'google', id: 'gemini-pro', name: 'Gemini Pro', configured: false },
];

test('ModelCurationStore preserves configured models before a curation file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    const result = store.apply(catalog);
    assert.equal(result.customized, false);
    assert.deepEqual(result.enabledKeys.sort(), ['anthropic/claude-sonnet-4-5', 'openai-codex/gpt-5.4']);
    assert.deepEqual(result.models.map((m) => `${m.provider}/${m.id}`), [
      'anthropic/claude-sonnet-4-5',
      'openai-codex/gpt-5.4',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore persists an explicit global curated list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const file = join(dir, 'model-curation.json');
    const store = new ModelCurationStore(file);
    store.save(['openai-codex/gpt-5.4']);
    const reloaded = new ModelCurationStore(file).apply(catalog);
    assert.equal(reloaded.customized, true);
    assert.deepEqual(reloaded.enabledKeys, ['openai-codex/gpt-5.4']);
    assert.deepEqual(reloaded.models.map((m) => `${m.provider}/${m.id}`), ['openai-codex/gpt-5.4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore ignores unknown saved model keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.save(['missing/model', 'anthropic/claude-sonnet-4-5']);
    const result = store.apply(catalog);
    assert.deepEqual(result.enabledKeys, ['anthropic/claude-sonnet-4-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore adds configured models for one provider without changing other curated choices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.save(['google/gemini-pro']);
    store.enableConfiguredProviderModels('openai-codex', catalog);
    const result = store.apply(catalog);
    assert.deepEqual(result.enabledKeys, ['google/gemini-pro', 'openai-codex/gpt-5.4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore starts from all configured models when auto-enabling before customization', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.enableConfiguredProviderModels('openai-codex', catalog);
    const result = store.apply(catalog);
    assert.deepEqual(result.enabledKeys.sort(), ['anthropic/claude-sonnet-4-5', 'openai-codex/gpt-5.4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore marks OAuth providers synced without enabling their models', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    assert.equal(store.hasSyncedOAuthProvider('openai-codex'), false);
    store.markOAuthProviderSynced('openai-codex', catalog);
    assert.equal(store.hasSyncedOAuthProvider('openai-codex'), true);
    const result = store.apply(catalog);
    assert.deepEqual(result.enabledKeys, ['anthropic/claude-sonnet-4-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCurationStore can exclude multiple OAuth providers from first sync baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-curation-'));
  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.markOAuthProviderSynced('openai-codex', catalog, {
      excludedProviders: ['anthropic', 'openai-codex'],
    });
    const result = store.apply(catalog);
    assert.deepEqual(result.enabledKeys, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
