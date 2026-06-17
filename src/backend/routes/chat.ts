/**
 * Chat routes — thin transport over the pi runtime.
 *
 * Per-thread AgentSession instances are created and cached by the runtime.
 * NDJSON-over-HTTP streams the pi events to the frontend.
 *
 * Concurrency: per-project active run is tracked in `chatConcurrency`. A
 * 409 with `{ kind: "project_busy", activeThreadId, activeTitle }` is
 * returned if the project is already mid-run. The frontend retries with
 * `X-Confirm-Cancel: true` to override.
 */
import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { ChatThread } from '@nexus/shared';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

const ABORT_GRACE_MS = 200;

interface ActiveStream {
  session: Pick<AgentSession, 'abort'>;
}

interface ChatImageAttachment {
  type: 'image';
  data: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  name?: string;
  size?: number;
}

interface ChatFileAttachment {
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

type ChatAttachment = ChatImageAttachment | ChatFileAttachment;

const activeStreams = new Map<string, ActiveStream>();
const CHAT_STREAM_BODY_LIMIT_BYTES = 50 * 1024 * 1024;
const allowedImageMimeTypes = new Set<ChatImageAttachment['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const allowedFileMimeTypes = new Set<ChatFileAttachment['mimeType']>([
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

function modelSupportsImageInput(model: { input?: unknown } | undefined): boolean {
  return Array.isArray(model?.input) && model.input.includes('image');
}

function dbMessages(db: FastifyInstance['db'], threadId: string) {
  let rows: Array<{
    id: string;
    role: string;
    content: string;
    attachments_json: string | null;
    thinking: string | null;
    tool_calls: string | null;
    created_at: string;
  }>;
  try {
    rows = db
      .prepare(
        'SELECT id, role, content, attachments_json, thinking, tool_calls, created_at FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC',
      )
      .all(threadId) as typeof rows;
  } catch (err: any) {
    if (String(err?.message ?? '').includes('no such table: chat_messages')) return [];
    throw err;
  }
  return rows.map((row) => {
    const attachments = parseStoredAttachments(row.attachments_json);
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      ...(row.role === 'user' && attachments.length > 0 ? { attachments } : {}),
      thinking: row.thinking,
      tool_calls: row.tool_calls ? JSON.parse(row.tool_calls) : null,
      timestamp: new Date(row.created_at).getTime(),
    };
  });
}

export async function registerChatRoutes(fastify: FastifyInstance) {
  const db = fastify.db;
  const pi = fastify.pi;
  const concurrency = fastify.chatConcurrency;

  fastify.get('/api/projects/:projectId/threads', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const rows = db
      .prepare('SELECT * FROM chat_threads WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC')
      .all(projectId);
    return rows as ChatThread[];
  });

  fastify.post('/api/projects/:projectId/threads', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const body = (request.body ?? {}) as { title?: string };
    const now = new Date().toISOString();
    const thread: ChatThread = {
      id: uuid(),
      project_id: projectId,
      title: body.title?.trim() || 'New Session',
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    db.prepare(
      'INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(thread.id, thread.project_id, thread.title, thread.created_at, thread.updated_at, thread.archived_at);
    return thread;
  });

  fastify.get('/api/threads/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) return { messages: [] };
    const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as
      | { repo_path: string }
      | undefined;
    const cwd = project?.repo_path || process.cwd();
    const entries = await pi.readMessages(threadId, cwd);
    return { thread, cwd, messages: entries.length > 0 ? flattenEntries(entries) : dbMessages(db, threadId) };
  });

  // Backwards-compat alias — the old route returned just the messages.
  fastify.get('/api/threads/:threadId/messages', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) return [];
    const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as
      | { repo_path: string }
      | undefined;
    const cwd = project?.repo_path || process.cwd();
    const entries = await pi.readMessages(threadId, cwd);
    return entries.length > 0 ? flattenEntries(entries) : dbMessages(db, threadId);
  });

  fastify.post('/api/threads/:threadId/messages/stream', { bodyLimit: CHAT_STREAM_BODY_LIMIT_BYTES }, async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const body = request.body as { content: string; modelKey?: string; images?: unknown; attachments?: unknown };
    const confirmCancel = request.headers['x-confirm-cancel'] === 'true';

    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (!thread) {
      reply.code(404);
      return { error: 'Thread not found' };
    }
    const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as
      | { repo_path: string }
      | undefined;
    const cwd = project?.repo_path || process.cwd();
    const attachmentsResult = validateChatAttachments(body.attachments, body.images);
    if (!attachmentsResult.ok) {
      reply.code(400);
      return { error: attachmentsResult.error };
    }
    const attachments = attachmentsResult.attachments;
    const images = attachments.filter((attachment): attachment is ChatImageAttachment => attachment.type === 'image');

    // Check if this project+model combination is already streaming
    const modelKey = body.modelKey || 'default';
    const busy = concurrency.get(thread.project_id, modelKey);
    if (busy && busy.threadId !== threadId) {
      if (confirmCancel) {
        const existing = activeStreams.get(busy.threadId);
        if (existing) {
          try {
            await existing.session.abort();
          } catch (err: any) {
            console.error(`[chat] failed to abort active thread ${busy.threadId}:`, err?.message);
          }
          activeStreams.delete(busy.threadId);
        }
        await new Promise((r) => setTimeout(r, ABORT_GRACE_MS));
        concurrency.clear(thread.project_id, modelKey);
      } else {
        reply.code(409);
        return {
          kind: 'model_busy',
          activeThreadId: busy.threadId,
          activeTitle: busy.title,
          modelKey: busy.modelKey,
        };
      }
    }

    let selectedModel: any;
    if (body.modelKey) {
      const sep = body.modelKey.indexOf('/');
      if (sep > 0) {
        const provider = body.modelKey.slice(0, sep);
        const modelId = body.modelKey.slice(sep + 1);
        selectedModel = pi.models.find(provider, modelId);
        if (!selectedModel) {
          reply.code(400);
          return { error: `Model not found: ${body.modelKey}` };
        }
      }
    }
    if (images.length > 0 && !modelSupportsImageInput(selectedModel)) {
      reply.code(400);
      return { error: 'Selected model does not support image input' };
    }
    const savedAttachments = saveFileAttachments(attachments, cwd);
    const promptContent = promptWithFileReferences(body.content, savedAttachments);

    let session: Pick<AgentSession, 'subscribe' | 'prompt' | 'abort' | 'setModel' | 'getContextUsage'> | undefined;
    try {
      session = await pi.sessionFor(threadId, cwd);
    } catch (err: any) {
      reply.code(500);
      return { error: err?.message || 'failed to create session' };
    }

    if (body.modelKey && selectedModel) {
      const currentModel = pi.getSessionModel(threadId, cwd);
      if (currentModel !== body.modelKey) {
        try {
          await session.setModel(selectedModel);
          pi.setSessionModel(threadId, cwd, body.modelKey);
        } catch (err: any) {
          const message = err?.message || 'failed to select model';
          console.error(`[chat] setModel failed for ${body.modelKey}:`, message);
          reply.code(400);
          return { error: message };
        }
      }
    }

    concurrency.set(thread.project_id, modelKey, threadId, thread.title);
    db.prepare('UPDATE chat_threads SET updated_at = ?, last_model_key = ? WHERE id = ?').run(
      new Date().toISOString(),
      body.modelKey || null,
      threadId,
    );

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const write = (ev: unknown) => {
      try {
        reply.raw.write(JSON.stringify(ev) + '\n');
      } catch {
        /* client gone */
      }
    };

    const persistUserTurn = db.prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, attachments_json, message_type, structured_json, thinking, tool_calls, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );

    try {
      const userMessageId = uuid();
      const userTs = new Date().toISOString();
      try {
        persistUserTurn.run(
          userMessageId,
          threadId,
          'user',
          body.content,
          JSON.stringify(savedAttachments),
          'text',
          null,
          null,
          null,
          userTs,
        );
      } catch (err: any) {
        console.error('[chat] persistUserTurn failed:', err?.message);
      }
      if (session) {
        activeStreams.set(threadId, { session });
        const subscription = session.subscribe((ev) => write(ev));
        if (images.length > 0) {
          await session.prompt(promptContent, { images });
        } else {
          await session.prompt(promptContent);
        }
        const contextUsage = safeContextUsage(session);
        if (contextUsage) write({ type: 'context_usage', usage: contextUsage });
        subscription();
      }
      write({ kind: 'done' });
    } catch (err: any) {
      write({ kind: 'error', error: err?.message || 'prompt failed' });
    } finally {
      activeStreams.delete(threadId);
      concurrency.clear(thread.project_id, modelKey);
      reply.raw.end();
    }
  });

  fastify.post('/api/threads/:threadId/abort', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const existing = activeStreams.get(threadId);
    if (!existing) return { ok: false, reason: 'no_run' };
    try {
      await existing.session.abort();
    } catch (err: any) {
      console.error(`[chat] failed to abort active thread ${threadId}:`, err?.message);
    }
    return { ok: true };
  });

  fastify.patch('/api/threads/:threadId', async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const { title } = request.body as { title?: string };
    const trimmed = title?.trim();
    if (!trimmed) {
      reply.code(400);
      return { error: 'Title cannot be empty' };
    }
    const now = new Date().toISOString();
    db.prepare('UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?').run(trimmed, now, threadId);
    return db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread;
  });

  fastify.delete('/api/threads/:threadId', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const thread = db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(threadId) as ChatThread | undefined;
    if (thread) {
      const project = db.prepare('SELECT repo_path FROM projects WHERE id = ?').get(thread.project_id) as
        | { repo_path: string }
        | undefined;
      if (project) pi.dropSession(threadId, project.repo_path);
    }
    db.prepare('DELETE FROM chat_threads WHERE id = ?').run(threadId);
    return { success: true };
  });

  fastify.post('/api/threads/:threadId/archive', async (request) => {
    const { threadId } = request.params as { threadId: string };
    const now = new Date().toISOString();
    db.prepare('UPDATE chat_threads SET archived_at = ? WHERE id = ?').run(now, threadId);
    return { success: true };
  });

  // Check if a model is currently streaming in a project
  fastify.get('/api/projects/:projectId/model-status', async (request) => {
    const { projectId } = request.params as { projectId: string };
    const { modelKey } = request.query as { modelKey?: string };
    
    if (!modelKey) {
      return { busy: false };
    }
    
    const busy = concurrency.get(projectId, modelKey);
    if (busy) {
      return {
        busy: true,
        activeThreadId: busy.threadId,
        activeTitle: busy.title,
      };
    }
    return { busy: false };
  });
}

function safeContextUsage(session: Partial<Pick<AgentSession, 'getContextUsage'>>): ReturnType<AgentSession['getContextUsage']> | undefined {
  if (typeof session.getContextUsage !== 'function') return undefined;
  try {
    return session.getContextUsage();
  } catch (err: any) {
    console.error('[chat] getContextUsage failed:', err?.message);
    return undefined;
  }
}

/**
 * Flatten pi's session-message entries into a list the frontend's
 * `usePiStream` reducer can render. Each entry is one user / assistant /
 * toolResult message. Tool calls and thinking blocks are extracted from
 * the assistant message's `content` array.
 */
function flattenEntries(entries: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const e of entries as any[]) {
    if (e.type !== 'message') continue;
    const m = e.message;
    if (!m) continue;
    if (m.role === 'user') {
      const attachments = extractChatAttachments(m);
      out.push({
        id: e.id,
        role: 'user',
        content: typeof m.content === 'string' ? m.content : extractText(m.content),
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: m.timestamp ?? e.timestamp,
      });
    } else if (m.role === 'assistant') {
      let text = '';
      let thinking = '';
      const toolCalls: unknown[] = [];
      for (const block of m.content ?? []) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'thinking') thinking += block.thinking;
        else if (block.type === 'toolCall') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            args: block.arguments,
            status: 'completed',
          });
        }
      }
      const isError = m.stopReason === 'error' || !!m.errorMessage;
      if (isError && !text) {
        text = formatProviderError(m.errorMessage) || 'Provider returned an error with no message.';
      }
      out.push({
        id: e.id,
        role: 'assistant',
        content: text,
        thinking: thinking || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : null,
        model: m.model,
        provider: m.provider,
        isError,
        stopReason: m.stopReason,
        errorMessage: m.errorMessage,
        timestamp: m.timestamp ?? e.timestamp,
      });
    } else if (m.role === 'toolResult') {
      out.push({
        id: e.id,
        role: 'toolResult',
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: extractText(m.content),
        isError: m.isError,
        timestamp: m.timestamp ?? e.timestamp,
      });
    }
  }
  return out;
}

function validateChatAttachments(
  attachments: unknown,
  legacyImages?: unknown,
): { ok: true; attachments: ChatAttachment[] } | { ok: false; error: string } {
  const input = attachments === undefined ? legacyImages : attachments;
  const field = attachments === undefined ? 'images' : 'attachments';
  if (input === undefined) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: `${field} must be an array` };
  if (input.length > 5) {
    return { ok: false, error: field === 'images' ? 'images must contain at most 5 images' : 'attachments must contain at most 5 files' };
  }

  const validated: ChatAttachment[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = input[index] as any;
    if (!item || typeof item !== 'object') {
      return { ok: false, error: `${field}[${index}] must be an object` };
    }
    if (item.type !== 'image' && item.type !== 'file') {
      return { ok: false, error: `${field}[${index}].type must be "image" or "file"` };
    }
    if (typeof item.data !== 'string' || item.data.length === 0) {
      return { ok: false, error: `${field}[${index}].data must be a non-empty string` };
    }
    if (
      item.type === 'image' &&
      (typeof item.mimeType !== 'string' || !allowedImageMimeTypes.has(item.mimeType as ChatImageAttachment['mimeType']))
    ) {
      return { ok: false, error: `${field}[${index}].mimeType has unsupported image MIME type` };
    }
    if (
      item.type === 'file' &&
      (typeof item.mimeType !== 'string' || !allowedFileMimeTypes.has(item.mimeType as ChatFileAttachment['mimeType']))
    ) {
      return { ok: false, error: `${field}[${index}].mimeType has unsupported file MIME type` };
    }
    if (item.type === 'file' && (typeof item.name !== 'string' || item.name.trim().length === 0)) {
      return { ok: false, error: `${field}[${index}].name must be a non-empty string` };
    }
    if (item.name !== undefined && typeof item.name !== 'string') {
      return { ok: false, error: `${field}[${index}].name must be a string` };
    }
    if (item.size !== undefined && (!Number.isFinite(item.size) || item.size < 0)) {
      return { ok: false, error: `${field}[${index}].size must be a non-negative number` };
    }
    if (item.path !== undefined && typeof item.path !== 'string') {
      return { ok: false, error: `${field}[${index}].path must be a string` };
    }

    if (item.type === 'image') {
      validated.push({
        type: 'image',
        data: item.data,
        mimeType: item.mimeType,
        ...(item.name !== undefined ? { name: item.name } : {}),
        ...(item.size !== undefined ? { size: item.size } : {}),
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

function saveFileAttachments(attachments: ChatAttachment[], cwd: string): ChatAttachment[] {
  if (!attachments.some((attachment) => attachment.type === 'file')) return attachments;
  const uploadsDir = path.join(cwd, 'project_docs', 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  return attachments.map((attachment) => {
    if (attachment.type !== 'file') return attachment;
    const filename = uniqueUploadFilename(uploadsDir, attachment.name);
    const filePath = path.join(uploadsDir, filename);
    writeFileSync(filePath, Buffer.from(attachment.data, 'base64'));
    return { ...attachment, name: filename, path: filePath };
  });
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

function promptWithFileReferences(content: string, attachments: ChatAttachment[]): string {
  const files = attachments.filter((attachment): attachment is ChatFileAttachment => attachment.type === 'file' && !!attachment.path);
  if (files.length === 0) return content;
  const lines = files.map((file) => `- ${file.name}: ${file.path}`);
  return `${content}\n\nAttached files:\n${lines.join('\n')}`;
}

function parseStoredAttachments(value: string | null): ChatAttachment[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    const validated = validateChatAttachments(parsed);
    return validated.ok ? validated.attachments : [];
  } catch {
    return [];
  }
}

function extractChatAttachments(message: any): ChatAttachment[] {
  const candidates: unknown[] = [];
  if (Array.isArray(message?.attachments)) candidates.push(...message.attachments);
  if (Array.isArray(message?.images)) candidates.push(...message.images);
  if (Array.isArray(message?.content)) {
    candidates.push(...message.content.filter((block: any) => block?.type === 'image'));
  }
  const validated = validateChatAttachments(candidates);
  return validated.ok ? validated.attachments : [];
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (typeof b === 'object' && b?.type === 'text' ? b.text : ''))
    .join('');
}

function formatProviderError(message: unknown): string {
  if (typeof message !== 'string' || !message.trim()) return '';
  const trimmed = message.trim();
  const jsonStart = trimmed.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart));
      const providerMessage = parsed?.error?.message ?? parsed?.message;
      if (typeof providerMessage === 'string' && providerMessage.trim()) return providerMessage;
    } catch {
      /* fall through */
    }
  }
  return trimmed;
}
