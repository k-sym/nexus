/**
 * Poll helpers that hand React the *previous* value back when a fresh fetch
 * carries nothing new. Every poll in App used to store a brand-new Set/array
 * regardless, so ChatPanel and everything under it re-rendered on each tick
 * even when the world had not changed. Use these inside functional setState.
 */

export function keepIfSameSet<T>(prev: Set<T>, next: Set<T>): Set<T> {
  if (prev === next) return prev;
  if (prev.size !== next.size) return next;
  for (const item of next) {
    if (!prev.has(item)) return next;
  }
  return prev;
}

/** Cheap structural equality for small, plain poll payloads. */
export function keepIfSameJson<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
