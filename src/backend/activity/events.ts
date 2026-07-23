// Operation kinds/statuses are declared in @nexus/shared so the frontend
// validates against the same list; re-exported here because backend callers
// have always imported them from this module.
export {
  OPERATION_KINDS,
  OPERATION_STATUSES,
  type OperationKind,
  type OperationStatus,
} from '@nexus/shared';
import type { OperationKind, OperationStatus } from '@nexus/shared';

export interface ActivityEvent {
  type: 'start' | 'update' | 'stop';
  operationId: string;
  kind: OperationKind;
  title: string;
  projectId?: string | null;
  taskId?: string | null;
  threadId?: string | null;
  provider?: string | null;
  model?: string | null;
  status?: OperationStatus;
  durationMs?: number;
  usage?: unknown;
  lastEvent?: string;
  error?: string;
  diagnostics?: unknown;
}

export type ActivityListener = (event: ActivityEvent) => void;

export class ActivityBus {
  private listeners: ActivityListener[] = [];

  subscribe(listener: ActivityListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  emit(event: ActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[activity] listener failed:', err);
      }
    }
  }
}
