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
 *
 * ## Project-wide claims (repo-mutation safety)
 *
 * On top of the per-(project,model) slots above, the tracker also guards a
 * **project-wide** slot. Any agent that mutates a repo's working tree
 * (an `assistant_turn` mission, or a chat turn that may edit files / commit)
 * must hold the project-wide slot for that project, so two agents never race
 * on the same working tree regardless of which model each uses.
 *
 * Acquisition order to avoid deadlock: **project-wide first, then
 * per-(project,model)**. Release in reverse. A holder of only a per-model
 * slot never blocks a project-wide claimant from acquiring the project slot
 * because the project slot is a separate map; the ordering rule only
 * matters for a single caller that acquires both — and only chat does.
 */
export interface ActiveRun {
  threadId: string;
  title: string;
  modelKey: string;
}

export interface ProjectRun {
  threadId: string;
  title: string;
  /** Marker so the project-wide slot can be distinguished from a per-model run. */
  scope: 'project';
}

export class ConcurrencyTracker {
  private readonly active = new Map<string, ActiveRun & { owner: symbol }>();
  private readonly projectActive = new Map<string, ProjectRun & { owner: symbol }>();
  private readonly observedOwners = new WeakMap<ActiveRun, symbol>();
  private readonly observedProjectOwners = new WeakMap<ProjectRun, symbol>();
  private readonly releaseWaiters = new Map<string, Set<() => void>>();
  private readonly projectReleaseWaiters = new Map<string, Set<() => void>>();

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

  // ── Project-wide claims ───────────────────────────────────────────────────

  /**
   * Claim the project-wide slot for `projectId`. Returns a symbol owner on
   * success, or `undefined` if another agent already holds the project slot.
   *
   * Callers that also acquire a per-(project,model) slot MUST acquire the
   * project-wide slot first to avoid deadlock.
   */
  claimProject(projectId: string, threadId: string, title: string): symbol | undefined {
    if (this.projectActive.has(projectId)) return undefined;
    const owner = Symbol(`project:${projectId}:${threadId}`);
    this.projectActive.set(projectId, { owner, threadId, title, scope: 'project' });
    return owner;
  }

  /**
   * Read the project-wide holder, if any. Returns a fresh object whose
   * identity is tracked via `observedProjectOwners` so `waitForProjectRelease`
   * can match it.
   */
  getProject(projectId: string): ProjectRun | undefined {
    const run = this.projectActive.get(projectId);
    if (!run) return undefined;
    const observed: ProjectRun = { threadId: run.threadId, title: run.title, scope: 'project' };
    this.observedProjectOwners.set(observed, run.owner);
    return observed;
  }

  releaseProject(projectId: string, owner: symbol): boolean {
    const run = this.projectActive.get(projectId);
    if (!run || run.owner !== owner) return false;
    this.projectActive.delete(projectId);
    for (const resolve of this.projectReleaseWaiters.get(projectId) ?? []) resolve();
    this.projectReleaseWaiters.delete(projectId);
    return true;
  }

  async waitForProjectRelease(projectId: string, observed: ProjectRun, timeoutMs: number): Promise<boolean> {
    const observedOwner = this.observedProjectOwners.get(observed);
    const matchesObserved = () => {
      const current = this.projectActive.get(projectId);
      return observedOwner
        ? current?.owner === observedOwner
        : current?.threadId === observed.threadId && current.title === observed.title;
    };
    if (!matchesObserved()) return true;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (released: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const waiters = this.projectReleaseWaiters.get(projectId);
        waiters?.delete(onRelease);
        if (waiters?.size === 0) this.projectReleaseWaiters.delete(projectId);
        resolve(released);
      };
      const onRelease = () => finish(true);
      const timeout = setTimeout(() => finish(!matchesObserved()), timeoutMs);
      const waiters = this.projectReleaseWaiters.get(projectId) ?? new Set<() => void>();
      waiters.add(onRelease);
      this.projectReleaseWaiters.set(projectId, waiters);

      // Recheck after subscribing so a release between the first check and
      // waiter registration cannot strand this waiter until the timeout.
      if (!matchesObserved()) finish(true);
    });
  }
}
