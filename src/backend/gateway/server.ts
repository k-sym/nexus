/**
 * Glasses cockpit gateway.
 *
 * A second Fastify listener, started inside the main Nexus backend process and
 * closing over the same `pi` + `db`, that serves the Even Realities G2 glasses
 * (session-cockpit) the exact 10 routes they already speak — so the glasses
 * app needs no changes, only a base URL pointed here.
 *
 * It binds the LAN (0.0.0.0) so the glasses can reach it, guarded by a bearer
 * token; the main app stays on localhost. Steering is driven by loopback POST
 * to the main app's existing chat/assistant stream endpoints.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import type { PiRuntime } from '../pi/runtime.js';
import { buildDetail, buildSessions, resolveSession, type Scope } from './sessions.js';
import { questionToApproval, toolCallToApproval, translateGlassesAnswer } from './mappers.js';
import type { Approval, SseEvent } from './types.js';

interface Db {
  prepare(sql: string): { get(...args: unknown[]): any; all(...args: unknown[]): any; run(...args: unknown[]): any };
}

export interface GatewayConfig {
  enabled: boolean;
  port: number;
  /** Resolved (env-expanded) bearer token; '' means dev-open (no auth). */
  token: string;
  recentMs: number;
  /** Absolute path to the built glasses SPA. When set + present, the gateway
   *  serves it at `/` so UI + API share one origin. Empty ⇒ API only. */
  glassesDist?: string;
  /** STT config (env already resolved) handed to the glasses at load so the key
   *  lives in Nexus config, not the client. Empty apiKey ⇒ voice disabled. */
  stt?: { provider: string; apiKey: string; language: string };
}

export interface GatewayDependencies {
  pi: PiRuntime;
  db: Db;
  /** Main backend port for loopback steer/detail. */
  mainPort: number;
  config: GatewayConfig;
}

export interface GatewayHandle {
  app: FastifyInstance;
  close: () => Promise<void>;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
  const q = (request.query as Record<string, unknown> | undefined)?.token;
  return typeof q === 'string' ? q : undefined;
}

function scopeFromQuery(query: Record<string, unknown> | undefined): Scope {
  if (!query) return 'active';
  if (query.active === '1' || query.active === 'true') return 'active';
  if (query.recent === '1' || query.recent === 'true') return 'recent';
  const scope = query.scope;
  if (scope === 'recent' || scope === 'all' || scope === 'active') return scope;
  return 'active';
}

export function createGatewayApp(deps: GatewayDependencies): GatewayHandle {
  const { pi, db, mainPort, config } = deps;
  const app = Fastify({ logger: false });

  // ── in-memory gateway state ────────────────────────────────────────────────
  // Pi steering just sends a prompt, so there is no Claude-Code-style "arm" gate.
  // `armed` stays true for wire compatibility with the glasses' hello/state.
  let armed = true;
  let steerFocus: string | null = null;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  const sseClients = new Set<ServerResponse>();

  const gatewayDeps = { db, pi, mainPort, recentMs: config.recentMs };

  const cwdForThread = (threadId: string): string => resolveSession(db, threadId)?.cwd ?? '';

  // Both brokers feed the glasses' one approval queue: structured questions as
  // `kind:'question'`, supervised tool-gates as `kind:'approval'`. Their ids
  // (tool call ids) don't collide, so a decision routes by which broker owns it.
  const currentApprovals = (): Approval[] => [
    ...pi.questions.listPending().map((view) => questionToApproval(view, cwdForThread(view.threadId))),
    ...pi.approvals.listPending().map((view) => toolCallToApproval(view)),
  ];

  const broadcast = (event: SseEvent): void => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  const setArmed = (next: boolean, reason?: string, ttlSec?: number): void => {
    armed = next;
    if (disarmTimer) {
      clearTimeout(disarmTimer);
      disarmTimer = undefined;
    }
    if (next && ttlSec && ttlSec > 0) {
      disarmTimer = setTimeout(() => {
        armed = false;
        broadcast({ type: 'armed', armed: false, reason: 'ttl' });
      }, ttlSec * 1000);
    }
    broadcast({ type: 'armed', armed, ...(reason ? { reason } : {}) });
  };

  // Push pending/resolved SSE the instant a question registers or resolves,
  // driven directly by the QuestionBroker rather than a poll-diff — so a session
  // lights up the moment it needs input. listPending() is the only source of
  // pending questions and every entry emits exactly one pending then one
  // resolved, so this fully covers the approval lifecycle. Skip the work (a per
  // question DB read for cwd) when no one is listening.
  const unsubscribeQuestions = pi.questions.subscribe((event) => {
    if (sseClients.size === 0) return;
    if (event.type === 'pending') {
      broadcast({ type: 'pending', approval: questionToApproval(event.view, cwdForThread(event.view.threadId)) });
    } else {
      broadcast({ type: 'resolved', id: event.toolCallId, action: '', reason: '' });
    }
  });

  // Same push wiring for supervised tool-gates: a gate lights the session up the
  // instant it parks and clears it the instant it resolves (allow/deny/timeout).
  const unsubscribeApprovals = pi.approvals.subscribe((event) => {
    if (sseClients.size === 0) return;
    if (event.type === 'pending') {
      broadcast({ type: 'pending', approval: toolCallToApproval(event.view) });
    } else {
      broadcast({ type: 'resolved', id: event.toolCallId, action: '', reason: '' });
    }
  });

  const heartbeatTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(': hb\n\n');
      } catch {
        sseClients.delete(res);
      }
    }
  }, 15000);

  app.register(cors, { origin: true });

  // ── auth: gate only the API (except health); the UI bundle is public ────────
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return; // static UI assets load without a token
    if (path === '/api/health') return;
    if (!config.token) return;
    if (bearerToken(request) !== config.token) {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // ── routes ──────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    armed,
    pending: pi.questions.listPending().length + pi.approvals.listPending().length,
    dev: !config.token,
  }));

  app.get('/api/state', async () => ({ armed, steerFocus, pending: currentApprovals(), supervised: pi.listSupervised() }));

  // Toggle the tool-permission "Supervise" gate for a chat session. Per-session,
  // off by default; when on, that session's tool calls park as `kind:'approval'`
  // gates until allowed/denied. Resolving a chat session id → thread id via the
  // DB (assistant sessions have no interactive pause, so they can't be gated).
  app.post('/api/supervise', async (request, reply) => {
    const body = (request.body ?? {}) as { session_id?: string; supervised?: boolean };
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'session_id required' };
    }
    const resolved = resolveSession(db, sessionId);
    if (!resolved || resolved.kind !== 'chat') {
      reply.code(404);
      return { error: 'unknown chat session' };
    }
    const on = body.supervised !== false;
    pi.setSupervised(resolved.threadId, on);
    return { ok: true, session_id: sessionId, supervised: on };
  });

  app.get('/api/sessions', async (request) => {
    const scope = scopeFromQuery(request.query as Record<string, unknown>);
    return { sessions: await buildSessions(gatewayDeps, scope) };
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await buildDetail(gatewayDeps, decodeURIComponent(id));
    if (!detail) {
      reply.code(404);
      return { error: 'unknown session' };
    }
    return detail;
  });

  app.get('/api/approvals', async () => ({ approvals: currentApprovals() }));

  // Client bootstrap config: the glasses read STT here so the key lives in
  // Nexus config (~/.nexus/config.yaml), not the client bundle or a URL param.
  app.get('/api/cockpit-config', async () => ({
    stt: config.stt ?? { provider: 'deepgram', apiKey: '', language: 'en' },
  }));

  app.post('/api/arm', async (request) => {
    const body = (request.body ?? {}) as { armed?: boolean; ttlSec?: number };
    setArmed(body.armed !== false, undefined, body.ttlSec);
    return { ok: true, armed };
  });

  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const { id: toolCallId } = request.params as { id: string };
    const body = (request.body ?? {}) as { action?: string; answers?: Record<string, string>; reason?: string };

    // A supervised tool-gate? Route allow/deny straight to the ApprovalBroker.
    // (Its ids are tool call ids, disjoint from the question tool's, so this
    // only matches real tool-gates.) `answer` is treated as `allow` defensively.
    const gate = pi.approvals.listPending().find((v) => v.toolCallId === toolCallId);
    if (gate) {
      const action = body.action === 'deny' ? 'deny' : 'allow';
      const result = pi.approvals.decide(gate.threadId, toolCallId, action, body.reason);
      if (!result.ok) {
        reply.code(result.status);
        return { error: result.error };
      }
      // decide() drives ApprovalBroker.remove → resolved is pushed to SSE clients.
      return { ok: true };
    }

    const pending = pi.questions.listPending().find((v) => v.toolCallId === toolCallId);
    if (!pending) {
      reply.code(404);
      return { error: 'unknown approval' };
    }
    const { threadId, request: questionRequest } = pending;

    if (body.action === 'deny') {
      // The cancel drives QuestionBroker.remove → a resolved event is pushed to
      // SSE clients automatically (see the broker subscription above).
      pi.questions.cancel(threadId, toolCallId, body.reason?.trim() || 'Dismissed from glasses');
      return { ok: true };
    }

    // 'answer' (and, defensively, 'allow' which the glasses never send for a
    // question) → submit the user's selection back to the QuestionBroker.
    if (!body.answers || typeof body.answers !== 'object') {
      reply.code(400);
      return { error: 'answers object required' };
    }
    const submission = translateGlassesAnswer(questionRequest, body.answers);
    const result = pi.questions.answer(threadId, toolCallId, submission);
    if (!result.ok) {
      reply.code(result.status);
      return { error: result.error };
    }
    // answer drives QuestionBroker.remove → resolved is pushed to SSE clients.
    return { ok: true };
  });

  app.post('/api/steer/focus', async (request) => {
    const body = (request.body ?? {}) as { session_id?: string | null };
    steerFocus = body.session_id ?? null;
    return { ok: true, steerFocus };
  });

  app.post('/api/steer/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { message?: string };
    const message = (body.message ?? '').trim();
    if (!message) {
      reply.code(400);
      return { error: 'message required' };
    }
    const resolved = resolveSession(db, decodeURIComponent(id));
    if (!resolved) {
      reply.code(404);
      return { error: 'unknown session' };
    }
    const outcome = await driveSteer(mainPort, db, resolved, message);
    if (!outcome.ok) {
      return { ok: false, armed: true, ...(outcome.busy ? { busy: true } : {}), ...(outcome.error ? { error: outcome.error } : {}) };
    }
    broadcast({ type: 'notify', notification: { session_id: id, cwd: resolved.cwd, message, notification_type: 'steer_delivered', needsAttention: false, at: Date.now() } });
    return { ok: true, armed: true };
  });

  // ── Backward-compat no-ops ──────────────────────────────────────────────────
  // The gateway occupies the port the old session-cockpit hub used, so any
  // lingering Claude Code hooks (Stop/PreToolUse/Notification) pointed here
  // would otherwise scrape Fastify's 404 `.message` and inject it as steer /
  // approval text. Nexus is the runtime now — these hooks have nothing to
  // deliver — so answer them the way an idle/disarmed hub would: no steer, no
  // approval capture, so the hook injects nothing and the agent stops normally.
  app.get('/api/steer/:id/wait', async () => ({ message: null, status: 'idle' }));
  app.get('/api/approvals/:id/wait', async () => ({ decision: null, status: 'idle' }));
  app.post('/api/approvals', async () => ({ armed: false }));
  app.post('/api/notify', async () => ({ ok: true }));

  // ── SSE ──────────────────────────────────────────────────────────────────
  app.get('/api/events', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    reply.raw.write('retry: 3000\n\n');
    reply.raw.write(`data: ${JSON.stringify({ type: 'hello', armed, steerFocus, pending: currentApprovals() } satisfies SseEvent)}\n\n`);
    sseClients.add(reply.raw);
    request.raw.on('close', () => {
      sseClients.delete(reply.raw);
    });
    reply.hijack();
  });

  // ── Serve the glasses SPA (optional) so UI + API share one Nexus origin ─────
  if (config.glassesDist && existsSync(config.glassesDist)) {
    // Default wildcard serves files dynamically from disk, so a `vite build`
    // (new hashed asset names) is picked up without restarting the backend.
    app.register(fastifyStatic, { root: config.glassesDist, prefix: '/' });
    // SPA fallback: any non-API GET that isn't a real file returns index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({ error: 'not found' });
    });
    console.log(`NEXUS glasses gateway serving UI from ${config.glassesDist}`);
  }

  const close = async (): Promise<void> => {
    unsubscribeQuestions();
    unsubscribeApprovals();
    clearInterval(heartbeatTimer);
    if (disarmTimer) clearTimeout(disarmTimer);
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    await app.close();
  };

  return { app, close };
}

interface SteerOutcome {
  ok: boolean;
  busy?: boolean;
  error?: string;
}

/** Drive a turn by loopback POST to the main app's existing stream endpoint.
 *  The run continues even after we stop reading, so we only await acceptance
 *  (headers) then drain the NDJSON in the background to avoid backpressure. */
async function driveSteer(
  mainPort: number,
  db: Db,
  resolved: { kind: 'chat'; threadId: string } | { kind: 'assistant'; sessionId: string },
  message: string,
): Promise<SteerOutcome> {
  let url: string;
  const payload: Record<string, unknown> = { content: message };
  if (resolved.kind === 'chat') {
    url = `http://127.0.0.1:${mainPort}/api/threads/${encodeURIComponent(resolved.threadId)}/messages/stream`;
    const row = db.prepare('SELECT last_model_key FROM chat_threads WHERE id = ?').get(resolved.threadId) as
      | { last_model_key: string | null }
      | undefined;
    if (row?.last_model_key) payload.modelKey = row.last_model_key;
  } else {
    url = `http://127.0.0.1:${mainPort}/api/assistant/sessions/${encodeURIComponent(resolved.sessionId)}/messages/stream`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 409) {
    void drainBody(res);
    return { ok: false, busy: true };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: text || `status ${res.status}` };
  }
  void drainBody(res);
  return { ok: true };
}

async function drainBody(res: Response): Promise<void> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    /* run continues server-side regardless */
  }
}

/** Boot the gateway listener on the LAN. No-op (returns null) when disabled. */
export async function startGateway(deps: GatewayDependencies): Promise<GatewayHandle | null> {
  if (!deps.config.enabled) return null;
  const handle = createGatewayApp(deps);
  await handle.app.listen({ port: deps.config.port, host: '0.0.0.0' });
  const auth = deps.config.token ? 'token-guarded' : 'DEV (no token)';
  console.log(`NEXUS glasses gateway on http://0.0.0.0:${deps.config.port} (${auth})`);
  return handle;
}
