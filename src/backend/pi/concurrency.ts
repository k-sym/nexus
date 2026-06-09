/**
 * Per-project active-run tracker.
 *
 * The pi runtime serializes prompts at the runtime level, but Nexus's UX
 * surfaces conflicts at the *project* level. This in-memory map records
 * which thread is mid-run for each project; routes check it before starting
 * a new prompt and return 409 if the project is busy.
 *
 * State is lost on backend restart — by design. A restart shouldn't keep
 * a project "permanently busy".
 */
export interface ActiveRun {
  threadId: string;
  title: string;
}

export class ConcurrencyTracker {
  private readonly active = new Map<string, ActiveRun>();

  set(projectId: string, threadId: string, title: string): void {
    this.active.set(projectId, { threadId, title });
  }

  get(projectId: string): ActiveRun | undefined {
    return this.active.get(projectId);
  }

  clear(projectId: string): void {
    this.active.delete(projectId);
  }
}
