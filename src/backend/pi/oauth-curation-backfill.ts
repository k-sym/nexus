import type { PiRuntime } from './runtime.js';
import type { ModelCurationStore } from './model-curation.js';
import { buildModelCatalog } from '../routes/pi.js';

const OAUTH_MODEL_PROVIDERS = ['anthropic', 'openai-codex'] as const;

interface BackfillRuntime {
  auth: Pick<PiRuntime['auth'], 'listCredentials'>;
  models: Pick<PiRuntime['models'], 'refresh' | 'getAll' | 'getAvailable'>;
}

export async function backfillOAuthCuratedModels(
  pi: BackfillRuntime,
  modelCuration: Pick<ModelCurationStore, 'hasSyncedOAuthProvider' | 'markOAuthProviderSynced'>,
) {
  const credentials = await pi.auth.listCredentials();
  const oauthProviders = new Set(credentials.filter((credential) => credential.type === 'oauth').map((credential) => credential.providerId));
  const providers = OAUTH_MODEL_PROVIDERS.filter((provider) =>
    oauthProviders.has(provider) && !modelCuration.hasSyncedOAuthProvider(provider));
  if (providers.length === 0) return;

  await pi.models.refresh();
  const catalog = buildModelCatalog({ pi } as any);
  for (const provider of providers) {
    modelCuration.markOAuthProviderSynced(provider, catalog, { excludedProviders: providers });
  }
}
