import type { FastifyInstance } from 'fastify';
import { resolveEnvVars } from '../config.js';
import { parseAgentBridgeEnvelope } from '../agent-bridge/protocol.js';
import type { AgentBridgeService } from '../agent-bridge/service.js';
import type { AgentBridgeMessage, AgentBridgeMessageStatus } from '../agent-bridge/store.js';

interface ManagedTurnResult { completed: boolean; error?: string }
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
      }),
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
    const message = service.store.get(id);
    if (!message) {
      reply.code(404);
      return { error: 'Agent Bridge message not found' };
    }
    if (message.status !== 'pending_approval') {
      reply.code(409);
      return { error: `Message cannot be approved from status ${message.status}` };
    }
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
        service.store.transition(
          id,
          'running',
          result.completed ? 'completed' : 'failed',
          result.error,
        );
      })
      .catch((error) => {
        service.store.transition(
          id,
          'running',
          'failed',
          error instanceof Error ? error.message : 'Managed turn failed',
        );
      });
    reply.code(202);
    return running;
  });

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
  for (;;) {
    const { done, value } = await reader.read();
    carry += decoder.decode(value, { stream: !done });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.includes('"kind":"run_end"')) continue;
      try { terminal = JSON.parse(line).run; } catch { /* malformed event; final check below */ }
    }
    if (done) break;
  }
  if (!terminal) return { completed: false, error: 'Managed turn ended without a terminal event' };
  return terminal.status === 'completed'
    ? { completed: true }
    : { completed: false, error: terminal.error || `Managed turn ${terminal.status || 'failed'}` };
}
