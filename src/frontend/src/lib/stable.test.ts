import { describe, expect, it } from 'vitest';
import { keepIfSameSet, keepIfSameJson } from './stable';

describe('keepIfSameSet', () => {
  it('returns the previous Set when membership is unchanged', () => {
    const prev = new Set(['a', 'b']);
    expect(keepIfSameSet(prev, new Set(['b', 'a']))).toBe(prev);
  });

  it('returns the next Set when membership differs', () => {
    const prev = new Set(['a']);
    const next = new Set(['a', 'b']);
    expect(keepIfSameSet(prev, next)).toBe(next);
    expect(keepIfSameSet(new Set(['a', 'b']), new Set(['a']))).not.toBe(prev);
  });
});

describe('keepIfSameJson', () => {
  it('returns the previous value when the next serialises identically', () => {
    const prev = [{ threadId: 't1', title: 'A' }];
    expect(keepIfSameJson(prev, [{ threadId: 't1', title: 'A' }])).toBe(prev);
  });

  it('returns the next value when anything differs', () => {
    const prev = [{ threadId: 't1', title: 'A' }];
    const next = [{ threadId: 't1', title: 'B' }];
    expect(keepIfSameJson(prev, next)).toBe(next);
  });
});
