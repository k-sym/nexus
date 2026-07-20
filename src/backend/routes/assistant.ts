import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import {
  ASSISTANT_CWD,
  openAssistantSession,
  readAssistantEntries,
  appendUserMessage,
  appendAssistantMessage,
} from '../pi/assistant-session.js';
import type { NexusConfig } from '@nexus/shared';
import {
  createHermesClient,
  type HermesClient,
  type HermesContentPart,
  type HermesFetch,
  type HermesListedSession,
  type HermesRunStatus,
} from '../hermes/client.js';
import { hermesMessagesToTranscript } from '../hermes/transcript.js';
import { autoTitleSession, NEW_ASSISTANT_SESSION_TITLE } from '../sessions/auto-title.js';
import { flattenEntries } from './chat.js';

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
  last_response_id: string | null;
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
  assistantSessionDir?: string;
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

// Hermes tags every session with a `source`. The Assistant rail surfaces
// human-driven sessions — those started from the API server (Nexus's own path),
// the TUI, or the CLI — and hides machine sources (cron, job, scheduled) and
// platform bridges (telegram, dashboard) that must not appear as adoptable chats.
//
// The api_server /api/sessions endpoint filters by a single `source` per request
// (it has no multi-source/exclude support and would otherwise let ~hundreds of
// cron rows crowd the human sources out of any capped window), so the list
// handler fetches one query per source below and merges the results.
const HERMES_ASSISTANT_SOURCES = ['api_server', 'tui', 'cli'] as const;
const HERMES_ASSISTANT_SOURCE_SET = new Set<string>(HERMES_ASSISTANT_SOURCES);

// Reject source-less rows and any source outside the allow-list above.
function isAdoptableRemoteSource(source: string | undefined): boolean {
  return source !== undefined && HERMES_ASSISTANT_SOURCE_SET.has(source);
}

function remoteSyntheticId(remoteSessionId: string): string {
  return `remote:${remoteSessionId}`;
}

// Hermes api_server rows use epoch-second timestamps; the rail sorts and renders
// on ISO strings. Tolerate ISO input too (other Hermes surfaces) and bad values.
function epochToIso(value: number | string | undefined | null): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const ms = value < 1e12 ? value * 1000 : value; // seconds vs. already-ms
  const iso = new Date(ms).toISOString();
  return Number.isNaN(Date.parse(iso)) ? undefined : iso;
}

function publicRemoteSession(remote: HermesListedSession) {
  // api_server rows carry started_at/last_active (epoch) and often a null title,
  // so fall back through preview → generic label, and derive timestamps from the
  // epoch fields when the ISO created_at/updated_at aren't present.
  const updatedAt = epochToIso(remote.updated_at ?? remote.last_active ?? remote.started_at);
  const createdAt = epochToIso(remote.created_at ?? remote.started_at);
  return {
    id: remoteSyntheticId(remote.id),
    title: remote.title?.trim() || remote.preview?.trim() || 'Remote Hermes Session',
    remote_session_id: remote.id,
    status: 'remote',
    remoteOnly: true,
    source: remote.source ?? null,
    created_at: createdAt ?? null,
    updated_at: updatedAt ?? null,
    archived_at: null,
    latestRun: null,
  };
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

async function seedPiFromLegacy(db: FastifyInstance['db'], sessionId: string, sessionDir: string): Promise<void> {
  const legacy = readMessages(db, sessionId);
  if (legacy.length === 0) return;
  const sm = await openAssistantSession(sessionId, sessionDir);
  for (const m of legacy) {
    if (m.role === 'user') appendUserMessage(sm, m.content);
    else if (m.role === 'assistant') appendAssistantMessage(sm, { text: m.content });
    // system/tool legacy rows (rare) are skipped; they were never richly rendered.
  }
}

async function assistantMessages(db: FastifyInstance['db'], sessionId: string, sessionDir: string): Promise<unknown[]> {
  let entries = await readAssistantEntries(sessionId, sessionDir);
  if (entries.length === 0) {
    await seedPiFromLegacy(db, sessionId, sessionDir);
    entries = await readAssistantEntries(sessionId, sessionDir);
  }
  return flattenEntries(entries, ASSISTANT_CWD, {});
}

// Render a session's transcript. Hermes-backed sessions (anything with a
// remote_session_id — every session becomes one on first send, plus adopted
// TUI/CLI rows) render straight from `/api/sessions/{id}/messages`: the single
// source of truth, always fresh, tool-aware. Only legacy sessions that never
// reached Hermes fall back to the local pi store.
async function renderSessionMessages(
  db: FastifyInstance['db'],
  session: AssistantSession,
  sessionDir: string,
  hermes: HermesClient | undefined,
): Promise<unknown[]> {
  if (session.remote_session_id && hermes) {
    try {
      const remote = await hermes.getSessionMessages(session.remote_session_id);
      return hermesMessagesToTranscript(remote);
    } catch {
      // Hermes unreachable → empty rather than a stale local mirror.
      return [];
    }
  }
  return assistantMessages(db, session.id, sessionDir);
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
  ).run(id, title?.trim() || NEW_ASSISTANT_SESSION_TITLE, now, now);
  return db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSession;
}

function ensureDefaultSession(db: FastifyInstance['db']): AssistantSession {
  return newestSession(db) ?? createSession(db, 'Assistant');
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
    const activeStreamControllers = new Map<string, AbortController>();
    const uploadRoot = options.uploadRoot ?? process.cwd();
    const assistantSessionDir = options.assistantSessionDir
      ?? (fastify.pi ? fastify.pi.sessionDirFor(ASSISTANT_CWD) : join(uploadRoot, 'assistant-sessions'));

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

      const run = createRun(db, session.id, 'chat', promptContent);
      activeRemoteRuns.set(run.id, '');
      fastify.activity?.bus.emit({ type: 'start', operationId: run.id, kind: 'assistant_stream', title: session.title, provider: 'assistant', model: 'hermes-agent' });

      reply.hijack();
      reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      const write = (ev: unknown) => { try { reply.raw.write(JSON.stringify(ev) + '\n'); } catch { /* client gone */ } };
      const startedAtIso = new Date().toISOString();
      write({ kind: 'run_start', run: { runId: run.id, threadId: session.id, startedAt: startedAtIso, provider: 'assistant', model: 'hermes-agent' } });

      // Name the session from its opening prompt, in parallel with the turn.
      // See the matching call in routes/chat.ts for why this is fire-and-forget.
      void autoTitleSession(
        db,
        { table: 'assistant_sessions', id: session.id, currentTitle: session.title, placeholder: NEW_ASSISTANT_SESSION_TITLE },
        trimmed,
      ).then((title) => {
        if (title) write({ kind: 'session_title', sessionId: session.id, title });
      });

      let accumulated = '';
      let status: string = 'completed';
      let errorMsg: string | undefined;
      let abortSource: string | undefined;
      const sessionKey = `nexus:assistant:${session.id}`;
      try {
        // Both paths run against the session-scoped Hermes endpoints, which persist
        // the full turn (user + assistant + tool rows) to SessionDB. Nexus keeps no
        // local transcript mirror — history reloads from /messages (the single
        // source of truth). The session must exist in Hermes first (/chat/stream
        // 404s otherwise), so ensure it before either call.
        const remoteSessionId = await ensureRemoteSession(hermes, session);

        if (hasImageAttachments(savedAttachments)) {
          // Vision path stays non-streaming: one sessionChat call, surfaced as a text delta.
          const result = await hermes.sessionChat({ sessionId: remoteSessionId, sessionKey, input: hermesInlineImageInput(promptContent, savedAttachments) });
          accumulated = result.output ?? '';
          if (accumulated) write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: accumulated } });
          completeRun(db, run, { runId: run.id, status: 'completed', sessionId: result.sessionId, output: accumulated, usage: result.usage });
        } else {
          const ac = new AbortController();
          activeStreamControllers.set(run.id, ac);
          // /chat/stream tool SSE carries tool_name but no tool_call_id, so correlate
          // each tool_started → the next tool_completed of the same name (FIFO) with a
          // synthetic id. This drives the LIVE fold; the authoritative fold (real ids,
          // full output) comes from /messages on reload.
          let toolSeq = 0;
          const pendingTools: Array<{ name: string; id: string }> = [];
          try {
            for await (const ev of hermes.sessionChatStream({ sessionId: remoteSessionId, sessionKey, input: promptContent, signal: ac.signal })) {
              if (ev.kind === 'text_delta') { accumulated += ev.delta; write({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ev.delta } }); }
              else if (ev.kind === 'reasoning_delta') { write({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: ev.delta } }); }
              else if (ev.kind === 'tool_started') {
                const id = `t${toolSeq++}`;
                pendingTools.push({ name: ev.toolName, id });
                write({ type: 'tool_execution_start', toolCallId: id, toolName: ev.toolName, args: ev.args ?? {} });
              }
              else if (ev.kind === 'tool_completed') {
                const idx = pendingTools.findIndex((t) => t.name === ev.toolName);
                const id = idx >= 0 ? pendingTools.splice(idx, 1)[0].id : `t${toolSeq++}`;
                write({ type: 'tool_execution_end', toolCallId: id, toolName: ev.toolName, result: { content: [{ type: 'text', text: ev.preview }] }, isError: ev.isError });
              }
              else if (ev.kind === 'failed') { status = 'failed'; errorMsg = ev.error; write({ type: 'error', error: ev.error }); }
            }
          } catch (streamErr: any) {
            if (ac.signal.aborted || streamErr?.name === 'AbortError') {
              status = 'cancelled';
              errorMsg = undefined;
              abortSource = 'user';
            } else {
              throw streamErr;
            }
          }
          if (ac.signal.aborted && status !== 'cancelled') {
            // The stream ended (cleanly or otherwise) after we requested an abort —
            // treat it as a user cancellation rather than a normal completion.
            status = 'cancelled';
            errorMsg = undefined;
            abortSource = 'user';
          }
          if (status === 'cancelled') {
            const now = new Date().toISOString();
            db.prepare(
              `UPDATE assistant_runs
               SET status = 'cancelled', output = ?, error = NULL, completed_at = ?, updated_at = ?
               WHERE id = ?`,
            ).run(accumulated, now, now, run.id);
            db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', now, session.id);
          } else {
            completeRun(db, run, { runId: run.id, status: status as any, output: accumulated, ...(errorMsg ? { error: errorMsg } : {}) });
          }
        }
      } catch (err: any) {
        status = 'failed';
        errorMsg = err?.message || 'Assistant request failed.';
        const now = new Date().toISOString();
        db.prepare('UPDATE assistant_runs SET status = ?, error = ?, completed_at = ?, updated_at = ? WHERE id = ?').run('failed', errorMsg, now, now, run.id);
        db.prepare('UPDATE assistant_sessions SET status = ?, updated_at = ? WHERE id = ?').run('failed', now, session.id);
        write({ type: 'error', error: errorMsg });
      } finally {
        const completedAtIso = new Date().toISOString();
        write({ kind: 'run_end', run: { runId: run.id, threadId: session.id, completedAt: completedAtIso, status, ...(abortSource ? { abortSource } : {}), ...(errorMsg ? { error: errorMsg } : {}) } });
        fastify.activity?.bus.emit({ type: 'stop', operationId: run.id, kind: 'assistant_stream', title: session.title, status: activityStatusForRun(status as any), error: status === 'failed' ? errorMsg : undefined });
        activeRemoteRuns.delete(run.id);
        activeStreamControllers.delete(run.id);
        try { reply.raw.end(); } catch { /* already closed */ }
      }
    };

    fastify.get('/api/assistant/sessions', async () => {
      const localSessions = db
        .prepare('SELECT * FROM assistant_sessions WHERE archived_at IS NULL ORDER BY updated_at DESC')
        .all() as AssistantSession[];
      const localRows = localSessions.map((session) => ({
        ...session,
        remoteOnly: false,
        latestRun: publicRun(latestRun(db, session.id)),
      }));

      // Local-first: only augment with adoptable remote Hermes sessions when the
      // assistant is configured and listing succeeds. Any failure falls back to locals.
      const remoteRows: ReturnType<typeof publicRemoteSession>[] = [];
      const hermes = client();
      if (hermes) {
        const claimed = new Set<string>();
        for (const session of localSessions) {
          claimed.add(session.id);
          if (session.remote_session_id) claimed.add(session.remote_session_id);
        }
        // One request per adoptable source (the endpoint filters a single source
        // at a time). Each fetch is isolated so one failing/unavailable source
        // still lets the others render; total failure just leaves locals.
        const perSource = await Promise.all(
          HERMES_ASSISTANT_SOURCES.map((source) =>
            hermes
              .listSessions({ limit: 50, offset: 0, source, includeChildren: false })
              .then((result) => result.sessions)
              .catch(() => [] as HermesListedSession[]),
          ),
        );
        for (const remote of perSource.flat()) {
          if (!remote?.id) continue;
          if (!isAdoptableRemoteSource(remote.source)) continue;
          if (claimed.has(remote.id) || claimed.has(remoteSyntheticId(remote.id))) continue;
          claimed.add(remote.id);
          remoteRows.push(publicRemoteSession(remote));
        }
      }

      const merged = [...localRows, ...remoteRows].sort((a, b) =>
        (b.updated_at ?? '').localeCompare(a.updated_at ?? ''),
      );
      return { sessions: merged };
    });

    fastify.post('/api/assistant/sessions', async (request) => {
      const body = (request.body ?? {}) as { title?: string };
      return createSession(db, body.title);
    });

    fastify.post('/api/assistant/sessions/import', async (request, reply) => {
      const body = (request.body ?? {}) as { remoteSessionId?: string };
      const remoteSessionId = String(body.remoteSessionId ?? '').trim();
      if (!remoteSessionId) {
        reply.code(400);
        return { error: 'remoteSessionId is required' };
      }
      const hermes = client();
      if (!hermes) {
        reply.code(400);
        return { error: 'Assistant URL and key must be configured in Settings.' };
      }

      let remoteTitle: string | undefined;
      try {
        const detail = await hermes.getSession(remoteSessionId);
        remoteTitle = detail?.title?.trim() || undefined;
      } catch {
        // Tolerate a missing detail endpoint; adoption still proceeds with a fallback title.
      }

      const now = new Date().toISOString();
      let session = db
        .prepare('SELECT * FROM assistant_sessions WHERE remote_session_id = ? AND archived_at IS NULL')
        .get(remoteSessionId) as AssistantSession | undefined;
      if (!session) {
        const id = uuid();
        db.prepare(
          `INSERT INTO assistant_sessions
            (id, title, remote_session_id, status, created_at, updated_at, archived_at)
           VALUES (?, ?, ?, 'idle', ?, ?, NULL)`,
        ).run(id, remoteTitle || 'Remote Hermes Session', remoteSessionId, now, now);
        session = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as AssistantSession;
      } else if (remoteTitle && remoteTitle !== session.title) {
        db.prepare('UPDATE assistant_sessions SET title = ?, updated_at = ? WHERE id = ?').run(remoteTitle, now, session.id);
        session = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(session.id) as AssistantSession;
      }

      // Adoption is now just a local pointer at the remote session — no message
      // copy. History renders live from `/api/sessions/{id}/messages`, so the
      // adopted transcript is always fresh and never drifts from Hermes.
      return {
        session,
        messages: await renderSessionMessages(db, session, assistantSessionDir, hermes),
        latestRun: publicRun(latestRun(db, session.id)),
      };
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
        messages: await renderSessionMessages(db, session, assistantSessionDir, client()),
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
      // The background run executes against its Hermes session (the run agent is
      // created with session_id), so the whole turn persists to Hermes SessionDB
      // and renders from /messages — no local mirror. Ensure the session exists in
      // Hermes (and its remote_session_id is recorded) before handing off.
      const remoteSessionId = await ensureRemoteSession(hermes, session);
      const run = createRun(db, session.id, 'overnight', promptContent);
      const remote = await hermes.startRun({
        input: promptContent,
        sessionId: remoteSessionId,
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
          // No transcript write here: a background run executes against its Hermes
          // session (`_create_agent(session_id=…)`), so the user + assistant + tool
          // rows already persist to Hermes SessionDB and render from /messages.
          // /sync only reconciles run *status*.
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
      activeStreamControllers.get(latest.id)?.abort();
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
