/**
 * Per-project-model active-run tracker.
 *
 * Allows multiple threads in the same project to stream simultaneously,
 * but prevents two threads using the same model in the same project from
 * streaming at the same time. This keeps history/log tracking clean:
 * project + model = unique chat context.
 *
 * Key format: `${projectId}::${modelKey}`
 *
 * State is lost on backend restart — by design. A restart shouldn't keep
 * a slot "permanently busy".
 */
export interface ActiveRun {
  threadId: string;
  title: string;
  modelKey: string;
}

export class ConcurrencyTracker {
  private readonly active = new Map<string, ActiveRun & { owner: symbol }>();
  private readonly observedOwners = new WeakMap<ActiveRun, symbol>();
  private readonly releaseWaiters = new Map<string, Set<() => void>>();

  private key(projectId: string, modelKey: string): string {
    return `${projectId}::${modelKey || 'default'}`;
  }

  claim(projectId: string, modelKey: string, threadId: string, title: string): symbol | undefined {
    const key = this.key(projectId, modelKey);
    if (this.active.has(key)) return undefined;
    const owner = Symbol(`${projectId}:${modelKey}:${threadId}`);
    this.active.set(key, { owner, threadId, title, modelKey });
    return owner;
  }

  get(projectId: string, modelKey: string): ActiveRun | undefined {
    const run = this.active.get(this.key(projectId, modelKey));
    if (!run) return undefined;
    const observed = { threadId: run.threadId, title: run.title, modelKey: run.modelKey };
    this.observedOwners.set(observed, run.owner);
    return observed;
  }

  release(projectId: string, modelKey: string, owner: symbol): boolean {
    const key = this.key(projectId, modelKey);
    if (this.active.get(key)?.owner !== owner) return false;
    this.active.delete(key);
    for (const resolve of this.releaseWaiters.get(key) ?? []) resolve();
    this.releaseWaiters.delete(key);
    return true;
  }

  async waitForRelease(projectId: string, modelKey: string, observed: ActiveRun, timeoutMs: number): Promise<boolean> {
    const key = this.key(projectId, modelKey);
    const observedOwner = this.observedOwners.get(observed);
    const matchesObserved = () => {
      const current = this.active.get(key);
      return observedOwner
        ? current?.owner === observedOwner
        : current?.threadId === observed.threadId
          && current.title === observed.title
          && current.modelKey === observed.modelKey;
    };
    if (!matchesObserved()) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (released: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const waiters = this.releaseWaiters.get(key);
        waiters?.delete(onRelease);
        if (waiters?.size === 0) this.releaseWaiters.delete(key);
        resolve(released);
      };
      const onRelease = () => finish(true);
      const timeout = setTimeout(() => finish(!matchesObserved()), timeoutMs);
      const waiters = this.releaseWaiters.get(key) ?? new Set<() => void>();
      waiters.add(onRelease);
      this.releaseWaiters.set(key, waiters);

      // Recheck after subscribing so a release between the first check and
      // waiter registration cannot strand this waiter until the timeout.
      if (!matchesObserved()) finish(true);
    });
  }
}
