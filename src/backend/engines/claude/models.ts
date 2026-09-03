/**
 * Static catalog for the Claude engine. The SDK accepts any model id the
 * account can reach, so this list is what the picker offers, not a hard limit;
 * `setModel` passes ids through unchanged.
 *
 * `thinkingLevelMap` drives Pi's `getSupportedThinkingLevels`, which the
 * capability resolver already uses for every other catalog entry:
 *   - `off: null` removes "off" (thinking is always on for Fable);
 *   - `xhigh`/`max` must be present (non-undefined) to be offered.
 */
import type { EngineModel } from '../types.js';
import type { ThinkingLevel } from '../../pi/thinking.js';

export const CLAUDE_CODE_PROVIDER = 'claude-code';

export type SdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const FULL_EFFORT = { xhigh: 'xhigh', max: 'max' } as const;
const ALWAYS_ON = { off: null, xhigh: 'xhigh', max: 'max' } as const;

export const CLAUDE_CODE_MODELS: EngineModel[] = [
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-fable-5-1', name: 'Claude Fable 5.1', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: ALWAYS_ON },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-opus-5', name: 'Claude Opus 5', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-opus-4-8', name: 'Claude Opus 4.8', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], thinkingLevelMap: FULL_EFFORT },
  // Haiku 4.5 uses budget-based thinking the SDK manages itself; Nexus offers no level.
  { provider: CLAUDE_CODE_PROVIDER, id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'] },
];

export function findClaudeModel(id: string): EngineModel | undefined {
  return CLAUDE_CODE_MODELS.find((model) => model.id === id);
}

/**
 * Nexus thinking level → SDK request options. `undefined` = leave the SDK's
 * adaptive default alone. `minimal` has no SDK equivalent and becomes `low`.
 * `off` becomes `{ thinking: { type: 'disabled' } }` except on models whose
 * `thinkingLevelMap.off === null` (Fable: disabled thinking is a 400).
 */
export function toSdkThinking(
  model: EngineModel,
  level: ThinkingLevel | undefined,
): { effort?: SdkEffort; thinking?: { type: 'disabled' } } {
  if (level === undefined || model.reasoning !== true) return {};
  if (level === 'off') {
    return model.thinkingLevelMap?.off === null ? { effort: 'low' } : { thinking: { type: 'disabled' } };
  }
  if (level === 'minimal') return { effort: 'low' };
  return { effort: level };
}
