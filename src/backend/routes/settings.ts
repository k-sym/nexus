/**
 * Settings / config API.
 *
 * Exposes the ~/.nexus/config.yaml for reading and updating from the UI. The
 * API key is masked on read (never sent in full to the client) and only
 * overwritten on save if a new non-masked value is provided.
 */
import { FastifyInstance } from 'fastify';
import { loadConfig, saveConfig } from '../config.js';
import { NexusConfig } from '@nexus/shared';

const MASK = '••••••••';

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.startsWith('${')) return value; // env var reference — safe to show
  return MASK;
}

export async function registerSettingsRoutes(fastify: FastifyInstance) {
  fastify.get('/api/settings', async () => {
    const config = loadConfig();
    // Mask the API key so we never ship the raw secret to the browser.
    return {
      ...config,
      models: {
        ...config.models,
        openrouter: { api_key: maskSecret(config.models.openrouter.api_key) },
      },
      // Derived, read-only signal so the UI can show "token detected" without
      // ever receiving the secret. The GITHUB_TOKEN value itself is never sent.
      github_token_detected: !!process.env.GITHUB_TOKEN,
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

    const merged: NexusConfig = {
      ...current,
      ...incoming,
      jira: incoming.jira ?? current.jira,
      github: incoming.github ?? current.github,
      models: {
        openrouter: { api_key: apiKey },
        local: {
          base_url: incoming.models?.local?.base_url ?? current.models.local.base_url,
          api_key: incoming.models?.local?.api_key ?? current.models.local.api_key,
          embedding_model: incoming.models?.local?.embedding_model ?? current.models.local.embedding_model,
          rerank_model: incoming.models?.local?.rerank_model ?? current.models.local.rerank_model,
        },
      },
    };

    saveConfig(merged);

    return {
      ...merged,
      models: {
        ...merged.models,
        openrouter: { api_key: maskSecret(merged.models.openrouter.api_key) },
      },
      github_token_detected: !!process.env.GITHUB_TOKEN,
    };
  });
}
