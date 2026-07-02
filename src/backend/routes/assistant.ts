import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import type { NexusConfig } from '@nexus/shared';
import { createHermesClient, type HermesContentPart, type HermesFetch, type HermesRunStatus } from '../hermes/client.js';

interface AssistantMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments_json: string | null;
  created_at: string;
}

interface AssistantImageAttachment {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  name?: string;
  size?: number;
  path?: string;
}

interface AssistantFileAttachment {
  type: 'file';
  data: string;
  mimeType:
    | 'application/pdf'
    | 'text/plain'
    | 'text/markdown'
    | 'text/csv'
    | 'application/csv'
    | 'application/msword'
    | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    | 'application/vnd.ms-excel'
    | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  name: string;
  size?: number;
  path?: string;
}

type AssistantAttachment = AssistantImageAttachment | AssistantFileAttachment;

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
  uploadRoot?: string;
}

const RUNNING_STATUSES = new Set(['running', 'cancelling']);
const ASSISTANT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

const allowedImageMimeTypes = new Set<AssistantImageAttachment['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const allowedFileMimeTypes = new Set<AssistantFileAttachment['mimeType']>([
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

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
    attachments: parseStoredAttachments(message.attachments_json),
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
    .prepare('SELECT id, session_id, role, content, attachments_json, created_at FROM assistant_session_messages WHERE session_id = ? ORDER BY created_at ASC')
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
  attachments: AssistantAttachment[] = [],
): AssistantMessage {
  const now = new Date().toISOString();
  const id = uuid();
  db.prepare(
    `INSERT INTO assistant_session_messages
      (id, session_id, remote_message_id, role, content, attachments_json, event_json, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)`,
  ).run(id, sessionId, role, content, JSON.stringify(attachments), now);
  db.prepare('UPDATE assistant_sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
  return { id, session_id: sessionId, role, content, attachments_json: JSON.stringify(attachments), created_at: now };
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

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || 'Assistant request failed.');
}

function markRunUnknown(db: FastifyInstance['db'], run: AssistantRun, message: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE assistant_runs
     SET status = 'unknown', error = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(message, now, now, run.id);
  db.prepare(
    `UPDATE assistant_sessions
     SET status = 'unknown', updated_at = ?
     WHERE id = ? AND last_run_id = ?`,
  ).run(now, run.session_id, run.id);
}

function parseJson(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function validateAssistantAttachments(input: unknown): { ok: true; attachments: AssistantAttachment[] } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'attachments must be an array' };
  if (input.length > 5) return { ok: false, error: 'attachments must contain at most 5 files' };

  const validated: AssistantAttachment[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] as any;
    if (!item || typeof item !== 'object') return { ok: false, error: `attachments[${index}] must be an object` };
    if (item.type !== 'image' && item.type !== 'file') {
      return { ok: false, error: `attachments[${index}].type must be "image" or "file"` };
    }
    if (typeof item.data !== 'string' || item.data.length === 0) {
      return { ok: false, error: `attachments[${index}].data must be a non-empty string` };
    }
    if (item.type === 'image' && (typeof item.mimeType !== 'string' || !allowedImageMimeTypes.has(item.mimeType))) {
      return { ok: false, error: `attachments[${index}].mimeType has unsupported image MIME type` };
    }
    if (item.type === 'file' && (typeof item.mimeType !== 'string' || !allowedFileMimeTypes.has(item.mimeType))) {
      return { ok: false, error: `attachments[${index}].mimeType has unsupported file MIME type` };
    }
    if (item.type === 'file' && (typeof item.name !== 'string' || item.name.trim().length === 0)) {
      return { ok: false, error: `attachments[${index}].name must be a non-empty string` };
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      return { ok: false, error: `attachments[${index}].name must be a string` };
    }
    if (item.size !== undefined && (!Number.isFinite(item.size) || item.size < 0)) {
      return { ok: false, error: `attachments[${index}].size must be a non-negative number` };
    }
    if (item.path !== undefined && typeof item.path !== 'string') {
      return { ok: false, error: `attachments[${index}].path must be a string` };
    }

    if (item.type === 'image') {
      validated.push({
        type: 'image',
        data: item.data,
        mimeType: item.mimeType,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...(item.path !== undefined ? { path: item.path } : {}),
      });
    } else {
      validated.push({
        type: 'file',
        data: item.data,
        mimeType: item.mimeType,
        name: item.name,
        ...(item.size !== undefined ? { size: item.size } : {}),
        ...(item.path !== undefined ? { path: item.path } : {}),
      });
    }
  }
  return { ok: true, attachments: validated };
}

function parseStoredAttachments(value: string | null): AssistantAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const validated = validateAssistantAttachments(parsed);
    return validated.ok ? validated.attachments : [];
  } catch {
    return [];
  }
}

function saveAssistantAttachments(attachments: AssistantAttachment[], uploadRoot: string): AssistantAttachment[] {
  if (attachments.length === 0) return attachments;
  const uploadsDir = path.join(uploadRoot, 'project_docs', 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  return attachments.map((attachment, index) => {
    const originalName = attachment.name?.trim() || `assistant-image-${index + 1}${extensionForMime(attachment.mimeType)}`;
    const filename = uniqueUploadFilename(uploadsDir, originalName);
    const filePath = path.join(uploadsDir, filename);
    writeFileSync(filePath, Buffer.from(attachment.data, 'base64'));
    return { ...attachment, name: filename, path: filePath };
  });
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/gif') return '.gif';
  if (mimeType === 'image/webp') return '.webp';
  return '';
}

function uniqueUploadFilename(dir: string, name: string): string {
  const safe = sanitizeFilename(name) || 'attachment';
  if (!existsSync(path.join(dir, safe))) return safe;
  const ext = path.extname(safe);
  const stem = path.basename(safe, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${stem}-${uuid()}${ext}`;
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  return base === '.' || base === '..' ? 'attachment' : base;
}

function promptWithFileReferences(content: string, attachments: AssistantAttachment[]): string {
  const files = attachments.filter((attachment): attachment is AssistantFileAttachment => attachment.type === 'file' && !!attachment.path);
  if (files.length === 0) return content;
  const lines = files.map((file) => `- ${file.name ?? 'attachment'}: ${file.path}`);
  return `${content}\n\nAttached files:\n${lines.join('\n')}`;
}

function hasImageAttachments(attachments: AssistantAttachment[]): boolean {
  return attachments.some((attachment) => attachment.type === 'image');
}

function hermesInlineImageInput(content: string, attachments: AssistantAttachment[]): HermesContentPart[] {
  const parts: HermesContentPart[] = [];
  if (content.trim()) parts.push({ type: 'text', text: content });
  for (const attachment of attachments) {
    if (attachment.type !== 'image') continue;
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${attachment.mimeType};base64,${attachment.data}`,
        detail: 'high',
      },
    });
  }
  return parts;
}

export function createAssistantRoutes(load: () => NexusConfig = loadConfig, options: AssistantRoutesOptions = {}) {
  return async function registerAssistantRoutes(fastify: FastifyInstance) {
    const db = fastify.db;
    const activeRemoteRuns = new Map<string, string>();
    const uploadRoot = options.uploadRoot ?? process.cwd();

    const client = () => {
      const { url, key } = configuredAssistant(load);
      if (!url || !key) return undefined;
      return createHermesClient({ url, key, fetchImpl: options.fetchImpl });
    };

    const ensureRemoteSession = async (
      hermes: ReturnType<typeof createHermesClient>,
      session: AssistantSession,
    ): Promise<string> => {
      const remoteSessionId = session.remote_session_id ?? session.id;
      try {
        await hermes.createSession({
          sessionId: remoteSessionId,
          sessionKey: `nexus:assistant:${session.id}`,
          title: session.title,
        });
      } catch (err) {
        const message = errorMessage(err);
        if (!/session_exists|already exists/i.test(message)) throw err;
      }
      if (session.remote_session_id !== remoteSessionId) {
        const now = new Date().toISOString();
        db.prepare('UPDATE assistant_sessions SET remote_session_id = ?, updated_at = ? WHERE id = ?').run(remoteSessionId, now, session.id);
      }
      return remoteSessionId;
    };

    const streamSessionTurn = async (sessionId: string, content: string, attachmentsInput: unknown, reply: any) => {
      const trimmed = content.trim();
      const attachmentsResult = validateAssistantAttachments(attachmentsInput);
      if (!attachmentsResult.ok) { reply.code(400); return { error: attachmentsResult.error }; }
      const savedAttachments = saveAssistantAttachments(attachmentsResult.attachments, uploadRoot);
      const promptContent = promptWithFileReferences(trimmed, savedAttachments);
      if (!trimmed && savedAttachments.length === 0) { reply.code(400); return { error: 'Message content is required.' }; }
      const hermes = client();
      if (!hermes) { reply.code(400); return { error: 'Assistant URL and key must be configured in Settings.' }; }
      const session = getSession(db, sessionId);
      if (!session) { reply.code(404); return { error: 'Assistant session not found' }; }

      appendMessage(db, session.id, 'user', trimmed, savedAttachments);
      const run = createRun(db, session.id, 'chat', promptContent);
      activeRemoteRuns.set(run.id, '');
      fastify.activity?.bus.emit({ type: 'start', operationId: run.id, kind: 'assistant_stream', title: session.title, provider: 'assistant', model: 'hermes-agent' });

      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      const write = (ev: unknown) => { try { reply.raw.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ } };
      const startedAtIso = new Date().toISOString();
      write({ kind: 'run_start', run: { runId: run.id, threadId: session.id, startedAt: startedAtIso, provider: 'assistant', model: 'hermes-agent' } });

      let accumulated = '';
      let status: string = 'completed';
      let errorMsg: string | undefined;
      try {
        if (hasImageAttachments(savedAttachments)) {
          // Vision path stays non-streaming: one sessionChat call, surfaced as a text delta.
          const remoteSessionId = await ensureRemoteSession(hermes, session);
          const result = await hermes.sessionChat({ sessionId: remoteSessionId, sessionKey: `nexus:assistant:${session.id}`, input: hermesInlineImageInput(promptContent, savedAttachments) });
          accumulated = result.output ?? '';
          if (accumulated) write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: accumulated } });
          completeRun(db, run, { runId: run.id, status: 'completed', sessionId: result.sessionId, output: accumulated, usage: result.usage });
        } else {
          for await (const ev of hermes.streamResponses({ input: promptContent, sessionId: session.remote_session_id ?? session.id, sessionKey: `nexus:assistant:${session.id}` })) {
            if (ev.kind === 'text_delta') { accumulated += ev.delta; write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ev.delta } }); }
            else if (ev.kind === 'reasoning_delta') { write({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ev.delta } }); }
            else if (ev.kind === 'function_call') { write({ type: 'tool_execution_start', toolCallId: ev.id, toolName: ev.name, args: ev.args }); }
            else if (ev.kind === 'function_call_output') { write({ type: 'tool_execution_end', toolCallId: ev.callId, toolName: '', result: { content: [{ type: 'text', text: ev.output }] }, isError: ev.isError }); }
            else if (ev.kind === 'failed') { status = 'failed'; errorMsg = ev.error; write({ type: 'error', error: ev.error }); }
          }
          completeRun(db, run, { runId: run.id, status: status as any, output: accumulated, ...(errorMsg ? { error: errorMsg } : {}) });
        }
        if (accumulated) appendMessage(db, session.id, 'assistant', accumulated);
      } catch (err: any) {
        status = 'failed';
        errorMsg = err?.message || 'Assistant request failed.';
        const now = new Date().toISOString();
        db.prepare('UPDATE assistant_runs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?').run('failed', errorMsg, now, now, run.id);
        db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, session.id);
        write({ type: 'error', error: errorMsg });
      } finally {
        const completedAtIso = new Date().toISOString();
        write({ kind: 'run_end', run: { runId: run.id, threadId: session.id, completedAt: completedAtIso, status, ...(errorMsg ? { error: errorMsg } : {}) } });
        fastify.activity?.bus.emit({ type: 'stop', operationId: run.id, kind: 'assistant_stream', title: session.title, status: activityStatusForRun(status as any), error: status === 'failed' ? errorMsg : undefined });
        activeRemoteRuns.delete(run.id);
        try { reply.raw.end(); } catch { /* already closed */ }
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
        .prepare('SELECT * FROM assistant_runs WHERE session_id = ? AND remote_run_id IS NOT NULL AND status IN (?, ?)')
        .all(id, ...Array.from(RUNNING_STATUSES)) as AssistantRun[];
      if (hermes) {
        for (const run of runningRuns) {
          if (!run.remote_run_id) continue;
          await hermes.stopRun(run.remote_run_id).catch(() => undefined);
        }
        const hasRemoteWork = Boolean(session.remote_session_id) || Boolean(
          db.prepare('SELECT id FROM assistant_runs WHERE session_id = ? LIMIT 1').get(id),
        );
        if (hasRemoteWork) {
          await hermes.deleteSession(session.remote_session_id ?? session.id).catch(() => undefined);
        }
      }
      db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
      return { ok: true };
    });

    fastify.post('/api/assistant/sessions/:id/messages/stream', { bodyLimit: ASSISTANT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { content?: string; attachments?: unknown };
      return streamSessionTurn(id, body.content ?? '', body.attachments, reply);
    });

    fastify.post('/api/assistant/sessions/:id/runs', { bodyLimit: ASSISTANT_BODY_LIMIT_BYTES }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { content?: string; attachments?: unknown };
      const content = body.content?.trim() ?? '';
      const attachmentsResult = validateAssistantAttachments(body.attachments);
      if (!attachmentsResult.ok) {
        reply.code(400);
        return { error: attachmentsResult.error };
      }
      const savedAttachments = saveAssistantAttachments(attachmentsResult.attachments, uploadRoot);
      const promptContent = promptWithFileReferences(content, savedAttachments);
      if (hasImageAttachments(savedAttachments)) {
        reply.code(400);
        return { error: 'Background Handoff does not support image attachments yet. Use Send for vision turns.' };
      }
      if (!content && savedAttachments.length === 0) {
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
      appendMessage(db, session.id, 'user', content, savedAttachments);
      const run = createRun(db, session.id, 'overnight', promptContent);
      const remote = await hermes.startRun({
        input: promptContent,
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
        .prepare('SELECT * FROM assistant_runs WHERE remote_run_id IS NOT NULL AND status IN (?, ?)')
        .all(...Array.from(RUNNING_STATUSES)) as AssistantRun[];
      let updated = 0;
      for (const run of runs) {
        if (!run.remote_run_id) continue;
        try {
          const remote = await hermes.getRun(run.remote_run_id);
          const completed = completeRun(db, run, remote);
          if (completed.status !== run.status) updated += 1;
          if (completed.status === 'succeeded' && completed.output) {
            const existing = db
              .prepare('SELECT id FROM assistant_session_messages WHERE session_id = ? AND role = ? AND content = ?')
              .get(run.session_id, 'assistant', completed.output);
            if (!existing) appendMessage(db, run.session_id, 'assistant', completed.output);
          }
        } catch (err) {
          markRunUnknown(db, run, errorMessage(err));
          updated += 1;
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
      return streamSessionTurn(session.id, body.content ?? '', undefined, reply);
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
