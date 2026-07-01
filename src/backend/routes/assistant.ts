import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import type { NexusConfig } from '@nexus/shared';
import { createHermesClient, type HermesFetch, type HermesRunStatus } from '../hermes/client.js';

interface AssistantMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  created_at: string;
}

interface AssistantSession {
  id: string;
  title: string;
  remote_session_id: string | null;
  remote_conversation_key: string | null;
  status: string;
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface AssistantRun {
  id: string;
  session_id: string;
  remote_run_id: string | null;
  remote_job_id: string | null;
  kind: 'chat' | 'overnight' | 'scheduled';
  status: string;
  input: string;
  output: string;
  error: string | null;
  usage_json: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

interface AssistantRoutesOptions {
  fetchImpl?: HermesFetch;
}

const RUNNING_STATUSES = new Set(['running', 'cancelling', 'unknown']);

function configuredAssistant(load: () => NexusConfig) {
  const config = load();
  const url = resolveEnvVars(config.assistant.url || '').trim();
  const key = resolveAssistantKey(config);
  return { url, key };
}

function publicMessage(message: AssistantMessage) {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    created_at: message.created_at,
  };
}

function publicRun(run: AssistantRun | undefined | null) {
  if (!run) return null;
  return {
    id: run.id,
    session_id: run.session_id,
    remote_run_id: run.remote_run_id,
    remote_job_id: run.remote_job_id,
    kind: run.kind,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    usage: parseJson(run.usage_json),
    started_at: run.started_at,
    completed_at: run.completed_at,
    updated_at: run.updated_at,
  };
}

function latestRun(db: FastifyInstance['db'], sessionId: string): AssistantRun | undefined {
  return db
    .prepare('SELECT * FROM assistant_runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(sessionId) as AssistantRun | undefined;
}

function readMessages(db: FastifyInstance['db'], sessionId: string): AssistantMessage[] {
  return db
    .prepare('SELECT id, session_id, role, content, created_at FROM assistant_session_messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as AssistantMessage[];
}

function getSession(db: FastifyInstance['db'], sessionId: string): AssistantSession | undefined {
  return db.prepare('SELECT * FROM assistant_sessions WHERE id = ? AND archived_at IS NULL').get(sessionId) as
    | AssistantSession
    | undefined;
}

function newestSession(db: FastifyInstance['db']): AssistantSession | undefined {
  return db
    .prepare('SELECT * FROM assistant_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT 1')
    .get() as AssistantSession | undefined;
}

function createSession(db: FastifyInstance['db'], title?: string): AssistantSession {
  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_sessions
      (id, title, status, created_at, updated_at, archived_at)
     VALUES (?, ?, 'idle', ?, ?, NULL)`,
  ).run(id, title?.trim() || 'New Assistant Session', now, now);
  return db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSession;
}

function ensureDefaultSession(db: FastifyInstance['db']): AssistantSession {
  return newestSession(db) ?? createSession(db, 'Assistant');
}

function appendMessage(
  db: FastifyInstance['db'],
  sessionId: string,
  role: AssistantMessage['role'],
  content: string,
): AssistantMessage {
  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_session_messages
      (id, session_id, remote_message_id, role, content, event_json, created_at)
     VALUES (?, ?, NULL, ?, ?, NULL, ?)`,
  ).run(id, sessionId, role, content, now);
  db.prepare('UPDATE assistant_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  return { id, session_id: sessionId, role, content, created_at: now };
}

function createRun(
  db: FastifyInstance['db'],
  sessionId: string,
  kind: AssistantRun['kind'],
  input: string,
): AssistantRun {
  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_runs
      (id, session_id, kind, status, input, output, started_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, '', ?, ?)`,
  ).run(id, sessionId, kind, input, now, now);
  db.prepare("UPDATE assistant_sessions SET status = 'running', last_run_id = ?, updated_at = ? WHERE id = ?").run(id, now, sessionId);
  return db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(id) as AssistantRun;
}

function updateRunRemote(db: FastifyInstance['db'], runId: string, remoteRunId: string, status = 'running'): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE assistant_runs SET remote_run_id = ?, status = ?, updated_at = ? WHERE id = ?').run(remoteRunId, status, now, runId);
}

function completeRun(
  db: FastifyInstance['db'],
  run: AssistantRun,
  remote: HermesRunStatus,
): AssistantRun {
  const now = new Date().toISOString();
  const status = mapRemoteStatus(remote.status);
  const output = remote.output ?? run.output ?? '';
  const completedAt = status === 'running' || status === 'cancelling' ? null : now;
  db.prepare(
    `UPDATE assistant_runs
     SET status = ?, output = ?, error = ?, usage_json = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, output, remote.error ?? run.error, remote.usage ? JSON.stringify(remote.usage) : run.usage_json, completedAt, now, run.id);
  db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run(
    status === 'succeeded' ? 'idle' : status,
    now,
    run.session_id,
  );
  return db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(run.id) as AssistantRun;
}

function mapRemoteStatus(status: string): string {
  if (status === 'completed' || status === 'succeeded') return 'succeeded';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (status === 'stopping') return 'cancelling';
  return 'running';
}

function activityStatusForRun(status: string): 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'succeeded';
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function createAssistantRoutes(load: () => NexusConfig = loadConfig, options: AssistantRoutesOptions = {}) {
  return async function registerAssistantRoutes(fastify: FastifyInstance) {
    const db = fastify.db;
    const activeRemoteRuns = new Map<string, string>();

    const client = () => {
      const { url, key } = configuredAssistant(load);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    const streamSessionTurn = async (sessionId: string, content: string, reply: any) => {
      const trimmed = content.trim();
      if (!trimmed) {
        reply.code(400);
        return { error: 'Message content is required.' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      const session = getSession(db, sessionId);
      if (!session) {
        reply.code(404);
        return { error: 'Assistant session not found' };
      }

      appendMessage(db, session.id, 'user', trimmed);
      const run = createRun(db, session.id, 'chat', trimmed);
      activeRemoteRuns.set(run.id, '');
      fastify.activity?.bus.emit({
        type: 'start',
        operationId: run.id,
        kind: 'assistant_stream',
        title: session.title,
        provider: 'assistant',
        model: 'hermes-agent',
      });

      try {
        const started = await hermes.startRun({
          input: trimmed,
          sessionId: session.remote_session_id ?? session.id,
          sessionKey: `nexus:assistant:${session.id}`,
        });
        updateRunRemote(db, run.id, started.runId);
        activeRemoteRuns.set(run.id, started.runId);
        const remote = await hermes.getRun(started.runId);
        const completed = completeRun(db, { ...run, remote_run_id: started.runId }, remote);
        if (completed.output) appendMessage(db, session.id, 'assistant', completed.output);

        fastify.activity?.bus.emit({
          type: 'stop',
          operationId: run.id,
          kind: 'assistant_stream',
          title: session.title,
          status: activityStatusForRun(completed.status),
          lastEvent: RUNNING_STATUSES.has(completed.status) ? 'remote_run_running' : undefined,
          error: completed.status === 'failed' ? completed.error ?? remote.error : undefined,
        });

        reply.type('application/x-ndjson; charset=utf-8');
        return [
          JSON.stringify({ type: 'run_start', runId: run.id, remoteRunId: started.runId }),
          ...(completed.output ? [JSON.stringify({ type: 'text_delta', delta: completed.output })] : []),
          JSON.stringify({ type: 'complete', runId: run.id, status: completed.status }),
        ].join('\n') + '\n';
      } catch (err: any) {
        const message = err?.message || 'Assistant request failed.';
        const now = new Date().toISOString();
        db.prepare('UPDATE assistant_runs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
          'failed',
          message,
          now,
          now,
          run.id,
        );
        db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, session.id);
        fastify.activity?.bus.emit({
          type: 'stop',
          operationId: run.id,
          kind: 'assistant_stream',
          title: session.title,
          status: 'failed',
          error: message,
        });
        reply.type('application/x-ndjson; charset=utf-8');
        return JSON.stringify({ type: 'error', error: message }) + '\n';
      } finally {
        activeRemoteRuns.delete(run.id);
      }
    };

    fastify.get('/api/assistant/sessions', async () => {
      const sessions = db
        .prepare('SELECT * FROM assistant_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC')
        .all() as AssistantSession[];
      return {
        sessions: sessions.map((session) => ({ ...session, latestRun: publicRun(latestRun(db, session.id)) })),
      };
    });

    fastify.post('/api/assistant/sessions', async (request) => {
      const body = (request.body ?? {}) as { title?: string };
      return createSession(db, body.title);
    });

    fastify.get('/api/assistant/sessions/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const session = getSession(db, id);
      if (!session) {
        reply.code(404);
        return { error: 'Assistant session not found' };
      }
      return {
        session,
        messages: readMessages(db, id).map(publicMessage),
        latestRun: publicRun(latestRun(db, id)),
      };
    });

    fastify.patch('/api/assistant/sessions/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { title?: string; archived?: boolean };
      const session = getSession(db, id);
      if (!session) {
        reply.code(404);
        return { error: 'Assistant session not found' };
      }
      const now = new Date().toISOString();
      if (body.archived) {
        db.prepare('UPDATE assistant_sessions SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
      } else if (body.title?.trim()) {
        db.prepare('UPDATE assistant_sessions SET title = ?, updated_at = ? WHERE id = ?').run(body.title.trim(), now, id);
      }
      return db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSession;
    });

    fastify.delete('/api/assistant/sessions/:id', async (request, reply) => {
      const { id } = request.params as { id: string };
      const session = getSession(db, id);
      if (!session) {
        reply.code(404);
        return { error: 'Assistant session not found' };
      }
      const hermes = client();
      const runningRuns = db
        .prepare('SELECT * FROM assistant_runs WHERE session_id = ? AND remote_run_id IS NOT NULL AND status IN (?, ?, ?)')
        .all(id, ...Array.from(RUNNING_STATUSES)) as AssistantRun[];
      if (hermes) {
        for (const run of runningRuns) {
          if (!run.remote_run_id) continue;
          await hermes.stopRun(run.remote_run_id).catch(() => undefined);
        }
      }
      db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
      return { ok: true };
    });

    fastify.post('/api/assistant/sessions/:id/messages/stream', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { content?: string };
      return streamSessionTurn(id, body.content ?? '', reply);
    });

    fastify.post('/api/assistant/sessions/:id/runs', async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { content?: string };
      const content = body.content?.trim() ?? '';
      if (!content) {
        reply.code(400);
        return { error: 'Message content is required.' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      const session = getSession(db, id);
      if (!session) {
        reply.code(404);
        return { error: 'Assistant session not found' };
      }
      appendMessage(db, session.id, 'user', content);
      const run = createRun(db, session.id, 'overnight', content);
      const remote = await hermes.startRun({
        input: content,
        sessionId: session.remote_session_id ?? session.id,
        sessionKey: `nexus:assistant:${session.id}`,
      });
      updateRunRemote(db, run.id, remote.runId);
      return { run: publicRun(db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(run.id) as AssistantRun) };
    });

    fastify.get('/api/assistant/runs/:runId', async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(runId) as AssistantRun | undefined;
      if (!run) {
        reply.code(404);
        return { error: 'Assistant run not found' };
      }
      return { run: publicRun(run) };
    });

    fastify.post('/api/assistant/runs/:runId/stop', async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = db.prepare('SELECT * FROM assistant_runs WHERE id = ?').get(runId) as AssistantRun | undefined;
      if (!run) {
        reply.code(404);
        return { error: 'Assistant run not found' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }
      if (run.remote_run_id) await hermes.stopRun(run.remote_run_id);
      const now = new Date().toISOString();
      db.prepare('UPDATE assistant_runs SET status = ?, updated_at = ? WHERE id = ?').run('cancelling', now, run.id);
      return { ok: true };
    });

    fastify.post('/api/assistant/sync', async () => {
      const hermes = client();
      if (!hermes) return { updated: 0 };
      const runs = db
        .prepare('SELECT * FROM assistant_runs WHERE remote_run_id IS NOT NULL AND status IN (?, ?, ?)')
        .all(...Array.from(RUNNING_STATUSES)) as AssistantRun[];
      let updated = 0;
      for (const run of runs) {
        if (!run.remote_run_id) continue;
        const remote = await hermes.getRun(run.remote_run_id);
        const completed = completeRun(db, run, remote);
        if (completed.status !== run.status) updated += 1;
        if (completed.status === 'succeeded' && completed.output) {
          const existing = db
            .prepare('SELECT id FROM assistant_session_messages WHERE session_id = ? AND role = ? AND content = ?')
            .get(run.session_id, 'assistant', completed.output);
          if (!existing) appendMessage(db, run.session_id, 'assistant', completed.output);
        }
      }
      return { updated };
    });

    fastify.get('/api/assistant/thread', async () => {
      const session = ensureDefaultSession(db);
      return { id: 'global', sessionId: session.id, messages: readMessages(db, session.id).map(publicMessage) };
    });

    fastify.delete('/api/assistant/thread', async () => {
      db.prepare('DELETE FROM assistant_session_messages').run();
      db.prepare('DELETE FROM assistant_runs').run();
      db.prepare('DELETE FROM assistant_messages').run();
      return { ok: true, id: 'global' };
    });

    fastify.post('/api/assistant/messages/stream', async (request, reply) => {
      const body = (request.body ?? {}) as { content?: string };
      const session = ensureDefaultSession(db);
      return streamSessionTurn(session.id, body.content ?? '', reply);
    });

    fastify.post('/api/assistant/abort', async () => {
      const latest = db
        .prepare("SELECT * FROM assistant_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1")
        .get() as AssistantRun | undefined;
      if (!latest) return { ok: false, reason: 'no_run' };
      const hermes = client();
      const remoteRunId = latest.remote_run_id || activeRemoteRuns.get(latest.id);
      if (hermes && remoteRunId) await hermes.stopRun(remoteRunId);
      const now = new Date().toISOString();
      db.prepare('UPDATE assistant_runs SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
        'cancelled',
        now,
        now,
        latest.id,
      );
      return { ok: true };
    });
  };
}

export const registerAssistantRoutes = createAssistantRoutes();
