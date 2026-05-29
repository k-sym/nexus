/**
 * Settings / config API.
 *
 * Exposes the ~/.nexus/config.yaml for reading and updating from the UI. The
 * API key is masked on read (never sent in full to the client) and only
 * overwritten on save if a new non-masked value is provided.
 */
import { FastifyInstance } from 'fastify';
import { loadConfig, saveConfig } from '../config';
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
    };
  });

  fastify.put('/api/settings', async (request) => {
    const incoming = request.body as NexusConfig;
    const current = loadConfig();

    // Preserve the existing API key unless a new (non-masked) one was provided.
    const incomingKey = incoming.models?.openrouter?.api_key;
    const apiKey = !incomingKey || incomingKey === MASK
      ? current.models.openrouter.api_key
      : incomingKey;

    const merged: NexusConfig = {
      ...current,
      ...incoming,
      models: {
        openrouter: { api_key: apiKey },
        ollama: { base_url: incoming.models?.ollama?.base_url ?? current.models.ollama.base_url },
      },
    };

    saveConfig(merged);

    return {
      ...merged,
      models: {
        ...merged.models,
        openrouter: { api_key: maskSecret(merged.models.openrouter.api_key) },
      },
    };
  });
}
