import type { FastifyInstance } from 'fastify';
import { APPROVAL_DECISION_CUSTOM_TYPE, type RoleChildRun, type RoleChildRunRecord } from '@nexus/shared';
import { flattenEntries } from './chat.js';

interface RoleRunRow {
  id: string; parent_run_id: string; parent_tool_call_id: string; thread_id: string;
  role: RoleChildRun['role']; model_key: string;
  status: RoleChildRun['status']; tokens: number | null; duration_ms: number | null;
  report: string | null; started_at: string; completed_at: string | null; repo_path?: string | null;
}

function toChild(row: RoleRunRow): RoleChildRun {
  return { childRunId: row.id, role: row.role, model: row.model_key, status: row.status,
    tokens: row.tokens ?? 0, durationMs: row.duration_ms ?? 0, report: row.report ?? '' };
}

export async function registerRoleRunRoutes(fastify: FastifyInstance) {
  const { db, pi } = fastify;
  fastify.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const row = db.prepare(`SELECT r.*, p.repo_path FROM role_runs r
      JOIN chat_threads t ON t.id = r.thread_id JOIN projects p ON p.id = t.project_id
      WHERE r.id = ?`).get(id) as RoleRunRow | undefined;
    if (!row) return reply.code(404).send({ error: 'Child run not found' });
    const child = toChild(row);
    if (!row.repo_path) return { child, messages: [], transcriptAvailable: false };
    const entries = await pi.readMessages(row.id, row.repo_path);
    const parentEntries = await pi.readMessages(row.thread_id, row.repo_path);
    const decisions = (parentEntries as any[]).filter(e => e.type === 'custom' && e.customType === APPROVAL_DECISION_CUSTOM_TYPE && e.data?.childRunId === row.id);
    const messages = flattenEntries([...entries, ...decisions], row.repo_path) as Array<{ tool_calls?: Array<{ status: string }> }>;
    if (child.status === 'running') {
      for (const message of messages) for (const tool of message.tool_calls ?? []) {
        if (tool.status === 'interrupted') tool.status = 'running';
      }
    }
    return { child, messages, transcriptAvailable: entries.length > 0 };
  });

  /** Every role child run of a thread, newest first: the session drawer's Sub-agents tab. */
  fastify.get('/api/threads/:threadId/runs', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    if (!db.prepare('SELECT id FROM chat_threads WHERE id = ?').get(threadId)) return reply.code(404).send({ error: 'Thread not found' });
    const rows = db.prepare('SELECT * FROM role_runs WHERE thread_id = ? ORDER BY started_at DESC, rowid DESC').all(threadId) as RoleRunRow[];
    const runs: RoleChildRunRecord[] = rows.map(row => ({ ...toChild(row),
      parentRunId: row.parent_run_id, parentToolCallId: row.parent_tool_call_id, startedAt: row.started_at, completedAt: row.completed_at }));
    return { runs };
  });
}
