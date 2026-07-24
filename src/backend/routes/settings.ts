/**
 * Settings / config API.
 *
 * Exposes the ~/.nexus/config.yaml for reading and updating from the UI. The
 * API key is masked on read (never sent in full to the client) and only
 * overwritten on save if a new non-masked value is provided.
 */
import { FastifyInstance } from 'fastify';
import { loadConfig, saveConfig, resolveEnvVars } from '../config.js';
import { NexusConfig, HelperConfig, HelperProvider } from '@nexus/shared';
import { resolveGitHubToken } from '../github/token.js';
import { testLocalModel, writeLocalModelsFile } from '../pi/local-models.js';
import { HELPER_PROVIDERS } from '../helpers/providers.js';
import { buildModelCatalog } from './pi.js';

const MASK = '••••••••';

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.startsWith('${')) return value; // env var reference — safe to show
  return MASK;
}

/** The curated helper providers, as config keys. */
const HELPER_IDS = ['brave', 'exa', 'perplexity', 'context7'] as const;

function maskHelper(cfg: HelperConfig): HelperConfig {
  return { enabled: cfg.enabled, api_key: maskSecret(cfg.api_key || '') };
}

/** Mask every helper key for the client; leave enabled + search_default intact. */
function maskHelpers(helpers: NexusConfig['helpers']): NexusConfig['helpers'] {
  const out = { ...helpers };
  for (const id of HELPER_IDS) out[id] = maskHelper(helpers[id]);
  return out;
}

/** Preserve a stored helper key unless a new (non-masked) one was typed —
 *  the openrouter/assistant rule, applied per provider. */
function mergeHelperKey(current: HelperConfig, incoming?: HelperConfig): HelperConfig {
  const incomingKey = incoming?.api_key;
  const api_key = !incomingKey || incomingKey === MASK ? current.api_key : incomingKey;
  return { enabled: incoming?.enabled ?? current.enabled, api_key };
}

function mergeHelpers(
  current: NexusConfig['helpers'],
  incoming?: Partial<NexusConfig['helpers']>,
): NexusConfig['helpers'] {
  const out = { ...current, search_default: incoming?.search_default ?? current.search_default };
  for (const id of HELPER_IDS) out[id] = mergeHelperKey(current[id], incoming?.[id]);
  return out;
}

export async function registerSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings', async () => {
    const config = loadConfig();
    // Mask the API key so we never ship the raw secret to the browser.
    return {
      ...config,
      // server.token is the backend bearer — mask it like any other secret.
      server: { ...config.server, token: maskSecret(config.server.token || '') },
      models: {
        ...config.models,
        openrouter: { api_key: maskSecret(config.models.openrouter.api_key) },
      },
      assistant: {
        ...config.assistant,
        api_key: maskSecret(config.assistant.api_key),
      },
      helpers: maskHelpers(config.helpers),
      // Derived, read-only signal so the UI can show "token detected" without
      // ever receiving the secret. Reflects the resolver (GITHUB_TOKEN or a
      // `gh auth token` fallback); the token value itself is never sent.
      github_token_detected: !!(await resolveGitHubToken()),
    };
  });

  fastify.put('/api/settings', async (request) => {
    // The GET response includes a derived `github_token_detected` flag; strip
    // it so it never gets persisted into config.yaml when the UI echoes it back.
    const { github_token_detected: _ignored, ...incoming } =
      request.body as NexusConfig & { github_token_detected?: boolean };
    const current = loadConfig();

    // Preserve the existing API key unless a new (non-masked) one was provided.
    const incomingKey = incoming.models?.openrouter?.api_key;
    const apiKey = !incomingKey || incomingKey === MASK
      ? current.models.openrouter.api_key
      : incomingKey;
    const incomingAssistantKey = incoming.assistant?.api_key;
    const assistantKey = !incomingAssistantKey || incomingAssistantKey === MASK
      ? current.assistant.api_key
      : incomingAssistantKey;
    // server.token is masked on read; keep the stored value unless a new one was typed.
    const incomingServerToken = incoming.server?.token;
    const serverToken = !incomingServerToken || incomingServerToken === MASK
      ? current.server.token
      : incomingServerToken;

    const merged: NexusConfig = {
      ...current,
      ...incoming,
      // Merge server explicitly so the masked token isn't persisted over the real one.
      server: {
        ...current.server,
        ...incoming.server,
        port: incoming.server?.port ?? current.server.port,
        url: incoming.server?.url ?? current.server.url,
        token: serverToken,
      },
      jira: incoming.jira ?? current.jira,
      github: incoming.github ?? current.github,
      // Merge explicitly so a masked key echoed back never overwrites the real one.
      helpers: mergeHelpers(current.helpers, incoming.helpers),
      assistant: {
        url: incoming.assistant?.url ?? current.assistant.url,
        api_key: assistantKey,
      },
      models: {
        openrouter: { api_key: apiKey },
        local: {
          base_url: incoming.models?.local?.base_url ?? current.models.local.base_url,
          api_key: incoming.models?.local?.api_key ?? current.models.local.api_key,
          display_name: incoming.models?.local?.display_name ?? current.models.local.display_name,
          chat_model: incoming.models?.local?.chat_model ?? current.models.local.chat_model,
          supports_images: incoming.models?.local?.supports_images ?? current.models.local.supports_images,
          embedding_model: incoming.models?.local?.embedding_model ?? current.models.local.embedding_model,
          rerank_model: incoming.models?.local?.rerank_model ?? current.models.local.rerank_model,
        },
      },
    };

    const pi = (fastify as any).pi;
    saveConfig(merged);
    writeLocalModelsFile(merged, pi?.paths?.modelsFile);
    await pi?.models?.refresh?.();
    if (merged.models.local.base_url.trim() && merged.models.local.chat_model.trim() && pi) {
      fastify.modelCuration?.enableConfiguredProviderModels('local', buildModelCatalog(fastify));
    }

    return {
      ...merged,
      server: { ...merged.server, token: maskSecret(merged.server.token || '') },
      models: {
        ...merged.models,
        openrouter: { api_key: maskSecret(merged.models.openrouter.api_key) },
      },
      assistant: {
        ...merged.assistant,
        api_key: maskSecret(merged.assistant.api_key),
      },
      helpers: maskHelpers(merged.helpers),
      github_token_detected: !!(await resolveGitHubToken()),
    };
  });

  fastify.post('/api/settings/local-model/test', async (request) => {
    const body = request.body as {
      base_url?: string;
      api_key?: string;
      chat_model?: string;
    };
    return testLocalModel(body ?? {});
  });

  // Verify one helper provider's key with a cheap authenticated call — the
  // Settings "Test" button. Prefers a freshly-typed key (the UI tests before
  // saving) and falls back to the stored one when the field still holds the
  // mask. The key is never echoed back; only {ok, message} is returned.
  fastify.post('/api/settings/helpers/:provider/test', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    const descriptor = HELPER_PROVIDERS[provider as HelperProvider];
    if (!descriptor) {
      reply.code(400);
      return { ok: false, message: `Unknown helper provider: ${provider}` };
    }
    const body = (request.body ?? {}) as { api_key?: string };
    const typed = body.api_key && body.api_key !== MASK ? body.api_key : '';
    const stored = loadConfig().helpers[provider as HelperProvider]?.api_key ?? '';
    const key = resolveEnvVars(typed || stored).trim();
    if (!key) {
      return { ok: false, message: 'No API key to test — enter one first.' };
    }
    return descriptor.verify(key);
  });
}
