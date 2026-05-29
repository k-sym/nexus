import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Project, Task, TaskStatus } from '@nexus/shared';

export async function registerProjectRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/projects', async () => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
    return rows as Project[];
  });

  fastify.get('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!row) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }
    return row as Project;
  });

  fastify.post('/api/projects', async (request) => {
    const body = request.body as { name: string; description?: string; repo_path: string };

    if (!fs.existsSync(body.repo_path)) {
      const err = new Error(`Path does not exist: ${body.repo_path}`) as any;
      err.statusCode = 400;
      throw err;
    }

    const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const now = new Date().toISOString();

    const project: Project = {
      id: uuid(),
      slug,
      name: body.name,
      description: body.description || '',
      repo_path: body.repo_path,
      config_json: '{}',
      created_at: now,
      updated_at: now,
    };

    db.prepare('INSERT INTO projects (id, slug, name, description, repo_path, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.slug, project.name, project.description, project.repo_path, project.config_json, project.created_at, project.updated_at);

    const docsDir = path.join(body.repo_path, 'project_docs');
    for (const sub of ['specs', 'plans', 'uploads']) {
      const dir = path.join(docsDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    return project;
  });

  fastify.put('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; description?: string; repo_path?: string; config_json?: string };

    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    if (!existing) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), repo_path = COALESCE(?, repo_path), config_json = COALESCE(?, config_json), updated_at = ? WHERE id = ?')
      .run(body.name, body.description, body.repo_path, body.config_json, now, id);

    return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  });

  fastify.delete('/api/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return { success: true };
  });

  fastify.get('/api/projects/:id/tasks', async (request) => {
    const { id } = request.params as { id: string };
    const rows = db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC').all(id);
    return rows as Task[];
  });

  fastify.post('/api/projects/:id/tasks', async (request) => {
    const { id: project_id } = request.params as { id: string };
    const body = request.body as { title: string; description?: string; status?: TaskStatus; priority?: string; assigned_agent?: string; due_date?: string };

    const now = new Date().toISOString();
    const task = {
      id: uuid(),
      project_id,
      title: body.title,
      description: body.description || '',
      status: body.status || 'triage',
      priority: body.priority || 'medium',
      assigned_agent: body.assigned_agent || null,
      due_date: body.due_date || null,
      created_at: now,
      updated_at: now,
    };

    db.prepare('INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_agent, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.project_id, task.title, task.description, task.status, task.priority, task.assigned_agent, task.due_date, task.created_at, task.updated_at);

    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, project_id);

    return task;
  });

  fastify.put('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; description?: string; status?: TaskStatus; priority?: string; assigned_agent?: string; due_date?: string };

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!existing) {
      const err = new Error('Task not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), priority = COALESCE(?, priority), assigned_agent = COALESCE(?, assigned_agent), due_date = COALESCE(?, due_date), updated_at = ? WHERE id = ?')
      .run(body.title, body.description, body.status, body.priority, body.assigned_agent, body.due_date, now, id);

    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, (existing as any).project_id);

    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  });

  fastify.delete('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { success: true };
  });
}
