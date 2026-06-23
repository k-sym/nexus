import { randomUUID } from 'crypto';
import type { MissionHandler } from '../types';

interface TicketRow { key: string; summary: string; priority: string | null; }

/**
 * For each Jira/GitHub ticket not yet mirrored into a task for this project,
 * create a `triage` task. Dedupes via (external_source='ticket', external_id=ticket.key).
 * Reports drained=true when nothing remains, so backlog_drain pacing terminates.
 *
 * Note: tickets table is global (no project_id column); dedup is scoped per-project via tasks.
 */
export const triageTicketsHandler: MissionHandler = async (ctx) => {
  const { db, mission } = ctx;
  let config: { assignee?: string; max_per_run?: number } = {};
  try { config = JSON.parse(mission.config_json || '{}'); } catch { /* fall back to defaults */ }
  const limit = config.max_per_run ?? 20;

  const params: unknown[] = [mission.project_id];
  let assigneeClause = '';
  if (config.assignee) { assigneeClause = ' AND assignee = ?'; params.push(config.assignee); }
  params.push(limit);

  const pending = db.prepare(`
    SELECT key, summary, priority FROM tickets
    WHERE key NOT IN (
      SELECT external_id FROM tasks WHERE project_id = ? AND external_source = 'ticket' AND external_id IS NOT NULL
    )${assigneeClause}
    ORDER BY synced_at DESC LIMIT ?
  `).all(...params) as TicketRow[];

  if (pending.length === 0) {
    return { status: 'succeeded', summary: 'no un-triaged tickets', selectedWork: [], drained: true, tokensUsed: 0 };
  }

  const now = new Date().toISOString();
  // tasks schema: id, project_id, title, description, status, priority, assigned_agent,
  //   due_date, thread_id, external_source, external_id, created_at, updated_at
  // NOTE: tasks has NO model_key column — omitted vs the original brief.
  const insert = db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_agent, due_date,
      thread_id, external_source, external_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'triage', ?, NULL, NULL, NULL, 'ticket', ?, ?, ?)
  `);
  const priorityMap = (p: string | null) => (p && /high|highest|urgent/i.test(p) ? 'high' : 'medium');
  const created: string[] = [];
  const tx = db.transaction((rows: TicketRow[]) => {
    for (const t of rows) {
      insert.run(randomUUID(), mission.project_id, t.summary || t.key, `From ticket ${t.key}`, priorityMap(t.priority), t.key, now, now);
      created.push(t.key);
    }
  });
  tx(pending);

  return {
    status: 'succeeded',
    intent: `Triage ${created.length} ticket(s) into tasks`,
    selectedWork: created,
    summary: `Created ${created.length} triage task(s): ${created.join(', ')}`,
    drained: false,
    tokensUsed: 0,
  };
};
