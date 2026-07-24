import { describe, expect, it } from 'vitest';
import {
  clampToSupportedThinkingLevel,
  isThinkingLevel,
  thinkingLevelLabel,
  type ThinkingLevel,
} from './thinking';

describe('thinking helpers', () => {
  it('labels Pi levels', () => {
    expect(thinkingLevelLabel('off')).toBe('Off');
    expect(thinkingLevelLabel('xhigh')).toBe('XHigh');
    expect(thinkingLevelLabel('max')).toBe('Max');
  });

  it('validates thinking levels', () => {
    expect(isThinkingLevel('high')).toBe(true);
    expect(isThinkingLevel('plan')).toBe(false);
    expect(isThinkingLevel(null)).toBe(false);
  });

  it('clamps to an exact supported match', () => {
    const supported: ThinkingLevel[] = ['off', 'low', 'high'];
    expect(clampToSupportedThinkingLevel('high', supported)).toBe('high');
  });

  it('clamps down to the nearest supported level', () => {
    const supported: ThinkingLevel[] = ['off', 'low', 'high'];
    expect(clampToSupportedThinkingLevel('medium', supported)).toBe('low');
    expect(clampToSupportedThinkingLevel('xhigh', supported)).toBe('high');
  });

  it('clamps up when only higher levels are available', () => {
    const supported: ThinkingLevel[] = ['high', 'max'];
    expect(clampToSupportedThinkingLevel('off', supported)).toBe('high');
  });

  it('returns undefined for an empty supported list', () => {
    expect(clampToSupportedThinkingLevel('high', [])).toBeUndefined();
  });
});
