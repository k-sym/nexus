import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';

import { isThinkingLevel, type ThinkingLevel } from './thinking.js';

export type ImageInputCapability = 'supported' | 'unsupported' | 'unknown';
export type ModelCapabilitySource = 'catalog' | 'provider';

export interface ReasoningCapabilities {
  supported: boolean;
  mandatory: boolean;
  levels: ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
  defaultEnabled?: boolean;
}

export interface ModelCapabilities {
  source: ModelCapabilitySource;
  imageInput: ImageInputCapability;
  reasoning: ReasoningCapabilities;
}

export interface CapabilityModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  input?: unknown;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

interface OpenRouterReasoning {
  supported_efforts?: unknown;
  default_effort?: unknown;
  default_enabled?: unknown;
  mandatory?: unknown;
}

interface OpenRouterModelResponse {
  data?: {
    architecture?: { input_modalities?: unknown };
    reasoning?: OpenRouterReasoning | null;
  };
}

interface CacheEntry {
  capabilities: ModelCapabilities;
  expiresAt: number;
}

const STANDARD_REASONING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const SUCCESS_TTL_MS = 15 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3000;

function orderedLevels(values: Iterable<ThinkingLevel>): ThinkingLevel[] {
  const requested = new Set(values);
  return ['off', ...STANDARD_REASONING_LEVELS].filter((level): level is ThinkingLevel =>
    requested.has(level as ThinkingLevel),
  );
}

function catalogImageCapability(model: CapabilityModel): ImageInputCapability {
  if (!Array.isArray(model.input)) return 'unknown';
  if (model.input.includes('image')) return 'supported';
  // Remote/generated catalogs can lag behind endpoint capabilities. Until a
  // live lookup completes, keep text-only metadata advisory rather than
  // turning it back into the false-negative guard this feature replaces. The
  // Nexus local provider is explicit user configuration, so it is definitive.
  if (model.provider === 'local') return 'unsupported';
  return 'unknown';
}

export function capabilitiesFromModel(model: CapabilityModel): ModelCapabilities {
  const levels = model.reasoning
    ? (getSupportedThinkingLevels(model as any) as ThinkingLevel[])
    : [];
  return {
    source: 'catalog',
    imageInput: catalogImageCapability(model),
    reasoning: {
      supported: model.reasoning === true,
      mandatory: model.reasoning === true && !levels.includes('off'),
      levels,
      defaultEnabled: model.reasoning === true ? undefined : false,
    },
  };
}

function parseOpenRouterCapabilities(payload: unknown): ModelCapabilities | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const data = (payload as OpenRouterModelResponse).data;
  if (!data || typeof data !== 'object') return undefined;

  const modalities = data.architecture?.input_modalities;
  const imageInput: ImageInputCapability = Array.isArray(modalities)
    ? (modalities.includes('image') ? 'supported' : 'unsupported')
    : 'unknown';

  const advertised = data.reasoning;
  if (!advertised || typeof advertised !== 'object') {
    return {
      source: 'provider',
      imageInput,
      reasoning: { supported: false, mandatory: false, levels: [], defaultEnabled: false },
    };
  }

  const mandatory = advertised.mandatory === true;
  const supportedEfforts = advertised.supported_efforts;
  let selectable: ThinkingLevel[] = [];
  if (supportedEfforts === null) {
    selectable = [...STANDARD_REASONING_LEVELS];
  } else if (Array.isArray(supportedEfforts)) {
    selectable = supportedEfforts
      .map((value) => value === 'none' ? 'off' : value)
      .filter(isThinkingLevel);
  }
  if (!mandatory) selectable.push('off');
  selectable = orderedLevels(selectable);

  const rawDefault = advertised.default_effort === 'none' ? 'off' : advertised.default_effort;
  const defaultLevel = isThinkingLevel(rawDefault) ? rawDefault : undefined;
  return {
    source: 'provider',
    imageInput,
    reasoning: {
      supported: true,
      mandatory,
      levels: selectable,
      defaultLevel,
      defaultEnabled: typeof advertised.default_enabled === 'boolean'
        ? advertised.default_enabled
        : undefined,
    },
  };
}

function openRouterModelUrl(modelId: string): string | undefined {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  const author = encodeURIComponent(modelId.slice(0, slash));
  const slug = encodeURIComponent(modelId.slice(slash + 1));
  return `https://openrouter.ai/api/v1/model/${author}/${slug}`;
}

export class ModelCapabilityResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<ModelCapabilities>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  peek(model: CapabilityModel): ModelCapabilities {
    const key = `${model.provider}/${model.id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities;
    return capabilitiesFromModel(model);
  }

  async resolve(model: CapabilityModel): Promise<ModelCapabilities> {
    if (model.provider !== 'openrouter') return capabilitiesFromModel(model);
    const key = `${model.provider}/${model.id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.capabilities;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;

    const lookup = this.resolveOpenRouter(model).finally(() => this.pending.delete(key));
    this.pending.set(key, lookup);
    return lookup;
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }

  private async resolveOpenRouter(model: CapabilityModel): Promise<ModelCapabilities> {
    const key = `${model.provider}/${model.id}`;
    const fallback = capabilitiesFromModel(model);
    const url = openRouterModelUrl(model.id);
    if (!url) return fallback;
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`OpenRouter model lookup failed: ${response.status}`);
      const resolved = parseOpenRouterCapabilities(await response.json()) ?? fallback;
      this.cache.set(key, { capabilities: resolved, expiresAt: Date.now() + SUCCESS_TTL_MS });
      return resolved;
    } catch {
      this.cache.set(key, { capabilities: fallback, expiresAt: Date.now() + FAILURE_TTL_MS });
      return fallback;
    }
  }
}

export const modelCapabilityResolver = new ModelCapabilityResolver();

/** Resolve Nexus's Auto state to a concrete Pi level when the model reasons. */
export function defaultThinkingLevel(capabilities: ModelCapabilities): ThinkingLevel | undefined {
  const reasoning = capabilities.reasoning;
  if (!reasoning.supported) return undefined;
  if (reasoning.defaultLevel && reasoning.levels.includes(reasoning.defaultLevel)) {
    return reasoning.defaultLevel;
  }
  if (reasoning.defaultEnabled === false && reasoning.levels.includes('off')) return 'off';
  if (reasoning.levels.includes('medium')) return 'medium';
  return reasoning.levels.find((level) => level !== 'off')
    ?? (reasoning.mandatory ? undefined : reasoning.levels[0]);
}

export function normalizeThinkingLevel(
  capabilities: ModelCapabilities,
  requested: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  const reasoning = capabilities.reasoning;
  if (!reasoning.supported) return undefined;
  if (requested === undefined) return defaultThinkingLevel(capabilities);
  if (reasoning.levels.includes(requested)) return requested;
  if (requested === 'off' && reasoning.mandatory) return defaultThinkingLevel(capabilities);
  if (reasoning.levels.length === 0) return defaultThinkingLevel(capabilities);

  const order: ThinkingLevel[] = ['off', ...STANDARD_REASONING_LEVELS];
  const requestedIndex = order.indexOf(requested);
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    if (reasoning.levels.includes(order[index])) return order[index];
  }
  for (let index = requestedIndex + 1; index < order.length; index += 1) {
    if (reasoning.levels.includes(order[index])) return order[index];
  }
  return defaultThinkingLevel(capabilities);
}
