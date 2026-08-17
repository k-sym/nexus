/**
 * Idea Watcher (#352) — successor to Braindump. An idea row is metadata over a
 * dialogue: the conversation itself lives in an assistant session (created
 * lazily by POST /:id/session, chatted through the existing
 * /api/assistant/sessions/:id/* routes). Graduation to GitHub issues is the
 * codebase's only GitHub write and is confirm-gated in the UI: this route only
 * ever receives drafts the user has already reviewed and confirmed.
 */
import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { Idea, IdeaState, IdeaGraduation, IdeaIssueDraft, IDEA_STATES } from '@nexus/shared';
import { createIssue, GitHubError, GitHubRepoRef } from '../github/client.js';
import { resolveGitHubToken } from '../github/token.js';
import { parseRepoShorthand } from '../github/repo.js';

/** States hidden from the default list (terminal, shown behind ?all=1). */
const TERMINAL_STATES: readonly IdeaState[] = ['graduated', 'discarded'];

interface IdeaRow {
  id: string;
  title: string;
  seed: string;
  state: IdeaState;
  tags: string;
  target_repo: string | null;
  session_id: string | null;
  graduated_to: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

function parseGraduation(json: string | null): IdeaGraduation | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as IdeaGraduation & { taskId?: string | null };
    // The braindump migration writes taskId: null via json_object; drop it.
    if (value.kind === 'project' && value.taskId == null) delete value.taskId;
    return value;
  } catch {
    return null;
  }
}

function publicIdea(row: IdeaRow): Idea {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
  } catch { /* malformed tags render as none */ }
  return { ...row, tags, graduated_to: parseGraduation(row.graduated_to) };
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/** Accept "owner/repo" or any GitHub remote URL parseGitHubRepo understands. */
export function parseRepoInput(value: string): GitHubRepoRef | null {
  return parseRepoShorthand(value);
}

/** Where an idea's thread attachments are filed (under <uploadRoot>/project_docs/uploads). */
export function ideaUploadsSubdir(ideaId: string): string {
  return path.join('ideas', ideaId);
}

export interface IdeaRouteOptions {
  fetchImpl?: typeof fetch;
  resolveToken?: () => Promise<string | undefined>;
  /** Root the assistant routes save attachments under; defaults to cwd, like theirs. */
  uploadRoot?: string;
}

export async function registerIdeaRoutes(fastify: FastifyInstance, options: IdeaRouteOptions = {}) {
  const db = fastify.db;
  const resolveToken = options.resolveToken ?? resolveGitHubToken;
  const uploadRoot = options.uploadRoot ?? process.cwd();

  const getIdea = (id: string): IdeaRow | undefined =>
    db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as IdeaRow | undefined;

  const setState = (id: string, state: IdeaState) => {
    db.prepare('UPDATE ideas SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, new Date().toISOString(), id);
  };

  // Lazy state transitions computed on read, so no hook into the assistant
  // routes is needed (streamed and background turns both land in
  // assistant_runs, so one query covers both):
  //  - parked → discussing once the dialogue actually has a turn. Opening an
  //    idea creates the session, but looking is not discussing.
  //  - researching → reviewed once a dispatched research run has settled —
  //    the findings are in the thread waiting to be pulled apart.
  const settleStates = (rows: IdeaRow[]): void => {
    const latestRunStatus = db.prepare(
      'SELECT status FROM assistant_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1',
    );
    for (const row of rows) {
      if (!row.session_id) continue;
      const run = latestRunStatus.get(row.session_id) as { status: string } | undefined;
      if (!run) continue;
      if (row.state === 'parked') {
        setState(row.id, 'discussing');
        row.state = 'discussing';
      } else if (row.state === 'researching' && run.status !== 'running' && run.status !== 'cancelling') {
        setState(row.id, 'reviewed');
        row.state = 'reviewed';
      }
    }
  };

  fastify.get('/api/ideas', async (request) => {
    const query = request.query as { state?: string; all?: string };
    let rows = db.prepare('SELECT * FROM ideas ORDER BY datetime(updated_at) DESC').all() as IdeaRow[];
    settleStates(rows);
    if (query.state) {
      if (!IDEA_STATES.includes(query.state as IdeaState)) throw httpError(`Unknown state: ${query.state}`, 400);
      rows = rows.filter((r) => r.state === query.state);
    } else if (query.all !== '1') {
      rows = rows.filter((r) => !TERMINAL_STATES.includes(r.state));
    }
    return rows.map(publicIdea);
  });

  fastify.post('/api/ideas', async (request) => {
    const body = (request.body ?? {}) as { title?: string; seed?: string };
    const title = (body.title ?? '').trim();
    if (!title) throw httpError('title is required', 400);
    const now = new Date().toISOString();
    const id = uuid();
    db.prepare(
      `INSERT INTO ideas (id, title, seed, state, tags, target_repo, session_id, graduated_to, source, created_at, updated_at)
       VALUES (?, ?, ?, 'parked', '[]', NULL, NULL, NULL, 'idea_watcher', ?, ?)`,
    ).run(id, title, body.seed ?? '', now, now);
    return publicIdea(getIdea(id)!);
  });

  fastify.patch('/api/ideas/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      title?: string;
      seed?: string;
      state?: IdeaState;
      tags?: string[];
      target_repo?: string | null;
      graduated_to?: IdeaGraduation | null;
    };
    const existing = getIdea(id);
    if (!existing) throw httpError('Idea not found', 404);
    if (body.state !== undefined && !IDEA_STATES.includes(body.state)) {
      throw httpError(`Unknown state: ${body.state}`, 400);
    }
    if (body.tags !== undefined && !(Array.isArray(body.tags) && body.tags.every((t) => typeof t === 'string'))) {
      throw httpError('tags must be an array of strings', 400);
    }
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE ideas SET
         title = COALESCE(?, title),
         seed = COALESCE(?, seed),
         state = COALESCE(?, state),
         tags = COALESCE(?, tags),
         target_repo = CASE WHEN ? THEN ? ELSE target_repo END,
         graduated_to = CASE WHEN ? THEN ? ELSE graduated_to END,
         updated_at = ?
       WHERE id = ?`,
    ).run(
      body.title?.trim() || null,
      body.seed ?? null,
      body.state ?? null,
      body.tags !== undefined ? JSON.stringify(body.tags) : null,
      body.target_repo !== undefined ? 1 : 0,
      body.target_repo ?? null,
      body.graduated_to !== undefined ? 1 : 0,
      body.graduated_to != null ? JSON.stringify(body.graduated_to) : null,
      now,
      id,
    );
    return publicIdea(getIdea(id)!);
  });

  fastify.delete('/api/ideas/:id', async (request) => {
    const { id } = request.params as { id: string };
    // Hard delete for true junk; the deliberate drop is state='discarded'.
    // The idea's session (if any) is left alone — it archives like any chat.
    db.prepare('DELETE FROM ideas WHERE id = ?').run(id);
    return { success: true };
  });

  // Ensure the idea has its dialogue session. Idempotent, and deliberately
  // does NOT advance state — the UI calls this on open, and looking at a
  // parked idea is not discussing it (the settleStates pass flips it once a
  // turn exists). The session carries origin='idea' so the Assistant rail
  // leaves it out of its list — chat still flows through the ordinary
  // /api/assistant/sessions/:id routes, which look up by id.
  fastify.post('/api/ideas/:id/session', async (request) => {
    const { id } = request.params as { id: string };
    const idea = getIdea(id);
    if (!idea) throw httpError('Idea not found', 404);
    if (idea.session_id) return { sessionId: idea.session_id };
    const now = new Date().toISOString();
    const sessionId = uuid();
    db.prepare(
      `INSERT INTO assistant_sessions (id, title, status, origin, created_at, updated_at, archived_at)
       VALUES (?, ?, 'idle', 'idea', ?, ?, NULL)`,
    ).run(sessionId, `Idea: ${idea.title}`, now, now);
    db.prepare('UPDATE ideas SET session_id = ?, updated_at = ? WHERE id = ?').run(sessionId, now, id);
    return { sessionId };
  });

  // Graduation into an existing project. Beyond recording the link, this
  // moves the idea's filed attachments (project_docs/uploads/ideas/<id>/,
  // written there by the assistant routes for idea-origin sessions) into the
  // project's own project_docs/uploads/ideas/<id>/ — the files follow the
  // work. Copy-then-remove rather than rename so a repo on another volume
  // works. A project without a usable repo path is a 400, not a silent
  // no-move: the caller should surface it and let the user fix the project.
  fastify.post('/api/ideas/:id/graduate/project', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { projectId?: string };
    const idea = getIdea(id);
    if (!idea) throw httpError('Idea not found', 404);
    const projectId = (body.projectId ?? '').trim();
    if (!projectId) throw httpError('projectId is required', 400);
    const project = db.prepare('SELECT id, repo_path FROM projects WHERE id = ?').get(projectId) as
      | { id: string; repo_path: string }
      | undefined;
    if (!project) throw httpError('Project not found', 404);

    const sourceDir = path.join(uploadRoot, 'project_docs', 'uploads', ideaUploadsSubdir(id));
    let movedFiles = 0;
    if (existsSync(sourceDir)) {
      if (!project.repo_path || !existsSync(project.repo_path)) {
        throw httpError('The project has no usable repo path to move this idea’s files into — fix the project first.', 400);
      }
      const destDir = path.join(project.repo_path, 'project_docs', 'uploads', ideaUploadsSubdir(id));
      movedFiles = readdirSync(sourceDir).length;
      mkdirSync(path.dirname(destDir), { recursive: true });
      cpSync(sourceDir, destDir, { recursive: true });
      rmSync(sourceDir, { recursive: true, force: true });
    }

    const graduation: IdeaGraduation = { kind: 'project', projectId };
    db.prepare("UPDATE ideas SET state = 'graduated', graduated_to = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(graduation), new Date().toISOString(), id);
    return { idea: publicIdea(getIdea(id)!), movedFiles };
  });

  // Confirm-gated graduation into a GitHub issue set. The drafts arrive
  // already reviewed/edited by the user; this files them sequentially,
  // appending a "Part of #first" line to the second issue onward so a set
  // stays navigable. Partial failure reports what did land — the created
  // issues exist on GitHub either way, so the idea records them.
  fastify.post('/api/ideas/:id/graduate/issues', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { repo?: string; issues?: IdeaIssueDraft[] };
    const idea = getIdea(id);
    if (!idea) throw httpError('Idea not found', 404);

    const ref = parseRepoInput(body.repo ?? idea.target_repo ?? '');
    if (!ref) throw httpError('repo must be "owner/repo" or a GitHub URL', 400);
    const issues = Array.isArray(body.issues) ? body.issues : [];
    if (issues.length === 0) throw httpError('at least one issue is required', 400);
    for (const draft of issues) {
      if (!draft.title?.trim() || typeof draft.body !== 'string') {
        throw httpError('each issue needs a title and a body', 400);
      }
    }
    const token = await resolveToken();
    if (!token) {
      throw httpError('A GitHub token is required to file issues (set GITHUB_TOKEN or sign in with gh).', 400);
    }

    const created: { number: number; html_url: string }[] = [];
    try {
      for (const [index, draft] of issues.entries()) {
        const bodyText = index === 0 ? draft.body : `${draft.body}\n\nPart of #${created[0].number}.`;
        created.push(await createIssue(ref, { title: draft.title.trim(), body: bodyText, labels: draft.labels }, token, options.fetchImpl));
      }
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
      if (created.length > 0) {
        // Record the partial set so nothing filed on GitHub goes untracked.
        const graduation: IdeaGraduation = { kind: 'issues', urls: created.map((c) => c.html_url) };
        db.prepare('UPDATE ideas SET graduated_to = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(graduation), new Date().toISOString(), id);
      }
      reply.code(err.status && err.status >= 400 && err.status < 500 ? 400 : 502);
      return { error: err.message, issues: created };
    }

    const graduation: IdeaGraduation = { kind: 'issues', urls: created.map((c) => c.html_url) };
    db.prepare("UPDATE ideas SET state = 'graduated', graduated_to = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(graduation), new Date().toISOString(), id);
    return { issues: created, idea: publicIdea(getIdea(id)!) };
  });
}
