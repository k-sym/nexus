export type OperationKind =
  | 'chat_turn'
  | 'assistant_stream'
  | 'jira_sync'
  | 'github_sync'
  | 'monday_sync'
  | 'monday_write'
  | 'memory_archive'
  | 'memory_index'
  | 'mission_tick';

export type OperationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

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
