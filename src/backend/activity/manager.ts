import type Database from 'better-sqlite3';
import { ActivityBus, ActivityEvent, OperationKind } from './events.js';

export interface RunningOperation {
  id: string;
  kind: OperationKind;
  startedAt: number;
}

export class ActivityManager {
  readonly bus = new ActivityBus();
  private readonly running = new Map<string, RunningOperation>();
  private readonly insert: Database.Statement;
  private readonly update: Database.Statement;
  private readonly finish: Database.Statement;
  private readonly sweep: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insert = db.prepare(
      `INSERT INTO operations (id, kind, status, title, project_id, task_id, thread_id, provider, model, started_at, usage_json, last_event, error, diagnostics_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.update = db.prepare(
      `UPDATE operations SET usage_json = ?, last_event = ?, error = ?, diagnostics_json = ? WHERE id = ?`,
    );
    // finish is built dynamically in handleStop so unspecified fields are preserved.
    this.sweep = db.prepare(
      `UPDATE operations SET status = 'cancelled', completed_at = ?, duration_ms = COALESCE(duration_ms, 0), error = COALESCE(error, '') || ' · process restarted' WHERE status = 'running'`,
    );
  }

  startListening(): () => void {
    this.sweepRunning();
    return this.bus.subscribe((event) => this.handleEvent(event));
  }

  private sweepRunning(): void {
    const now = new Date().toISOString();
    this.sweep.run(now);
  }

  private handleEvent(event: ActivityEvent): void {
    try {
      if (event.type === 'start') this.handleStart(event);
      else if (event.type === 'update') this.handleUpdate(event);
      else if (event.type === 'stop') this.handleStop(event);
    } catch (err) {
      console.error('[activity] failed to handle event:', err);
    }
  }

  private handleStart(event: ActivityEvent): void {
    const now = new Date().toISOString();
    this.insert.run(
      event.operationId,
      event.kind,
      'running',
      event.title,
      event.projectId ?? null,
      event.taskId ?? null,
      event.threadId ?? null,
      event.provider ?? null,
      event.model ?? null,
      now,
      event.usage ? JSON.stringify(event.usage) : null,
      event.lastEvent ?? null,
      event.error ?? null,
      event.diagnostics ? JSON.stringify(event.diagnostics) : null,
    );
    this.running.set(event.operationId, { id: event.operationId, kind: event.kind, startedAt: Date.now() });
  }

  private handleUpdate(event: ActivityEvent): void {
    this.update.run(
      event.usage ? JSON.stringify(event.usage) : null,
      event.lastEvent ?? null,
      event.error ?? null,
      event.diagnostics ? JSON.stringify(event.diagnostics) : null,
      event.operationId,
    );
  }

  private handleStop(event: ActivityEvent): void {
    const started = this.running.get(event.operationId)?.startedAt;
    const durationMs = started ? Date.now() - started : event.durationMs ?? 0;
    const now = new Date().toISOString();

    const fields: string[] = ['status = ?', 'completed_at = ?', 'duration_ms = ?'];
    const params: (string | number | null)[] = [event.status ?? 'succeeded', now, durationMs];

    if (event.usage !== undefined) {
      fields.push('usage_json = ?');
      params.push(event.usage ? JSON.stringify(event.usage) : null);
    }
    if (event.lastEvent !== undefined) {
      fields.push('last_event = ?');
      params.push(event.lastEvent ?? null);
    }
    if (event.error !== undefined) {
      fields.push('error = ?');
      params.push(event.error ?? null);
    }
    if (event.diagnostics !== undefined) {
      fields.push('diagnostics_json = ?');
      params.push(event.diagnostics ? JSON.stringify(event.diagnostics) : null);
    }
    params.push(event.operationId);

    this.db.prepare(`UPDATE operations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    this.running.delete(event.operationId);
  }

  getRunning(): RunningOperation[] {
    return Array.from(this.running.values());
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }
}
