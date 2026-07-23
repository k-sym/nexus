import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NexusConfig } from '@nexus/shared';
import { getNexusDir, resolveEnvVars } from '../config.js';

export interface LocalModelTestInput {
  base_url?: string;
  api_key?: string;
  chat_model?: string;
}

export interface LocalModelTestResult {
  ok: boolean;
  message: string;
  models: string[];
  modelFound?: boolean;
}

export function defaultLocalModelsFile(): string {
  // Via getNexusDir() so NEXUS_HOME relocates this alongside config.yaml —
  // PUT /api/settings writes this file whenever no explicit path is supplied.
  return join(getNexusDir(), 'models.json');
}

export function writeLocalModelsFile(config: NexusConfig, filePath = defaultLocalModelsFile()): void {
  const local = config.models.local;
  const baseUrl = local.base_url.trim();
  const chatModel = local.chat_model.trim();
  const displayName = local.display_name?.trim() || 'Custom Model';
  const input: Array<'text' | 'image'> = local.supports_images ? ['text', 'image'] : ['text'];
  const providers = baseUrl && chatModel
    ? {
        // Provider id stays `local` — it is persisted in model-curation.json,
        // chat_threads.last_model_key and tasks.model_key, and renaming it would
        // silently drop those keys from the catalog. Only the label changes.
        local: {
          name: 'Custom Model Endpoint',
          baseUrl,
          api: 'openai-completions',
          apiKey: localModelsApiKey(local.api_key),
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
          models: [
            {
              id: chatModel,
              name: displayName,
              input,
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      }
    : {};

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify({ providers }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function localModelsApiKey(value?: string): string {
  const trimmed = value?.trim() || '';
  if (!trimmed) return 'local';
  if (trimmed.includes('$') && !resolveEnvVars(trimmed).trim()) return 'local';
  return trimmed;
}

export async function testLocalModel(input: LocalModelTestInput): Promise<LocalModelTestResult> {
  const baseUrl = normalizeBaseUrl(input.base_url);
  if (!baseUrl) {
    return { ok: false, message: 'Base URL is required.', models: [] };
  }

  const apiKey = resolveEnvVars(input.api_key?.trim() || '');
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    const models = await fetchModelIds(baseUrl, headers);
    const chatModel = input.chat_model?.trim() || '';
    if (!chatModel) {
      return { ok: true, message: 'Endpoint responded.', models };
    }
    const modelFound = models.length === 0 || models.includes(chatModel);
    if (!modelFound) {
      return { ok: false, message: `Model "${chatModel}" was not listed by the endpoint.`, models, modelFound: false };
    }
    await fetchChatCompletion(baseUrl, headers, chatModel);
    return { ok: true, message: 'Model responded.', models, modelFound: true };
  } catch (err: any) {
    return { ok: false, message: err?.message || 'Endpoint test failed.', models: [] };
  }
}

function normalizeBaseUrl(value?: string): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

async function fetchModelIds(baseUrl: string, headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`/models returned ${res.status}`);
  const body = await res.json() as { data?: Array<{ id?: unknown }> };
  return Array.isArray(body.data)
    ? body.data.map((model) => model.id).filter((id): id is string => typeof id === 'string')
    : [];
}

async function fetchChatCompletion(baseUrl: string, headers: Record<string, string>, model: string): Promise<void> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with pong.' }],
      max_tokens: 8,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`/chat/completions returned ${res.status}`);
  const body = await res.json() as { choices?: unknown[] };
  if (!Array.isArray(body.choices) || body.choices.length === 0) {
    throw new Error('Model returned no choices.');
  }
}
