/**
 * Registry of in-flight chat runs. Lets the abort route reach a running agent
 * without the request-thread coupling. Mirrors zosma-cowork's prompt-scheduler
 * concept but in-process.
 *
 * Each thread can have at most one active run. Registering a new run for a
 * thread that already has one will replace it (the prior run gets aborted).
 */
export interface ChatRun {
  threadId: string;
  abortController: AbortController;
  startedAt: number;
}

const runs = new Map<string, ChatRun>();

export function register(threadId: string): ChatRun {
  const existing = runs.get(threadId);
  if (existing && !existing.abortController.signal.aborted) {
    // Abort the prior run before replacing
    existing.abortController.abort();
  }
  const run: ChatRun = {
    threadId,
    abortController: new AbortController(),
    startedAt: Date.now(),
  };
  runs.set(threadId, run);
  return run;
}

export function get(threadId: string): ChatRun | undefined {
  return runs.get(threadId);
}

export function unregister(threadId: string): void {
  runs.delete(threadId);
}

export function abort(threadId: string): boolean {
  const run = runs.get(threadId);
  if (!run) return false;
  run.abortController.abort();
  return true;
}

/** Number of currently tracked runs (for diagnostics). */
export function activeCount(): number {
  return runs.size;
}
