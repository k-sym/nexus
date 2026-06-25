import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Project, Task, TaskStatus, type ReviewActionRequest, type ReviewActionResult } from '@nexus/shared';
import { buildReviewActionPrompt, buildReviewActionTitle, getProjectGitDiff, reviewActionPlan } from '../git/diff.js';
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

const TEXT_PREVIEW_BYTES = 512 * 1024;
const BINARY_PREVIEW_BYTES = 8 * 1024 * 1024;

type FilePreviewKind = 'text' | 'image' | 'pdf' | 'unsupported';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

function mimeTypeFor(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function previewKindFor(mimeType: string): FilePreviewKind {
  if (mimeType.startsWith('text/') || ['application/json', 'application/yaml'].includes(mimeType)) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'unsupported';
}

function requestedFilePath(rawPath: string): string {
  if (rawPath.startsWith('file://')) return fileURLToPath(rawPath);
  return rawPath;
}

function resolveProjectFile(project: Project, rawPath: string): { filePath: string; stat: fs.Stats } {
  const projectRoot = fs.realpathSync(path.resolve(expandHome(project.repo_path)));
  const requestPath = requestedFilePath(rawPath);
  const requested = path.resolve(path.isAbsolute(requestPath) ? requestPath : path.join(projectRoot, requestPath));
  if (!fs.existsSync(requested)) {
    const err = new Error('File not found') as any;
    err.statusCode = 404;
    throw err;
  }
  const filePath = fs.realpathSync(requested);
  const insideProject = filePath === projectRoot || filePath.startsWith(`${projectRoot}${path.sep}`);
  if (!insideProject) {
    const err = new Error('File must be inside the project directory') as any;
    err.statusCode = 403;
    throw err;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    const err = new Error('Path is not a file') as any;
    err.statusCode = 400;
    throw err;
  }
  return { filePath, stat };
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

  fastify.get('/api/projects/:id/files/preview', async (request) => {
    const { id } = request.params as { id: string };
    const { path: rawPath } = request.query as { path?: string };
    if (!rawPath) {
      const err = new Error('path is required') as any;
      err.statusCode = 400;
      throw err;
    }
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!project) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const { filePath, stat } = resolveProjectFile(project, rawPath);
    const mimeType = mimeTypeFor(filePath);
    const kind = previewKindFor(mimeType);
    const base = {
      path: filePath,
      name: path.basename(filePath),
      mimeType,
      kind,
      size: stat.size,
    };

    if (kind === 'text') {
      if (stat.size > TEXT_PREVIEW_BYTES) return { ...base, kind: 'unsupported', reason: 'File is too large to preview inline' };
      return { ...base, content: fs.readFileSync(filePath, 'utf8') };
    }
    if (kind === 'image') {
      if (stat.size > BINARY_PREVIEW_BYTES) return { ...base, kind: 'unsupported', reason: 'Image is too large to preview inline' };
      return { ...base, data: fs.readFileSync(filePath).toString('base64') };
    }
    if (kind === 'pdf') {
      return {
        ...base,
        url: `/api/projects/${encodeURIComponent(id)}/files/raw?path=${encodeURIComponent(filePath)}`,
      };
    }
    return base;
  });

  fastify.get('/api/projects/:id/files/raw', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { path: rawPath } = request.query as { path?: string };
    if (!rawPath) {
      const err = new Error('path is required') as any;
      err.statusCode = 400;
      throw err;
    }
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!project) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }
    const { filePath } = resolveProjectFile(project, rawPath);
    reply.type(mimeTypeFor(filePath));
    return fs.readFileSync(filePath);
  });

  fastify.get('/api/projects/:id/git/diff', async (request) => {
    const { id } = request.params as { id: string };
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
    if (!row) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }
    return await getProjectGitDiff(row);
  });

  fastify.post('/api/projects/:id/review-actions', async (request) => {
    const { id: projectId } = request.params as { id: string };
    const body = request.body as ReviewActionRequest;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Project | undefined;
    if (!project) {
      const err = new Error('Project not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const diff = await getProjectGitDiff(project);
    if (!diff.ok) return diff;

    const sourceTask = body.task_id
      ? (db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(body.task_id, projectId) as Task | undefined)
      : null;
    if (body.task_id && !sourceTask) {
      const err = new Error('Task not found') as any;
      err.statusCode = 404;
      throw err;
    }

    const hunk = body.hunk_id ? diff.hunks.find((item) => item.id === body.hunk_id) : null;
    if (body.hunk_id && !hunk) {
      const err = new Error('Hunk not found in current diff') as any;
      err.statusCode = 404;
      throw err;
    }

    const plan = reviewActionPlan(body.action);
    const now = new Date().toISOString();

    if (body.action === 'assign_reviewer') {
      if (!sourceTask) {
        const err = new Error('task_id is required for assign_reviewer') as any;
        err.statusCode = 400;
        throw err;
      }
      if (!hunk) {
        const err = new Error('hunk_id is required for assign_reviewer') as any;
        err.statusCode = 400;
        throw err;
      }
      // Assigning a reviewer routes the persona but leaves the card where it is
      // (a Deploy card stays in Deploy); it does not pull the task back to Review.
      db.prepare('UPDATE tasks SET assigned_agent = ?, updated_at = ? WHERE id = ?').run(plan.assigned_agent, now, sourceTask.id);
      const updated = db.prepare('SELECT id, project_id, title, status, assigned_agent, model_key FROM tasks WHERE id = ?').get(sourceTask.id) as ReviewActionResult['task'];
      return { ok: true, action: body.action, task: updated };
    }

    if (body.action === 'attach_to_chat') {
      if (!sourceTask) {
        const err = new Error('task_id is required for attach_to_chat') as any;
        err.statusCode = 400;
        throw err;
      }
      if (!hunk) {
        const err = new Error('hunk_id is required for attach_to_chat') as any;
        err.statusCode = 400;
        throw err;
      }
      const title = `Diff review: ${hunk.file}`;
      // Reuse an open thread for this file so repeated clicks reseed one thread
      // instead of spawning a new one each time.
      const existing = db.prepare('SELECT id, project_id, title FROM chat_threads WHERE project_id = ? AND title = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1').get(projectId, title) as ReviewActionResult['thread'] | undefined;
      let thread: NonNullable<ReviewActionResult['thread']>;
      if (existing) {
        db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(now, existing.id);
        thread = existing;
      } else {
        thread = { id: uuid(), project_id: projectId, title };
        db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)').run(thread.id, thread.project_id, thread.title, now, now, null);
      }
      return {
        ok: true,
        action: body.action,
        thread,
        seed: {
          threadId: thread.id,
          prompt: buildReviewActionPrompt(project, sourceTask, body.action, hunk, body.note),
          modelKey: sourceTask.model_key ?? null,
        },
      };
    }

    if (!hunk) {
      const err = new Error('hunk_id is required') as any;
      err.statusCode = 400;
      throw err;
    }

    const title = buildReviewActionTitle(body.action, hunk);
    const description = buildReviewActionPrompt(project, sourceTask ?? null, body.action, hunk, body.note);
    const task = {
      id: uuid(),
      project_id: projectId,
      title,
      description,
      status: plan.status,
      priority: sourceTask?.priority ?? 'medium',
      assigned_agent: plan.assigned_agent,
      due_date: null,
      created_at: now,
      updated_at: now,
    };

    db.prepare('INSERT INTO tasks (id, project_id, title, description, status, priority, assigned_agent, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(task.id, task.project_id, task.title, task.description, task.status, task.priority, task.assigned_agent, task.due_date, task.created_at, task.updated_at);
    db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now, projectId);

    const saved = db.prepare('SELECT id, project_id, title, status, assigned_agent, model_key FROM tasks WHERE id = ?').get(task.id) as ReviewActionResult['task'];
    return { ok: true, action: body.action, task: saved };
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
        emit: fastify.activity?.bus.emit.bind(fastify.activity.bus),
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

    // Tasks in the pre-work columns (triage/todo) must never carry a live
    // chat-thread link — that link is what renders the chat bubble on the
    // Kanban card. When a card is dragged out of "In Progress" back to one
    // of these columns the underlying Pi session is already closed, so
    // keeping thread_id here leaves a dangling bubble that 404s on click
    // (issue #97). Reset the link whenever the *resulting* status is a
    // pre-work state, regardless of whether status was in the payload.
    const resultingStatus: TaskStatus = body.status ?? existing.status;
    const resetThreadLink = (['triage', 'todo'] as TaskStatus[]).includes(resultingStatus);

    db.prepare(
      'UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description), status = COALESCE(?, status), priority = COALESCE(?, priority), assigned_agent = COALESCE(?, assigned_agent), due_date = COALESCE(?, due_date), model_key = ?, thread_id = ?, updated_at = ? WHERE id = ?',
    ).run(
      body.title,
      body.description,
      body.status,
      body.priority,
      body.assigned_agent,
      body.due_date,
      resetThreadLink ? null : (body.model_key ?? existing.model_key ?? null),
      resetThreadLink ? null : (body.thread_id ?? existing.thread_id ?? null),
      now,
      id,
    );

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
