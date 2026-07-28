/**
 * Per-project active-run tracker.
 *
 * Chat context is isolated by Pi session (`threadId + cwd`), so the selected
 * model is not a shared resource and must not be used as a concurrency key.
 *
 * The project working tree is shared, however. Chat turns and autonomous
 * missions can both mutate it, so only one run may own a project at a time.
 * The source is retained so callers can distinguish a cancellable chat run
 * from an autonomous mission and present an accurate explanation.
 *
 * State is lost on backend restart by design. A restart should never leave a
 * project permanently busy.
 */
export type ProjectRunSource = 'chat' | 'mission';

export interface ProjectRun {
  threadId: string;
  title: string;
  scope: 'project';
  source: ProjectRunSource;
  /** Present for chat runs; missions resolve their model inside the session. */
  modelKey?: string;
}

export class ConcurrencyTracker {
  private readonly projectActive = new Map<string, ProjectRun & { owner: symbol }>();
  private readonly observedProjectOwners = new WeakMap<ProjectRun, symbol>();
  private readonly projectReleaseWaiters = new Map<string, Set<() => void>>();

  /**
   * Claim the shared working tree for `projectId`. Returns an owner token on
   * success, or `undefined` if another run already owns the project.
   */
  claimProject(
    projectId: string,
    threadId: string,
    title: string,
    source: ProjectRunSource,
    modelKey?: string,
  ): symbol | undefined {
    if (this.projectActive.has(projectId)) return undefined;
    const owner = Symbol(`project:${projectId}:${threadId}`);
    this.projectActive.set(projectId, {
      owner,
      threadId,
      title,
      scope: 'project',
      source,
      ...(modelKey ? { modelKey } : {}),
    });
    return owner;
  }

  /**
   * Read the current project holder. The fresh object's identity is associated
   * with its private owner token so waitForProjectRelease can distinguish a
   * replacement run from the run the caller originally observed.
   */
  getProject(projectId: string): ProjectRun | undefined {
    const run = this.projectActive.get(projectId);
    if (!run) return undefined;
    const observed: ProjectRun = {
      threadId: run.threadId,
      title: run.title,
      scope: 'project',
      source: run.source,
      ...(run.modelKey ? { modelKey: run.modelKey } : {}),
    };
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
        : current?.threadId === observed.threadId
          && current.title === observed.title
          && current.source === observed.source
          && current.modelKey === observed.modelKey;
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
