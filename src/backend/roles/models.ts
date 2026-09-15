import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
type ProviderConfigInput = NonNullable<Parameters<ModelRegistry['registerProvider']>[1]>;
// Verified 2026-09-15 against the provider model pages; keep these fallbacks
// only until Pi's catalogue supplies the same identifiers.
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// https://openrouter.ai/z-ai/glm-5.2
export function registerRoleModels(registry: ModelRegistry): void {
  const additions: Array<{ provider: string; model: NonNullable<ProviderConfigInput['models']>[number] }> = [
    { provider: 'openai', model: {
      id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
      reasoning: true, input: ['text', 'image'], contextWindow: 1050000, maxTokens: 128000,
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    } },
    { provider: 'openrouter', model: {
      id: 'z-ai/glm-5.2', name: 'GLM 5.2', api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 163840,
      cost: { input: 0.4875, output: 1.56, cacheRead: 0.091, cacheWrite: 0 },
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', xhigh: 'xhigh' },
    } },
  ];
  for (const { provider, model } of additions) {
    if (registry.find(provider, model.id)) continue;
    // The extension layer replaces the provider's model list, so carry every
    // existing entry and its routing metadata forward, retaining native auth.
    registry.registerProvider(provider, {
      ...registry.getRegisteredProviderConfig(provider),
      models: [...registry.getAll().filter(m => m.provider === provider), model],
    });
  }
}
