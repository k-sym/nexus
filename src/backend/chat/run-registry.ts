/**
 * The set of threads with an active run, as one importable singleton.
 *
 * routes/chat.ts owns the claim/release pair that decides whether a thread is
 * busy; it mirrors every claim here so other modules (the board's lane
 * derivation, the Monday roll-up's derived statuses) can ask "is this thread
 * running?" without reaching into the chat routes' closure. Listeners fire on
 * every transition so Monday can react to a run ending without the chat stream
 * knowing Monday exists (#439).
 */
export interface RunMeta {
  title: string;
  modelKey: string;
}

export type RunListener = (threadId: string, running: boolean, meta: RunMeta) => void;

const running = new Map<string, RunMeta>();
const listeners = new Set<RunListener>();

function notify(threadId: string, isRunning: boolean, meta: RunMeta): void {
  for (const listener of listeners) {
    try {
      listener(threadId, isRunning, meta);
    } catch (err) {
      console.error('[run-registry] listener failed:', (err as Error)?.message ?? err);
    }
  }
}

export function markRunning(threadId: string, meta: RunMeta): void {
  running.set(threadId, meta);
  notify(threadId, true, meta);
}

export function markStopped(threadId: string): void {
  const meta = running.get(threadId);
  if (!meta) return;
  running.delete(threadId);
  notify(threadId, false, meta);
}

export function isRunning(threadId: string): boolean {
  return running.has(threadId);
}

export function runningThreadIds(): Set<string> {
  return new Set(running.keys());
}

/** Subscribe to start/stop transitions. Returns the unsubscribe function. */
export function onRunChange(listener: RunListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test helper: forget every run and listener. */
export function __resetRunRegistry(): void {
  running.clear();
  listeners.clear();
}
