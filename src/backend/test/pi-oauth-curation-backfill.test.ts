import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backfillOAuthCuratedModels } from '../pi/oauth-curation-backfill';

test('backfillOAuthCuratedModels syncs stored OAuth providers once', async () => {
  let refreshes = 0;
  const synced: string[] = [];
  const pi = {
    auth: {
      listCredentials: async () => [{ providerId: 'openai-codex', type: 'oauth' as const }],
    },
    models: {
      refresh: () => {
        refreshes += 1;
      },
      getAll: () => [{ provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4' }],
      getAvailable: () => [{ provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT 5.4' }],
    },
  };
  const curation = {
    hasSyncedOAuthProvider: (provider: string) => provider !== 'openai-codex',
    markOAuthProviderSynced: (provider: string) => {
      synced.push(provider);
    },
  };

  await backfillOAuthCuratedModels(pi, curation);

  assert.equal(refreshes, 1);
  assert.deepEqual(synced, ['openai-codex']);
});

test('backfillOAuthCuratedModels skips providers already synced', async () => {
  let refreshes = 0;
  const pi = {
    auth: {
      listCredentials: async () => [{ providerId: 'openai-codex', type: 'oauth' as const }],
    },
    models: {
      refresh: () => {
        refreshes += 1;
      },
      getAll: () => [],
      getAvailable: () => [],
    },
  };
  const curation = {
    hasSyncedOAuthProvider: () => true,
    markOAuthProviderSynced: () => {
      throw new Error('should not sync');
    },
  };

  await backfillOAuthCuratedModels(pi, curation);

  assert.equal(refreshes, 0);
});
