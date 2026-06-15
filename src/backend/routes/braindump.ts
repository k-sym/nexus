/**
 * Braindump — free-form ideas captured before they become project tasks.
 * Mirrors the Tickets triage mechanic: an idea is triaged into a project
 * (creating a Kanban task via the existing projects route), then the idea is
 * PATCHed to status='triaged' and drops out of the active list. Triaged rows
 * are retained (not deleted) so a future "triaged history" stays possible.
 */
import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { BraindumpIdea } from '@nexus/shared';

export async function registerBraindumpRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/braindump', async () => {
    return db.prepare("SELECT * FROM braindump_ideas WHERE status = 'active' ORDER BY datetime(created_at) DESC").all() as BraindumpIdea[];
  });

  fastify.post('/api/braindump', async (request) => {
    const body = request.body as { title?: string; body?: string };
    const title = (body.title ?? '').trim();
    if (!title) {
      const err = new Error('title is required') as any;
      err.statusCode = 400;
      throw err;
    }
    const now = new Date().toISOString();
    const idea: BraindumpIdea = {
      id: uuid(),
      title,
      body: body.body ?? '',
      status: 'active',
      project_id: null,
      task_id: null,
      created_at: now,
      updated_at: now,
    };
    db.prepare('INSERT INTO braindump_ideas (id, title, body, status, project_id, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(idea.id, idea.title, idea.body, idea.status, idea.project_id, idea.task_id, idea.created_at, idea.updated_at);
    return idea;
  });

  fastify.patch('/api/braindump/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; body?: string; status?: 'active' | 'triaged'; project_id?: string; task_id?: string };

    const existing = db.prepare('SELECT * FROM braindump_ideas WHERE id = ?').get(id) as BraindumpIdea | undefined;
    if (!existing) {
      const err = new Error('Idea not found') as any;
      err.statusCode = 404;
      throw err;
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE braindump_ideas SET title = COALESCE(?, title), body = COALESCE(?, body), status = COALESCE(?, status), project_id = COALESCE(?, project_id), task_id = COALESCE(?, task_id), updated_at = ? WHERE id = ?')
      .run(body.title ?? null, body.body ?? null, body.status ?? null, body.project_id ?? null, body.task_id ?? null, now, id);
    return db.prepare('SELECT * FROM braindump_ideas WHERE id = ?').get(id) as BraindumpIdea;
  });

  fastify.delete('/api/braindump/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM braindump_ideas WHERE id = ?').run(id);
    return { success: true };
  });
}
