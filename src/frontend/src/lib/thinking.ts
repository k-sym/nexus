export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVEL_ORDER: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

const THINKING_LEVEL_SET: ReadonlySet<string> = new Set(THINKING_LEVEL_ORDER);

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
};

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && THINKING_LEVEL_SET.has(value);
}

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level];
}

/**
 * Prefer the closest supported level ≤ desired; if none, the lowest supported.
 * Returns undefined when `supported` is empty.
 */
export function clampToSupportedThinkingLevel(
  desired: ThinkingLevel,
  supported: ThinkingLevel[],
): ThinkingLevel | undefined {
  if (supported.length === 0) return undefined;
  const supportedSet = new Set(supported);
  if (supportedSet.has(desired)) return desired;

  const desiredIndex = THINKING_LEVEL_ORDER.indexOf(desired);
  for (let i = desiredIndex - 1; i >= 0; i -= 1) {
    const candidate = THINKING_LEVEL_ORDER[i];
    if (supportedSet.has(candidate)) return candidate;
  }
  for (const candidate of THINKING_LEVEL_ORDER) {
    if (supportedSet.has(candidate)) return candidate;
  }
  return undefined;
}
