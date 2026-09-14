import type { AgentBridgeResultEnvelope } from '@nexus/shared';
import type { FastifyInstance } from 'fastify';
import { resolveEnvVars } from '../config.js';
import { parseAgentBridgeEnvelope } from '../agent-bridge/protocol.js';
import type { AgentBridgeService } from '../agent-bridge/service.js';
import type { AgentBridgeMessage, AgentBridgeMessageStatus } from '../agent-bridge/store.js';

interface ManagedTurnResult { completed: boolean; status?: AgentBridgeResultEnvelope['status']; content?: string; error?: string }
type ManagedTurnRunner = (message: AgentBridgeMessage, modelKey: string) => Promise<ManagedTurnResult>;

export interface RegisterAgentBridgeRoutesOptions {
  service?: AgentBridgeService;
  runManagedTurn?: ManagedTurnRunner;
}

const STATUSES = new Set<AgentBridgeMessageStatus>([
  'received', 'pending_approval', 'running', 'completed', 'rejected', 'failed',
]);

export async function registerAgentBridgeRoutes(
  fastify: FastifyInstance,
  options: RegisterAgentBridgeRoutesOptions = {},
) {
  const service = options.service ?? fastify.agentBridge;
  const runManagedTurn = options.runManagedTurn ?? createManagedTurnRunner({ port: 4173, token: '' });

  fastify.get('/api/agent-bridge/status', async () => service.status());

  fastify.get('/api/agent-bridge/targets', async () => {
    const projects = service.config.enabled ? service.store.projects().filter(project => project.enabled) : [];
    const updated = (table: 'projects' | 'chat_threads', id: string): string =>
      (fastify.db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id) as { updated_at: string }).updated_at;
    return {
      instanceId: service.config.instance_id, enabled: service.config.enabled, mode: service.config.mode,
      maxMessageBytes: service.config.max_message_bytes,
      projects: projects.map(project => ({ id: project.id, name: project.name, updatedAt: updated('projects', project.id),
        threads: project.threads.filter(thread => project.thread_ids === null || project.thread_ids.includes(thread.id))
          .map(thread => ({ id: thread.id, name: thread.title, updatedAt: updated('chat_threads', thread.id) })),
      })).filter(project => project.threads.length > 0),
    };
  });

  fastify.get('/api/agent-bridge/projects', async () => ({ projects: service.store.projects() }));

  fastify.put('/api/agent-bridge/projects/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = service.store.projects().find(project => project.id === id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const body = request.body as { enabled?: unknown; thread_ids?: unknown } | null;
    if (!body || typeof body.enabled !== 'boolean' ||
      !(body.thread_ids === null || (Array.isArray(body.thread_ids) && body.thread_ids.every(id => typeof id === 'string')))) {
      return reply.code(400).send({ error: 'Provide enabled and thread_ids (null for all threads or an array of thread IDs)' });
    }
    const threadIds = body.thread_ids === null ? null : [...new Set(body.thread_ids as string[])];
    if (threadIds?.some(id => !project.threads.some(thread => thread.id === id))) {
      return reply.code(400).send({ error: 'Every selected thread must belong to this project' });
    }
    const policy = { enabled: body.enabled, thread_ids: threadIds };
    service.store.setPolicy(id, policy);
    return { ...project, ...policy };
  });

  fastify.get('/api/agent-bridge/messages', async (request, reply) => {
    const query = (request.query ?? {}) as { status?: string; limit?: string };
    if (query.status && !STATUSES.has(query.status as AgentBridgeMessageStatus)) {
      reply.code(400);
      return { error: 'Unknown Agent Bridge message status' };
    }
    const parsedLimit = Number.parseInt(query.limit ?? '50', 10);
    return {
      messages: service.store.list({
        ...(query.status ? { status: query.status as AgentBridgeMessageStatus } : {}),
        limit: Number.isFinite(parsedLimit) ? parsedLimit : 50,
      }).map((message) => ({ ...message, reply: service.store.reply(message.id) })),
    };
  });

  // Authenticated HTTP ingress is useful for protocol diagnostics and clients
  // without NATS tooling. It follows the exact same validation/persistence path.
  fastify.post('/api/agent-bridge/messages', async (request, reply) => {
    if (!service.config.enabled) {
      reply.code(503);
      return { error: 'Agent Bridge is disabled' };
    }
    try {
      // Parse here only to produce a clean 400; service.ingest parses again at
      // the actual trust boundary so NATS and HTTP cannot drift.
      parseAgentBridgeEnvelope(request.body, service.config.max_message_bytes);
      const result = service.ingest(request.body);
      reply.code(result.accepted ? 202 : 403);
      return result;
    } catch (error) {
      reply.code(400);
      return { error: error instanceof Error ? error.message : 'Invalid Agent Bridge envelope' };
    }
  });

  fastify.post('/api/agent-bridge/messages/:id/approve', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.config.enabled) { reply.code(503); return { error: 'Agent Bridge is disabled' }; }
    const message = service.store.get(id);
    if (!message) {
      reply.code(404);
      return { error: 'Agent Bridge message not found' };
    }
    if (message.status !== 'pending_approval') {
      reply.code(409);
      return { error: `Message cannot be approved from status ${message.status}` };
    }
    const scopeError = service.store.scopeRejection(message.project_id, message.thread_id);
    if (scopeError) return reply.code(409).send({ error: scopeError });
    const thread = fastify.db.prepare(
      'SELECT last_model_key FROM chat_threads WHERE id = ? AND project_id = ?',
    ).get(message.thread_id, message.project_id) as { last_model_key: string | null } | undefined;
    if (!thread) {
      reply.code(409);
      return { error: 'Target thread no longer exists in the target project' };
    }
    if (!thread.last_model_key) {
      reply.code(409);
      return { error: 'Choose a model in the target thread before approving bridge work' };
    }
    const running = service.store.transition(id, 'pending_approval', 'running');
    if (!running) {
      reply.code(409);
      return { error: 'Message was already handled' };
    }

    void runManagedTurn(running, thread.last_model_key)
      .then((result) => {
        service.store.complete(running, result, service.config.instance_id);
      })
      .catch((error) => {
        service.store.complete(running, { completed: false, error: error instanceof Error ? error.message : 'Managed turn failed' }, service.config.instance_id);
      });
    reply.code(202);
    return running;
  });

  // Separate human confirmation: approving a run never authorizes a reply.
  fastify.post('/api/agent-bridge/messages/:id/reply/send', async (request, reply) => {
    if (!service.config.enabled) { reply.code(503); return { error: 'Agent Bridge is disabled' }; }
    const { id } = request.params as { id: string };
    const draft = service.store.reply(id);
    if (!draft) { reply.code(404); return { error: 'No completion reply available' }; }
    if (draft.status === 'dead_letter' || draft.status === 'discarded') {
      return reply.code(409).send({ error: `Reply cannot be sent from status ${draft.status}` });
    }
    if (draft.status !== 'pending_approval') return reply.code(202).send(draft);
    service.store.approveReply(id);
    void service.flushReplies();
    reply.code(202);
    return service.store.reply(id);
  });

  for (const action of ['retry', 'discard'] as const) {
    fastify.post(`/api/agent-bridge/messages/:id/reply/${action}`, async (request, reply) => {
      if (action === 'retry' && !service.config.enabled) return reply.code(503).send({ error: 'Agent Bridge is disabled' });
      const { id } = request.params as { id: string };
      const current = service.store.reply(id);
      if (!current) return reply.code(404).send({ error: 'No completion reply available' });
      const updated = action === 'retry' ? service.store.retryReply(id) : service.store.discardReply(id);
      if (!updated) return reply.code(409).send({ error: `Reply cannot be ${action === 'retry' ? 'retried' : 'discarded'} from status ${current.status}` });
      if (action === 'retry') void service.flushReplies();
      return reply.code(action === 'retry' ? 202 : 200).send(updated);
    });
  }

  fastify.post('/api/agent-bridge/messages/:id/reject', async (request, reply) => {
    const { id } = request.params as { id: string };
    const message = service.store.get(id);
    if (!message) {
      reply.code(404);
      return { error: 'Agent Bridge message not found' };
    }
    const rejected = service.store.transition(id, 'pending_approval', 'rejected', 'rejected by user');
    if (!rejected) {
      reply.code(409);
      return { error: `Message cannot be rejected from status ${message.status}` };
    }
    return rejected;
  });
}

export function createManagedTurnRunner(backend: { port: number; token: string }): ManagedTurnRunner {
  return async (message, modelKey) => {
    const token = resolveEnvVars(backend.token || '');
    const response = await fetch(
      `http://127.0.0.1:${backend.port}/api/threads/${encodeURIComponent(message.thread_id)}/messages/stream`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          modelKey,
          content: `[Agent Bridge · untrusted external message from ${message.sender_display_name || message.sender_id}]\n\n${message.content}`,
        }),
      },
    );
    if (!response.ok) {
      const body = await response.text();
      let detail = body;
      try { detail = JSON.parse(body).error || body; } catch { /* plain text */ }
      return { completed: false, error: `Managed turn was refused (${response.status}): ${detail || response.statusText}` };
    }
    return readTerminalRun(response);
  };
}

async function readTerminalRun(response: Response): Promise<ManagedTurnResult> {
  if (!response.body) return { completed: false, error: 'Managed turn returned no event stream' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let terminal: { status?: string; error?: string } | undefined;
  let content = '';
  for (;;) {
    const { done, value } = await reader.read();
    carry += decoder.decode(value, { stream: !done });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    if (done && carry.trim()) { lines.push(carry); carry = ''; }
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.kind === 'run_end') terminal = event.run;
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          const blocks = event.message.content;
          if (Array.isArray(blocks)) content = blocks.filter((block: any) => block.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n').slice(0, 8000);
        }
      } catch { /* malformed event; final check below */ }
    }
    if (done) break;
  }
  if (!terminal) return { completed: false, error: 'Managed turn ended without a terminal event' };
  return terminal.status === 'completed'
    ? { completed: true, status: 'completed', content }
    : { completed: false, content, status: terminal.status === 'cancelled' || terminal.status === 'interrupted' ? terminal.status : 'failed', error: terminal.error || `Managed turn ${terminal.status || 'failed'}` };
}
