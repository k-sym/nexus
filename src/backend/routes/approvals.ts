/**
 * In-app tool approvals.
 *
 * Until now the only way to answer a parked tool-gate was the glasses cockpit
 * gateway (`src/backend/gateway/server.ts`). That made Supervise unusable from
 * a laptop with no G2 on your face: every gate sat there until the 5-minute
 * default-deny fired. These routes put the same queue in front of the Nexus UI.
 *
 * Both surfaces read and write the one `ApprovalBroker`, so they see the same
 * gates and whichever answers first wins — the loser's client is told the gate
 * resolved through the broker's normal `resolved` event, exactly as if it had
 * timed out or been aborted. There is no second source of truth to reconcile.
 *
 * Phase 2 of #266.
 *
 * Scope note: this surfaces tool-gates only, not the `question` tool's pending
 * questions. Questions already have an in-app path (they render inline in the
 * chat thread); the glasses merge the two queues because the G2 has one card
 * stack, not because they are the same thing.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PendingApprovalView } from '../pi/approvals.js';
import { categorizeTool, type ToolCategory } from '../pi/tool-policy.js';
import { corsHeaders } from '../cors-headers.js';

/** A pending gate as the UI needs it. `category` lets the client style a
 *  `bash` gate differently from a read, without duplicating the classification. */
export interface PendingApprovalDto {
  threadId: string;
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  input: unknown;
  cwd: string;
  requestedAt: number;
}

export type ApprovalStreamEvent =
  | { kind: 'snapshot'; approvals: PendingApprovalDto[] }
  | { kind: 'pending'; approval: PendingApprovalDto }
  | { kind: 'resolved'; threadId: string; toolCallId: string };

/** Heartbeat cadence. Matches the gateway's SSE heartbeat so a dead connection
 *  is noticed on the same timescale on both surfaces. */
const HEARTBEAT_MS = 15_000;

export function toPendingDto(view: PendingApprovalView): PendingApprovalDto {
  return {
    threadId: view.threadId,
    toolCallId: view.toolCallId,
    toolName: view.toolName,
    category: categorizeTool(view.toolName),
    input: view.input,
    cwd: view.cwd,
    requestedAt: view.requestedAt,
  };
}

export async function registerApprovalRoutes(fastify: FastifyInstance): Promise<void> {
  const broker = () => fastify.pi.approvals;

  fastify.get('/api/approvals', async () => ({
    approvals: broker().listPending().map(toPendingDto),
  }));

  // The decision audit trail (#281 part 2): most-recent gated decisions first.
  fastify.get('/api/approvals/audit', async (request) => {
    const raw = (request.query as { limit?: string } | undefined)?.limit;
    const limit = raw ? Number.parseInt(raw, 10) : 100;
    const decisions = fastify.approvalAudit?.list(Number.isFinite(limit) ? limit : 100) ?? [];
    return { decisions };
  });

  fastify.post('/api/approvals/:id/decision', async (request, reply) => {
    const { id: toolCallId } = request.params as { id: string };
    const body = (request.body ?? {}) as { action?: string; reason?: string };
    const action = body.action === 'deny' ? 'deny' : 'allow';

    // Look the gate up by tool call id alone: the UI does not need to know
    // which thread owns it, and ids are unique across threads in practice.
    const gate = broker().listPending().find((v) => v.toolCallId === toolCallId);
    if (!gate) {
      // Already resolved — by the glasses, a timeout, or an abort. A 404 is the
      // honest answer, and the client's stream has already been told.
      reply.code(404);
      return { error: 'unknown approval' };
    }

    const result = broker().decide(gate.threadId, toolCallId, action, body.reason);
    if (!result.ok) {
      reply.code(result.status);
      return { error: result.error };
    }
    return { ok: true };
  });

  /**
   * Live queue as NDJSON: one `snapshot` then `pending`/`resolved` as they
   * happen. NDJSON rather than SSE because `EventSource` cannot send an
   * `Authorization` header, and the backend is token-gated in thin-client mode
   * — the chat stream made the same call for the same reason.
   *
   * Holding this stream open is what marks a client as *attached*, which is
   * what buys gates the longer attended timeout.
   */
  fastify.get('/api/approvals/stream', async (request: FastifyRequest, reply) => {
    reply.hijack();
    // Hijacked replies bypass @fastify/cors, so the allow-origin header has to
    // be written by hand or a cross-origin (Tailscale) client is blocked.
    reply.raw.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      ...corsHeaders(request),
    });

    let closed = false;
    const write = (event: ApprovalStreamEvent | null) => {
      if (closed) return;
      try {
        reply.raw.write(event === null ? '\n' : `${JSON.stringify(event)}\n`);
      } catch {
        cleanup();
      }
    };

    // Subscribe BEFORE snapshotting, so a gate registered between the two is
    // delivered as a `pending` rather than dropped. The client tolerates a
    // duplicate (it keys by toolCallId); it cannot recover from a miss.
    const unsubscribe = broker().subscribe((event) => {
      if (event.type === 'pending') write({ kind: 'pending', approval: toPendingDto(event.view) });
      else write({ kind: 'resolved', threadId: event.threadId, toolCallId: event.toolCallId });
    });

    write({ kind: 'snapshot', approvals: broker().listPending().map(toPendingDto) });

    const detach = broker().attachClient();
    // A bare newline is ignored by the NDJSON reader but proves liveness and
    // keeps intermediaries from reaping an idle connection.
    const heartbeat = setInterval(() => write(null), HEARTBEAT_MS);
    heartbeat.unref?.();

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      // Detaching may re-arm pending gates onto the shorter unattended timeout.
      detach();
      try { reply.raw.end(); } catch { /* already gone */ }
    }

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
