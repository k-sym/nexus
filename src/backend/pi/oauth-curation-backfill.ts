import type { PiRuntime } from './runtime';
import type { ModelCurationStore } from './model-curation';
import { buildModelCatalog } from '../routes/pi';

const OAUTH_MODEL_PROVIDERS = ['anthropic', 'openai-codex'] as const;

interface BackfillRuntime {
  auth: Pick<PiRuntime['auth'], 'get'>;
  models: Pick<PiRuntime['models'], 'refresh' | 'getAll' | 'getAvailable'>;
}

export function backfillOAuthCuratedModels(
  pi: BackfillRuntime,
  modelCuration: Pick<ModelCurationStore, 'hasSyncedOAuthProvider' | 'markOAuthProviderSynced'>,
) {
  const providers = OAUTH_MODEL_PROVIDERS.filter((provider) => {
    const credential = pi.auth.get(provider);
    return credential?.type === 'oauth' && !modelCuration.hasSyncedOAuthProvider(provider);
  });
  if (providers.length === 0) return;

  pi.models.refresh();
  const catalog = buildModelCatalog({ pi } as any);
  for (const provider of providers) {
    modelCuration.markOAuthProviderSynced(provider, catalog, { excludedProviders: providers });
  }
}
