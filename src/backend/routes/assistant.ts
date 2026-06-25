import { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import { loadConfig, resolveAssistantKey, resolveEnvVars } from '../config.js';
import type { NexusConfig } from '@nexus/shared';

interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

let activeAssistantAbort: AbortController | null = null;

function configuredAssistant(load: () => NexusConfig) {
  const config = load();
  const url = resolveEnvVars(config.assistant.url || '').trim();
  const key = resolveAssistantKey(config);
  return { url, key };
}

function readMessages(db: FastifyInstance['db']): AssistantMessage[] {
  return db
    .prepare('SELECT id, role, content, created_at FROM assistant_messages ORDER BY created_at ASC')
    .all() as AssistantMessage[];
}

function appendMessage(db: FastifyInstance['db'], role: AssistantMessage['role'], content: string) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO assistant_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)').run(
    uuid(),
    role,
    content,
    now,
  );
}

function assistantRequestBody(messages: AssistantMessage[], content: string) {
  return {
    model: 'assistant',
    stream: true,
    messages: [
      ...messages.map((message) => ({ role: message.role, content: message.content })),
      { role: 'user', content },
    ],
  };
}

function extractOpenAiDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed || trimmed === 'data: [DONE]') return '';
  const jsonText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
  if (!jsonText) return '';
  try {
    const parsed = JSON.parse(jsonText);
    return parsed?.choices?.[0]?.delta?.content ?? parsed?.choices?.[0]?.message?.content ?? parsed?.delta ?? parsed?.content ?? '';
  } catch {
    return '';
  }
}

function assistantEndpoint(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return trimmed;
}

export function createAssistantRoutes(load: () => NexusConfig = loadConfig) {
  return async function registerAssistantRoutes(fastify: FastifyInstance) {
  const db = fastify.db;

  fastify.get('/api/assistant/thread', async () => {
    return { id: 'global', messages: readMessages(db) };
  });

  fastify.delete('/api/assistant/thread', async () => {
    if (activeAssistantAbort) {
      activeAssistantAbort.abort();
      activeAssistantAbort = null;
    }
    db.prepare('DELETE FROM assistant_messages').run();
    return { ok: true, id: 'global' };
  });

  fastify.post('/api/assistant/messages/stream', async (request, reply) => {
    const body = (request.body ?? {}) as { content?: string };
    const content = body.content?.trim() ?? '';
    if (!content) {
      reply.code(400);
      return { error: 'Message content is required.' };
    }

    const { url, key } = configuredAssistant(load);
    if (!url || !key) {
      reply.code(400);
      return { error: 'Assistant URL and key must be configured in Settings.' };
    }

    const priorMessages = readMessages(db);
    appendMessage(db, 'user', content);

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    const write = (event: unknown) => {
      try {
        reply.raw.write(JSON.stringify(event) + '\n');
      } catch {
        /* client gone */
      }
    };

    const controller = new AbortController();
    activeAssistantAbort = controller;
    let assistantText = '';
    const operationId = uuid();
    fastify.activity?.bus.emit({
      type: 'start',
      operationId,
      kind: 'assistant_stream',
      title: 'Assistant',
      provider: 'assistant',
      model: 'assistant',
    });

    try {
      const response = await fetch(assistantEndpoint(url), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(assistantRequestBody(priorMessages, content)),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(errorText || `Assistant request failed with ${response.status}`);
      }
      if (!response.body) throw new Error('Assistant response did not include a stream.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const delta = extractOpenAiDelta(line);
          if (!delta) continue;
          assistantText += delta;
          write({ type: 'text_delta', delta });
        }
      }
      const finalDelta = extractOpenAiDelta(pending);
      if (finalDelta) {
        assistantText += finalDelta;
        write({ type: 'text_delta', delta: finalDelta });
      }
      if (assistantText) appendMessage(db, 'assistant', assistantText);
      write({ type: 'complete' });
      fastify.activity?.bus.emit({
        type: 'stop',
        operationId,
        kind: 'assistant_stream',
        title: 'Assistant',
        status: 'succeeded',
      });
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      const message = isAbort ? 'Assistant request aborted.' : err?.message || 'Assistant request failed.';
      write({ type: 'error', error: message });
      fastify.activity?.bus.emit({
        type: 'stop',
        operationId,
        kind: 'assistant_stream',
        title: 'Assistant',
        status: isAbort ? 'cancelled' : 'failed',
        error: message,
      });
    } finally {
      if (activeAssistantAbort === controller) activeAssistantAbort = null;
      reply.raw.end();
    }
  });

  fastify.post('/api/assistant/abort', async () => {
    if (!activeAssistantAbort) return { ok: false, reason: 'no_run' };
    activeAssistantAbort.abort();
    activeAssistantAbort = null;
    return { ok: true };
  });
  };
}

export const registerAssistantRoutes = createAssistantRoutes();
