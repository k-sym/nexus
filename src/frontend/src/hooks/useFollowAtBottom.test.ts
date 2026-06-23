import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFollowAtBottom } from './useFollowAtBottom';

function scrollContainer(scrollTop: number) {
  return {
    scrollHeight: 1_000,
    clientHeight: 400,
    scrollTop,
    scrollTo: vi.fn(),
  } as unknown as HTMLDivElement;
}

describe('useFollowAtBottom', () => {
  it('follows new content only while the user remains near the bottom', () => {
    const { result, rerender } = renderHook(
      ({ version }) => useFollowAtBottom(version),
      { initialProps: { version: 0 } },
    );
    const container = scrollContainer(590);
    act(() => {
      result.current.containerRef.current = container;
    });

    rerender({ version: 1 });
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });

    (container as any).scrollTop = 200;
    act(() => result.current.onScroll());
    rerender({ version: 2 });
    expect(container.scrollTo).toHaveBeenCalledTimes(1);
    expect(result.current.isFollowing).toBe(false);
  });

  it('jumpToLatest resumes following', () => {
    const { result } = renderHook(() => useFollowAtBottom(0));
    const container = scrollContainer(100);
    act(() => {
      result.current.containerRef.current = container;
      result.current.onScroll();
      result.current.jumpToLatest();
    });
    expect(container.scrollTo).toHaveBeenCalledWith({ top: 1_000, behavior: 'smooth' });
    expect(result.current.isFollowing).toBe(true);
  });
});
