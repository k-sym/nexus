import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Project, Task, TaskStatus } from '@nexus/shared';
import { summarizeTaskThread } from '../memory/summarize.js';
import { insertNotification } from '../notifications/index.js';
import { detectGitRemote } from '../github/repo.js';
import { syncGitHubIssues, ensureProjectGitRemote, noteSyncError, clearSyncError } from '../github/sync.js';
import { GitHubError } from '../github/client.js';
import { loadConfig } from '../config.js';

/** Expand a leading ~ to the user's home dir; paths are stored absolute. */
function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function registerProjectRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  /** Ensure a unique project slug by appending -2, -3, … on collision. */
  function uniqueSlug(database: typeof db, base: string): string {
    let candidate = base;
    let n = 2;
    while (database.prepare('SELECT 1 FROM projects WHERE slug = ?').get(candidate)) {
      candidate = `${base}-${n++}`;
    }
    return candidate;
  }

  const listProjects = () => db.prepare(`
    SELECT
      projects.*,
      COALESCE(task_counts.count, 0) AS task_count,
      COALESCE(thread_counts.count, 0) AS chat_session_count
    FROM projects
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS count
      FROM tasks
      GROUP BY project_id
    ) AS task_counts ON task_counts.project_id = projects.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS count
      FROM chat_threads
      WHERE archived_at IS NULL
      GROUP BY project_id
    ) AS thread_counts ON thread_counts.project_id = projects.id
    ORDER BY sort_order ASC, updated_at DESC
  `).all() as Project[];

  fastify.get('/api/projects', async () => {
    const rows = listProjects();
    return rows as Project[];
  });

  fastify.put('/api/projects/order', async (request) => {
    const body = request.body as { project_ids?: string[] };
    const projectIds = body.project_ids ?? [];
    const uniqueIds = new Set(projectIds);
    if (!Array.isArray(projectIds) || projectIds.some((id) => typeof id !== 'string') || uniqueIds.size !== projectIds.length) {
      const err = new Error('project_ids must be a list of unique project IDs') as any;
      err.statusCode = 400;
      throw err;
    }

    if (projectIds.length > 0) {
      const placeholders = projectIds.map(() => '?').join(', ');
      const rows = db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).all(...projectIds) as { id: string }[];
      if (rows.length !== projectIds.length) {
        const err = new Error('Project not found') as any;
        err.statusCode = 404;
        throw err;
      }
    }

    const updateSortOrder = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?');
    db.transaction(() => {
      projectIds.forEach((id, index) => updateSortOrder.run(index, id));
    })();

    return listProjects();
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
    const repoPath = expandHome(body.repo_path);

    if (!repoPath || !fs.existsSync(repoPath)) {
      const err = new Error(`Path does not exist: ${repoPath || body.repo_path}`) as any;
      err.statusCode = 400;
      throw err;
    }

    const baseSlug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
    const slug = uniqueSlug(db, baseSlug);
    const now = new Date().toISOString();
    const nextSortOrder = ((db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM projects').get() as { next: number }).next);

    const gitRemote = await detectGitRemote(repoPath);

    const project = {
      id: uuid(),
      slug,
      name: body.name,
      description: body.description || '',
      repo_path: repoPath,
      config_json: '{}',
      sort_order: nextSortOrder,
      git_remote: gitRemote,
      created_at: now,
      updated_at: now,
    };

    db.prepare('INSERT INTO projects (id, slug, name, description, repo_path, config_json, sort_order, git_remote, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(project.id, project.slug, project.name, project.description, project.repo_path, project.config_json, project.sort_order, project.git_remote, project.created_at, project.updated_at);

    const docsDir = path.join(repoPath, 'project_docs');
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

    const repoPath = body.repo_path !== undefined ? expandHome(body.repo_path) : undefined;
    if (repoPath !== undefined && !fs.existsSync(repoPath)) {
      const err = new Error(`Path does not exist: ${repoPath}`) as any;
      err.statusCode = 400;
      throw err;
    }

    const gitRemote = repoPath !== undefined ? await detectGitRemote(repoPath) : undefined;

    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), repo_path = COALESCE(?, repo_path), config_json = COALESCE(?, config_json), git_remote = COALESCE(?, git_remote), updated_at = ? WHERE id = ?')
      .run(body.name ?? null, body.description ?? null, repoPath ?? null, body.config_json ?? null, gitRemote ?? null, now, id);

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

  fastify.post('/api/projects/:id/github/sync', async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!existing) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }
    // Honour the Settings toggle: when GitHub is disabled, sync is a no-op.
    if (!loadConfig().github.enabled) {
      return { created: 0, total: 0 };
    }
    // Self-heal projects created before remote-detection existed: an empty
    // git_remote gets detected from repo_path and persisted before syncing.
    const project = await ensureProjectGitRemote(db, existing);
    try {
      const { created, total } = await syncGitHubIssues(db, project, {
        emit: fastify.activity.bus.emit.bind(fastify.activity.bus),
      });
      clearSyncError(id);
      return { created, total };
    } catch (err) {
      if (err instanceof GitHubError) {
        // Only notify when this error differs from the last one we surfaced for
        // this project — otherwise a private repo without a token would spam an
        // identical toast on every Kanban open.
        if (noteSyncError(id, err.message)) {
          insertNotification(db, {
            level: 'error',
            title: 'GitHub sync failed',
            message: `${project.name}: ${err.message}`,
          });
        }
        return { created: 0, total: 0 };
      }
      throw err;
    }
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
    const body = request.body as {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: string;
      assigned_agent?: string;
      due_date?: string;
      model_key?: string;
      thread_id?: string;
    };

    const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
    if (!existing) {
      const err = new Error('Task not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), priority = COALESCE(?, priority), assigned_agent = COALESCE(?, assigned_agent), due_date = COALESCE(?, due_date), model_key = COALESCE(?, model_key), thread_id = COALESCE(?, thread_id), updated_at = ? WHERE id = ?')
      .run(body.title, body.description, body.status, body.priority, body.assigned_agent, body.due_date, body.model_key, body.thread_id, now, id);

    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, existing.project_id);

    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task;

    // Summarize a completed task-chat into memory + Obsidian when its card is
    // advanced into Review/Deploy. Fires only on the transition *into* a done
    // state (so Review→Deploy doesn't re-summarize), and only for thread-linked
    // tasks. Best-effort and fire-and-forget so the move stays responsive.
    const DONE: TaskStatus[] = ['review', 'deploy'];
    const crossedIntoDone =
      body.status != null &&
      DONE.includes(body.status) &&
      !DONE.includes(existing.status) &&
      !!updated.thread_id;
    if (crossedIntoDone) {
      void summarizeTaskThread(db, fastify.pi, updated)
        .then((wrote) => {
          if (wrote) {
            insertNotification(db, {
              level: 'info',
              title: 'Task summarized',
              message: `"${updated.title}" was summarized into project memory.`,
            });
          }
        })
        .catch((err) => console.error('[summarize] task summary failed:', err?.message));
    }

    return updated;
  });

  fastify.delete('/api/tasks/:id', async (request) => {
    const { id } = request.params as { id: string };
    db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    return { success: true };
  });
}
