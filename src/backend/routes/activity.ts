import { FastifyInstance } from 'fastify';
import {
  OPERATION_KINDS,
  OPERATION_STATUSES,
  type OperationKind,
  type OperationStatus,
} from '../activity/events.js';

const VALID_KINDS: readonly OperationKind[] = OPERATION_KINDS;
const VALID_STATUSES: readonly OperationStatus[] = OPERATION_STATUSES;

export async function registerActivityRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const activity = fastify.activity;

  fastify.get('/api/activity', async (request) => {
    const query = request.query as { status?: string; kind?: string; limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const kindFilter = VALID_KINDS.includes(query.kind as OperationKind) ? (query.kind as OperationKind) : undefined;
    const statusFilter = VALID_STATUSES.includes(query.status as OperationStatus)
      ? (query.status as OperationStatus)
      : undefined;

    const runningParams: (string | number)[] = [];
    let runningWhere = '';
    if (kindFilter) {
      runningWhere += ' AND kind = ?';
      runningParams.push(kindFilter);
    }
    const runningRows =
      !statusFilter || statusFilter === 'running'
        ? (db
            .prepare(`SELECT * FROM operations WHERE status = 'running'${runningWhere} ORDER BY started_at DESC LIMIT ?`)
            .all(...runningParams, limit) as any[])
        : [];

    const running = runningRows.map((row) => enrichRunning(row, activity));

    const recentParams: (string | number)[] = [];
    let recentWhere = '';
    if (kindFilter) {
      recentWhere += ' AND kind = ?';
      recentParams.push(kindFilter);
    }
    if (statusFilter === 'running') {
      recentWhere += ' AND 0';
    } else if (statusFilter) {
      recentWhere += ' AND status = ?';
      recentParams.push(statusFilter);
    } else {
      recentWhere += " AND status <> 'running'";
    }
    const recentRows = db
      .prepare(`SELECT * FROM operations WHERE 1=1${recentWhere} ORDER BY started_at DESC LIMIT ?`)
      .all(...recentParams, limit) as any[];

    const countParams: string[] = [];
    let countWhere = 'WHERE 1=1';
    if (kindFilter) {
      countWhere += ' AND kind = ?';
      countParams.push(kindFilter);
    }
    if (statusFilter) {
      countWhere += ' AND status = ?';
      countParams.push(statusFilter);
    }
    const counts = db
      .prepare(`SELECT status, COUNT(*) AS count FROM operations ${countWhere} GROUP BY status`)
      .all(...countParams) as { status: string; count: number }[];

    return {
      running,
      recent: recentRows.map(enrichRow),
      counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
    };
  });

  fastify.get('/api/activity/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return enrichRow(row);
  });

  fastify.get('/api/activity/:id/diagnostics', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db
      .prepare('SELECT diagnostics_json, last_event, error FROM operations WHERE id = ?')
      .get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return {
      diagnostics: parseJson(row.diagnostics_json),
      lastEvent: row.last_event,
      error: row.error,
    };
  });

  fastify.post('/api/activity/:id/abort', async (request, reply) => {
    const { id } = request.params as { id: string };
    const runningOp = activity.getRunning().find((r) => r.id === id);
    const row = runningOp
      ? (db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any)
      : undefined;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    const kind = row.kind;
    if (kind === 'chat_turn' && row.thread_id) {
      const existing = fastify.activeChatStreams?.get(row.thread_id);
      if (existing) {
        await existing.session.abort();
      }
      return { ok: true };
    }
    if (kind === 'assistant_stream') {
      const res = await fastify.inject({ method: 'POST', url: '/api/assistant/abort' });
      return res.json();
    }
    reply.code(409);
    return { error: `Abort not supported for ${kind}` };
  });

  fastify.post('/api/activity/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as any;
    if (!row) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    if (row.kind === 'memory_archive' && row.thread_id) {
      const res = await fastify.inject({ method: 'POST', url: `/api/threads/${row.thread_id}/archive` });
      return res.json();
    }
    if (row.kind === 'jira_sync') {
      const res = await fastify.inject({
        method: 'POST',
        url: '/api/jira/sync',
        payload: { replaceAll: true },
      });
      return res.json();
    }
    if (row.kind === 'github_sync' && row.project_id) {
      const res = await fastify.inject({
        method: 'POST',
        url: `/api/projects/${row.project_id}/github/sync`,
      });
      return res.json();
    }
    reply.code(409);
    return { error: `Retry not supported for ${row.kind}` };
  });
}

function enrichRunning(row: any, activity: any) {
  const started = activity.getRunning().find((r: any) => r.id === row.id)?.startedAt;
  const durationMs = started ? Date.now() - started : row.duration_ms;
  return { ...enrichRow(row), duration_ms: durationMs };
}

function enrichRow(row: any) {
  return {
    ...row,
    usage: parseJson(row.usage_json),
    diagnostics: parseJson(row.diagnostics_json),
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
