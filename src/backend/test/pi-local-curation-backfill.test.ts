import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backfillLocalCuratedModels } from '../pi/local-model-curation-backfill';
import { ModelCurationStore } from '../pi/model-curation';

test('backfillLocalCuratedModels adds a configured path-like local model to existing curation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-local-curation-'));
  const localModelId = '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf';
  const localModelKey = `local/${localModelId}`;
  let refreshes = 0;
  const pi = {
    models: {
      refresh: () => {
        refreshes += 1;
      },
      getAll: () => [
        { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { provider: 'local', id: localModelId, name: 'Local Model' },
      ],
      getAvailable: () => [
        { provider: 'anthropic', id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { provider: 'local', id: localModelId, name: 'Local Model' },
      ],
    },
  };

  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.save(['anthropic/claude-sonnet-4-6']);

    await backfillLocalCuratedModels(pi, store);

    const result = store.apply(pi.models.getAll());
    assert.equal(refreshes, 1);
    assert.deepEqual(result.enabledKeys, ['anthropic/claude-sonnet-4-6', localModelKey]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfillLocalCuratedModels skips when local has no configured available model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-local-curation-'));
  let refreshes = 0;
  const pi = {
    models: {
      refresh: () => {
        refreshes += 1;
      },
      getAll: () => [
        { provider: 'local', id: '/Users/k-sym/Models/ornith-1.0-35b-Q8_0.gguf', name: 'Local Model' },
      ],
      getAvailable: () => [],
    },
  };

  try {
    const store = new ModelCurationStore(join(dir, 'model-curation.json'));
    store.save([]);

    await backfillLocalCuratedModels(pi, store);

    assert.equal(refreshes, 1);
    assert.deepEqual(store.read()?.enabledModelKeys, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
