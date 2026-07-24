import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ThinkingLevel } from './thinking.js';

export interface ModelCatalogItem {
  provider: string;
  id: string;
  name: string;
  configured?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: Array<'text' | 'image'>;
  /** Supported Pi thinking levels; empty when the model has no extended thinking. */
  thinkingLevels?: ThinkingLevel[];
}

interface CurationFile {
  version: 1;
  enabledModelKeys: string[];
  oauthSyncedProviders: string[];
}

export interface AppliedModelCuration {
  allModels: ModelCatalogItem[];
  models: ModelCatalogItem[];
  enabledKeys: string[];
  customized: boolean;
}

export function modelKey(provider: string, id: string): string {
  return `${provider}/${id}`;
}

export class ModelCurationStore {
  constructor(private readonly filePath: string) {}

  read(): CurationFile | null {
    if (!existsSync(this.filePath)) return null;
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<CurationFile>;
    return {
      version: 1,
      enabledModelKeys: Array.isArray(parsed.enabledModelKeys)
        ? parsed.enabledModelKeys.filter((key): key is string => typeof key === 'string')
        : [],
      oauthSyncedProviders: Array.isArray(parsed.oauthSyncedProviders)
        ? parsed.oauthSyncedProviders.filter((provider): provider is string => typeof provider === 'string')
        : [],
    };
  }

  save(enabledModelKeys: string[]): CurationFile {
    const current = this.read();
    const deduped = [...new Set(enabledModelKeys)].sort();
    const next: CurationFile = {
      version: 1,
      enabledModelKeys: deduped,
      oauthSyncedProviders: current?.oauthSyncedProviders ?? [],
    };
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    writeFileSync(this.filePath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    return next;
  }

  hasSyncedOAuthProvider(provider: string): boolean {
    return this.read()?.oauthSyncedProviders.includes(provider) ?? false;
  }

  markOAuthProviderSynced(
    provider: string,
    allModels: ModelCatalogItem[],
    options: { excludedProviders?: string[] } = {},
  ): CurationFile {
    const current = this.read();
    if (current) {
      const marked: CurationFile = {
        ...current,
        oauthSyncedProviders: [...new Set([...current.oauthSyncedProviders, provider])].sort(),
      };
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileSync(this.filePath, JSON.stringify(marked, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
      return marked;
    }

    const excludedProviders = new Set(options.excludedProviders ?? [provider]);
    const baseline = allModels
      .filter((model) => !excludedProviders.has(model.provider) && model.configured !== false)
      .map((model) => modelKey(model.provider, model.id));
    const next = this.save(baseline);
    const marked: CurationFile = {
      ...next,
      oauthSyncedProviders: [...new Set([...next.oauthSyncedProviders, provider])].sort(),
    };
    writeFileSync(this.filePath, JSON.stringify(marked, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    return marked;
  }

  enableConfiguredProviderModels(
    provider: string,
    allModels: ModelCatalogItem[],
    options: { markOAuthSynced?: boolean } = {},
  ): CurationFile {
    const current = this.read();
    const enabled = new Set(
      current?.enabledModelKeys ??
        allModels
          .filter((model) => model.configured !== false)
          .map((model) => modelKey(model.provider, model.id)),
    );
    for (const model of allModels) {
      if (model.provider === provider && model.configured !== false) {
        enabled.add(modelKey(model.provider, model.id));
      }
    }
    const next = this.save([...enabled]);
    if (!options.markOAuthSynced) return next;
    const oauthSyncedProviders = [...new Set([...next.oauthSyncedProviders, provider])].sort();
    const marked: CurationFile = { ...next, oauthSyncedProviders };
    writeFileSync(this.filePath, JSON.stringify(marked, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    return marked;
  }

  apply(allModels: ModelCatalogItem[]): AppliedModelCuration {
    const file = this.read();
    const known = new Set(allModels.map((model) => modelKey(model.provider, model.id)));
    const enabledKeys = file
      ? file.enabledModelKeys.filter((key) => known.has(key))
      : allModels
          .filter((model) => model.configured !== false)
          .map((model) => modelKey(model.provider, model.id));
    const enabledSet = new Set(enabledKeys);
    return {
      allModels,
      models: allModels.filter((model) => enabledSet.has(modelKey(model.provider, model.id))),
      enabledKeys,
      customized: file !== null,
    };
  }
}
