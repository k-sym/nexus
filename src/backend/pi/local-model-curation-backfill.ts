import type { PiRuntime } from './runtime.js';
import type { ModelCurationStore } from './model-curation.js';
import { buildModelCatalog } from '../routes/pi.js';

interface BackfillRuntime {
  models: Pick<PiRuntime['models'], 'refresh' | 'getAll' | 'getAvailable'>;
}

export function backfillLocalCuratedModels(
  pi: BackfillRuntime,
  modelCuration: Pick<ModelCurationStore, 'enableConfiguredProviderModels'>,
) {
  pi.models.refresh();
  const catalog = buildModelCatalog({ pi } as any);
  if (!catalog.some((model) => model.provider === 'local' && model.configured !== false)) return;
  modelCuration.enableConfiguredProviderModels('local', catalog);
}
