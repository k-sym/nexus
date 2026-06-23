import type { MissionHandler } from '../types';

interface TaskRow { id: string; title: string; updated_at: string; }

export const reviewStaleTasksHandler: MissionHandler = async (ctx) => {
  const { db, mission } = ctx;
  const config = JSON.parse(mission.config_json || '{}') as { stale_days?: number; statuses?: string[] };
  const staleDays = config.stale_days ?? 3;
  const statuses = config.statuses ?? ['in_progress', 'review'];
  const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();

  const placeholders = statuses.map(() => '?').join(', ');
  const rows = db.prepare(
    `SELECT id, title, updated_at FROM tasks
     WHERE project_id = ? AND status IN (${placeholders}) AND updated_at < ?
     ORDER BY updated_at ASC`
  ).all(mission.project_id, ...statuses, cutoff) as TaskRow[];

  const ids = rows.map((r) => r.id);
  const summary = ids.length === 0
    ? 'No stale tasks.'
    : `${ids.length} stale task(s) need attention: ${rows.map((r) => r.title).join('; ')}`;

  return { status: 'succeeded', intent: `Review tasks idle > ${staleDays}d`, selectedWork: ids, summary, tokensUsed: 0 };
};
