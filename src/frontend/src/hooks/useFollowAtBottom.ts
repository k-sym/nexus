import { useCallback, useEffect, useRef, useState } from 'react';

const FOLLOW_THRESHOLD_PX = 48;

function scrollLatest(container: HTMLDivElement): void {
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  } else {
    container.scrollTop = container.scrollHeight;
  }
}

export function useFollowAtBottom(contentVersion: unknown) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFollowing, setIsFollowing] = useState(true);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsFollowing(distance <= FOLLOW_THRESHOLD_PX);
  }, []);

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    setIsFollowing(true);
    scrollLatest(container);
  }, []);

  useEffect(() => {
    if (!isFollowing) return;
    const container = containerRef.current;
    if (!container) return;
    scrollLatest(container);
  }, [contentVersion, isFollowing]);

  return { containerRef, isFollowing, onScroll, jumpToLatest };
}
