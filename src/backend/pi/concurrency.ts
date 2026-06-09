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
  private readonly active = new Map<string, ActiveRun>();

  private key(projectId: string, modelKey: string): string {
    return `${projectId}::${modelKey || 'default'}`;
  }

  set(projectId: string, modelKey: string, threadId: string, title: string): void {
    this.active.set(this.key(projectId, modelKey), { threadId, title, modelKey });
  }

  get(projectId: string, modelKey: string): ActiveRun | undefined {
    return this.active.get(this.key(projectId, modelKey));
  }

  clear(projectId: string, modelKey: string): void {
    this.active.delete(this.key(projectId, modelKey));
  }
}
