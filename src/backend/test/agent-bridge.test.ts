import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBridgeConfig } from '@nexus/shared';
import { getDb } from '../db.js';
import { AgentBridgeService, type ReplyPublisher } from '../agent-bridge/service.js';
import { bridgeSubject, validateAgentBridgeConfig, type AgentBridgeEnvelopeV1 } from '../agent-bridge/protocol.js';
import { registerAgentBridgeRoutes } from '../routes/agent-bridge.js';
import { defaultConfigForTests } from '../config.js';
import { registerTrustRoutes } from '../routes/trust.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function config(overrides: Partial<AgentBridgeConfig> = {}): AgentBridgeConfig {
  return {
    enabled: true,
    mode: 'queue_for_approval',
    url: 'nats://127.0.0.1:4222',
    instance_id: 'nexus-test',
    allowed_senders: ['claude-reviewer'],
    token: '',
    max_message_bytes: 1024,
    max_messages_per_minute: 2,
    max_hops: 2,
    retention_days: 30,
    reply_max_attempts: 60,
    reply_backoff_seconds: 5,
    reply_backoff_max_seconds: 300,
    ...overrides,
  };
}

function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-agent-bridge-'));
  roots.push(root);
  const db = getDb(join(root, 'nexus.db'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('project-a', 'project-a', 'Project A', root, now, now);
  for (const id of ['thread-a', 'thread-b']) {
    db.prepare('INSERT INTO chat_threads (id, project_id, agent_id, title, created_at, updated_at, last_model_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'project-a', 'pi', id, now, now, 'openrouter/test-model');
  }
  if (enabled) db.prepare('INSERT INTO agent_bridge_project_policy (project_id, enabled) VALUES (?, 1)').run('project-a');
  return { root, db };
}

function envelope(id: string, overrides: Partial<AgentBridgeEnvelopeV1> = {}): AgentBridgeEnvelopeV1 {
  return {
    version: 1,
    kind: 'message',
    id,
    sentAt: new Date().toISOString(),
    sender: { id: 'claude-reviewer', displayName: 'Claude reviewer', harness: 'claude-code' },
    target: { instanceId: 'nexus-test', projectId: 'project-a', threadId: 'thread-a' },
    content: 'Please review the auth path.',
    hopCount: 0,
    ...overrides,
  };
}

test('persists and routes a thread-directed message without touching another thread', () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  const result = service.ingest(envelope('message-1'));

  assert.equal(result.accepted, true);
  assert.equal(result.message.status, 'pending_approval');
  assert.equal(result.message.thread_id, 'thread-a');
  assert.equal(service.store.list().some((message) => message.thread_id === 'thread-b'), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
  db.close();
});

test('deduplicates redelivery durably across service restarts', () => {
  const { db } = fixture();
  const first = new AgentBridgeService(db, config()).ingest(envelope('message-duplicate'));
  const secondService = new AgentBridgeService(db, config());
  const second = secondService.ingest(envelope('message-duplicate'));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_bridge_messages').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications').get().count, 1);
  db.close();
});

test('puts an interrupted accepted turn back into the approval queue after restart', () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  service.ingest(envelope('message-interrupted'));
  service.store.transition('message-interrupted', 'pending_approval', 'running');

  const restarted = new AgentBridgeService(db, config());
  const recovered = restarted.store.get('message-interrupted');
  assert.equal(recovered?.status, 'pending_approval');
  assert.match(recovered?.rejection_reason ?? '', /approve to retry/);
  db.close();
});

test('persists unauthorized, misrouted, excessive-hop, and rate-limited deliveries as rejected', () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config({ max_messages_per_minute: 10 }));
  const unauthorized = service.ingest(envelope('message-unauthorized', { sender: { id: 'intruder' } }));
  const misrouted = service.ingest(envelope('message-misrouted', {
    target: { instanceId: 'nexus-test', projectId: 'project-a', threadId: 'missing-thread' },
  }));
  const hopped = service.ingest(envelope('message-hopped', { hopCount: 3 }));
  const rateService = new AgentBridgeService(db, config({ max_messages_per_minute: 1 }));
  const now = Date.now();
  const first = rateService.ingest(envelope('message-rate-1'), now);
  const limited = rateService.ingest(envelope('message-rate-2'), now + 1);

  assert.match(unauthorized.message.rejection_reason!, /not allowed/);
  assert.match(misrouted.message.rejection_reason!, /not found/);
  assert.match(hopped.message.rejection_reason!, /hop limit/);
  assert.equal(first.accepted, true);
  assert.match(limited.message.rejection_reason!, /rate limit/);
  assert.equal(service.store.list().filter((message) => message.status === 'rejected').length, 4);
  db.close();
});

test('notify-only mode persists a message without making it executable', () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config({ mode: 'notify_only' }));
  assert.equal(service.ingest(envelope('message-notify')).message.status, 'received');
  db.close();
});

test('approval route starts the existing managed-turn path and records completion', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  service.ingest(envelope('message-run'));
  let run: { id: string; model: string } | undefined;
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('agentBridge', service);
  await app.register(registerAgentBridgeRoutes, {
    service,
    runManagedTurn: async (message, modelKey) => {
      run = { id: message.id, model: modelKey };
      return { completed: true };
    },
  });

  const response = await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/message-run/approve' });
  assert.equal(response.statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(run, { id: 'message-run', model: 'openrouter/test-model' });
  assert.equal(service.store.get('message-run')?.status, 'completed');
  await app.close();
  db.close();
});

test('a failed or aborted managed turn remains visible as failed bridge work', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  service.ingest(envelope('message-failed-run'));
  const app = Fastify();
  app.decorate('db', db);
  app.decorate('agentBridge', service);
  await app.register(registerAgentBridgeRoutes, {
    service,
    runManagedTurn: async () => ({ completed: false, error: 'Managed turn cancelled' }),
  });

  const response = await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/message-failed-run/approve' });
  assert.equal(response.statusCode, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.store.get('message-failed-run')?.status, 'failed');
  assert.equal(service.store.get('message-failed-run')?.rejection_reason, 'Managed turn cancelled');
  await app.close();
  db.close();
});

test('rejects unsafe remote configuration and exposes a stable instance subject', () => {
  assert.match(validateAgentBridgeConfig(config({ url: 'nats://broker.example.com:4222', token: 'secret' }))!, /tls/);
  assert.match(validateAgentBridgeConfig(config({ url: 'tls://broker.example.com:4222', token: '' }))!, /token/);
  assert.equal(validateAgentBridgeConfig(config({ url: 'tls://broker.example.com:4222', token: 'secret' })), null);
  assert.equal(bridgeSubject('nexus-test'), 'nexus.bridge.v1.inbox.nexus-test');
});


test('outbound replies need separate approval, retain their id after restart, and reject arbitrary destinations', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  assert.throws(() => service.ingest(envelope('redirect', { replyTo: 'unrelated-subject' })), /replyTo/);
  service.ingest(envelope('reply'));
  const running = service.store.transition('reply', 'pending_approval', 'running')!;
  service.store.complete(running, { completed: true, content: 'Verified result' }, 'nexus-test');
  const draft = service.store.reply('reply')!;
  assert.equal(draft.status, 'pending_approval');
  assert.equal(service.store.queuedReplies().length, 0);
  service.store.complete(running, { completed: false }, 'nexus-test');
  assert.equal(service.store.reply('reply')!.id, draft.id);
  service.store.approveReply('reply');
  const restarted = new AgentBridgeService(db, config());
  assert.equal(restarted.store.queuedReplies()[0].id, draft.id);
  assert.equal(restarted.store.get('reply')?.status, 'completed');
  db.close();
});

test('disabled bridge refuses running stored work and sending a stored reply', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config({ enabled: false }));
  service.store.ingest(envelope('stored'), config());
  const app = Fastify();
  app.decorate('db', db);
  let invoked = false;
  await app.register(registerAgentBridgeRoutes, { service, runManagedTurn: async () => { invoked = true; return { completed: true }; } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/stored/approve' })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/stored/reply/send' })).statusCode, 503);
  assert.equal(invoked, false);
  await app.close(); db.close();
});

test('scope defaults off, narrows threads, validates ownership and preserves global guard precedence', () => {
  const { db } = fixture(false);
  const service = new AgentBridgeService(db, config({ max_messages_per_minute: 100 }));
  assert.equal(service.store.projects()[0].enabled, false);
  assert.equal(service.ingest(envelope('off')).message.rejection_reason, 'project_not_enabled');
  assert.match(service.ingest(envelope('intruder', { sender: { id: 'intruder' } })).message.rejection_reason!, /not allowed/);
  service.store.setPolicy('project-a', { enabled: true, thread_ids: [] });
  assert.equal(service.ingest(envelope('none')).message.rejection_reason, 'thread_not_enabled');
  service.store.setPolicy('project-a', { enabled: true, thread_ids: ['thread-b'] });
  assert.equal(service.ingest(envelope('excluded')).message.rejection_reason, 'thread_not_enabled');
  assert.equal(service.ingest(envelope('allowed', { target: { ...envelope('x').target, threadId: 'thread-b' } })).accepted, true);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('other', 'other', 'Other', '/tmp/other', now, now);
  service.store.setPolicy('other', { enabled: true, thread_ids: null });
  assert.match(service.ingest(envelope('wrong-project', { target: { ...envelope('x').target, projectId: 'other' } })).message.rejection_reason!, /does not belong/);
  assert.equal(service.store.get('off')?.status, 'rejected');
  db.close();
});

test('scope routes save while disabled, validate input and recheck queued work before approval', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  service.ingest(envelope('queued'));
  const app = Fastify(); app.decorate('db', db);
  let runs = 0;
  await app.register(registerAgentBridgeRoutes, { service, runManagedTurn: async () => { runs++; return { completed: true }; } });
  const put = (payload: unknown, id = 'project-a') => app.inject({ method: 'PUT', url: `/api/agent-bridge/projects/${id}`, payload });
  assert.equal((await put({ enabled: true, thread_ids: ['missing'] })).statusCode, 400);
  for (const payload of [{ enabled: 'yes', thread_ids: null }, { enabled: true }, { enabled: true, thread_ids: [3] }]) {
    assert.equal((await put(payload)).statusCode, 400);
  }
  assert.equal((await put({ enabled: true, thread_ids: null }, 'missing')).statusCode, 404);
  assert.equal((await put({ enabled: false, thread_ids: null })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/queued/approve' })).statusCode, 409);
  assert.equal(runs, 0);
  assert.equal(service.store.get('queued')?.status, 'pending_approval');
  service.ingest(envelope('rejected'));
  service.config.enabled = false;
  assert.equal((await put({ enabled: true, thread_ids: ['thread-a', 'thread-a'] })).statusCode, 200);
  const scopes = (await app.inject('/api/agent-bridge/projects')).json().projects;
  assert.deepEqual(scopes[0].thread_ids, ['thread-a']);
  assert.equal(scopes[0].threads.length, 2);
  service.config.enabled = true;
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/rejected/approve' })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/agent-bridge/messages/queued/approve' })).statusCode, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  await app.close(); db.close();
});

function completedReply(service: AgentBridgeService, id: string) {
  service.store.ingest(envelope(id), service.config);
  const running = service.store.transition(id, 'pending_approval', 'running')!;
  service.store.complete(running, { completed: true, content: 'Verified' }, 'nexus-test');
  return service.store.reply(id)!;
}

test('retention protects unresolved work and unsent replies; sent/discarded replies get a fresh window', () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  for (const state of ['received', 'completed', 'rejected', 'failed', 'pending_approval', 'running'] as const) {
    service.store.ingest(envelope(state), config());
    service.store.transition(state, 'pending_approval', state);
  }
  for (const status of ['pending_approval', 'queued', 'dead_letter', 'sent', 'discarded'] as const) {
    completedReply(service, `reply-${status}`);
    db.prepare('UPDATE agent_bridge_replies SET status = ? WHERE message_id = ?').run(status, `reply-${status}`);
  }
  db.prepare("UPDATE agent_bridge_messages SET updated_at = '2026-01-01T00:00:00.000Z'").run();
  db.prepare("UPDATE agent_bridge_replies SET sent_at = '2026-03-31T00:00:00.000Z' WHERE status = 'sent'").run();
  db.prepare("UPDATE agent_bridge_replies SET discarded_at = '2026-03-31T00:00:00.000Z' WHERE status = 'discarded'").run();
  const now = Date.parse('2026-04-01T00:00:00.000Z');
  assert.equal(service.store.prune(30, now), 4);
  for (const id of ['pending_approval', 'running', 'reply-pending_approval', 'reply-queued', 'reply-dead_letter', 'reply-sent', 'reply-discarded']) assert.ok(service.store.get(id), id);
  assert.equal(service.store.prune(30, now + 31 * 86_400_000), 2);
  assert.equal(service.store.reply('reply-sent'), undefined);
  assert.equal(service.store.reply('reply-discarded'), undefined);
  assert.equal(service.store.prune(0, now), 0);
  db.close();
});

/** Pretend the service holds a live broker connection so flushReplies reaches the publisher. */
function pretendConnected(service: AgentBridgeService): AgentBridgeService {
  (service as unknown as { nc: object; state: string }).nc = {};
  (service as unknown as { nc: object; state: string }).state = 'connected';
  return service;
}

test('broker outage defers approved replies without spending the retry budget', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config({ reply_max_attempts: 2 }));
  completedReply(service, 'first');
  service.store.approveReply('first');
  for (let cycle = 0; cycle < 5; cycle++) await service.flushReplies();
  const reply = service.store.reply('first')!;
  assert.equal(reply.status, 'queued');
  assert.equal(reply.attempts, 0);
  assert.equal(reply.next_attempt_at, null);
  assert.match(reply.error!, /broker is unavailable/);
  db.close();
});

test('publish failures back off with a cap, dead-letter at the limit, persist restart, and guard retry/discard actions', async () => {
  const { db } = fixture();
  let publishes = 0;
  const failing: ReplyPublisher = async () => { publishes++; throw new Error('no responders'); };
  const limits = { reply_max_attempts: 3, reply_backoff_seconds: 5, reply_backoff_max_seconds: 8 };
  const service = pretendConnected(new AgentBridgeService(db, config(limits), failing));
  const first = completedReply(service, 'first');
  completedReply(service, 'second');
  service.store.approveReply('first'); service.store.approveReply('second');
  const t0 = Date.parse('2026-09-15T00:00:00.000Z');
  await service.flushReplies(t0);
  assert.equal(publishes, 2);
  for (const id of ['first', 'second']) {
    const reply = service.store.reply(id)!;
    assert.equal(reply.status, 'queued');
    assert.equal(reply.attempts, 1);
    assert.equal(reply.error, 'no responders');
    assert.equal(reply.next_attempt_at, new Date(t0 + 5_000).toISOString(), 'first retry waits the initial backoff');
  }
  await service.flushReplies(t0 + 4_999);
  assert.equal(publishes, 2, 'nothing is retried inside the backoff window');
  await service.flushReplies(t0 + 5_000);
  assert.equal(publishes, 4);
  assert.equal(service.store.reply('first')?.attempts, 2);
  assert.equal(service.store.reply('first')?.next_attempt_at, new Date(t0 + 5_000 + 8_000).toISOString(), 'doubling is capped at the maximum backoff');
  const restarted = pretendConnected(new AgentBridgeService(db, config(limits), failing));
  await restarted.flushReplies(t0 + 12_999);
  assert.equal(publishes, 4, 'backoff survives a restart');
  await restarted.flushReplies(t0 + 13_000);
  assert.equal(publishes, 6);
  for (const id of ['first', 'second']) {
    assert.equal(restarted.store.reply(id)?.status, 'dead_letter');
    assert.equal(restarted.store.reply(id)?.attempts, 3);
    assert.equal(restarted.store.reply(id)?.next_attempt_at, null);
  }
  await restarted.flushReplies(t0 + 3_600_000);
  assert.equal(publishes, 6, 'dead letters are never retried automatically');
  const app = Fastify(); app.decorate('db', db);
  await app.register(registerAgentBridgeRoutes, { service: restarted });
  const post = (id: string, action: string) => app.inject({ method: 'POST', url: `/api/agent-bridge/messages/${id}/reply/${action}` });
  assert.equal((await post('first', 'send')).statusCode, 409);
  assert.equal((await post('missing', 'retry')).statusCode, 404);
  const retried = await post('first', 'retry');
  assert.equal(retried.statusCode, 202);
  assert.equal(retried.json().attempts, 0);
  assert.equal(retried.json().next_attempt_at, null, 'manual retry is not held back by the old backoff');
  assert.equal(restarted.store.reply('first')?.id, first.id);
  assert.equal(restarted.store.reply('first')?.payload, first.payload);
  assert.equal((await post('first', 'discard')).statusCode, 409);
  restarted.config.enabled = false;
  assert.equal((await post('second', 'retry')).statusCode, 503);
  const discarded = await post('second', 'discard');
  assert.equal(discarded.statusCode, 200);
  assert.equal(discarded.json().discarded_by, 'user');
  assert.ok(discarded.json().discarded_at);
  restarted.config.enabled = true;
  for (const action of ['retry', 'discard', 'send']) assert.equal((await post('second', action)).statusCode, 409);
  await restarted.flushReplies();
  assert.equal(restarted.store.reply('second')?.status, 'discarded');
  assert.ok(restarted.store.get('second'));
  await app.close(); db.close();
});

test('additive upgrade retains existing inbox/reply data and defaults project scope off', () => {
  const { root, db } = fixture(false);
  const service = new AgentBridgeService(db, config());
  service.store.setPolicy('project-a', { enabled: true, thread_ids: null });
  const reply = completedReply(service, 'legacy');
  service.store.approveReply('legacy');
  // Restore the pre-452 schema in this disposable fixture before reopening it.
  db.exec('DROP TABLE agent_bridge_project_policy');
  for (const column of ['attempts', 'discarded_at', 'discarded_by', 'next_attempt_at']) db.exec(`ALTER TABLE agent_bridge_replies DROP COLUMN ${column}`);
  const inbox = service.store.get('legacy');
  db.close();
  for (let pass = 0; pass < 2; pass++) {
    const upgraded = getDb(join(root, 'nexus.db'));
    const next = new AgentBridgeService(upgraded, config());
    assert.deepEqual(next.store.get('legacy'), inbox);
    assert.equal(next.store.reply('legacy')?.id, reply.id);
    assert.equal(next.store.reply('legacy')?.payload, reply.payload);
    assert.equal(next.store.reply('legacy')?.status, 'queued');
    assert.equal(next.store.reply('legacy')?.attempts, 0);
    assert.equal(next.store.reply('legacy')?.next_attempt_at, null);
    assert.equal(next.store.reply('legacy')?.discarded_at, null);
    assert.equal(next.store.projects()[0].enabled, false);
    upgraded.close();
  }
});

test('retention runs at startup and hourly, and shutdown clears its timer', async (t) => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config({ enabled: false }));
  const calls: number[] = [];
  service.store.prune = days => { calls.push(days); return 0; };
  t.mock.timers.enable({ apis: ['setInterval'] });
  service.start();
  assert.deepEqual(calls, [30]);
  t.mock.timers.tick(3_600_000);
  assert.deepEqual(calls, [30, 30]);
  await service.stop();
  t.mock.timers.tick(3_600_000);
  assert.deepEqual(calls, [30, 30]);
  db.close();
});

test('retention and retry budget reject invalid configuration values', () => {
  for (const value of [0, -1, 1.5, NaN, 3651]) assert.match(validateAgentBridgeConfig(config({ retention_days: value }))!, /retention/);
  for (const value of [0, -1, 1.5, NaN, 10001]) assert.match(validateAgentBridgeConfig(config({ reply_max_attempts: value }))!, /attempts/);
  for (const value of [0, -1, 1.5, NaN, 3601]) assert.match(validateAgentBridgeConfig(config({ reply_backoff_seconds: value }))!, /backoff/);
  for (const value of [0, 4, 1.5, NaN, 86_401]) assert.match(validateAgentBridgeConfig(config({ reply_backoff_max_seconds: value }))!, /maximum reply backoff/);
  assert.equal(validateAgentBridgeConfig(config({ reply_backoff_seconds: 5, reply_backoff_max_seconds: 5 })), null);
});


test('Trust route reports actual enabled project scope and configured retention limits', async () => {
  const { db } = fixture();
  const service = new AgentBridgeService(db, config());
  service.store.setPolicy('project-a', { enabled: true, thread_ids: ['thread-b'] });
  const app = Fastify(); app.decorate('db', db);
  app.decorate('pi', { auth: { listCredentials: async () => [] }, paths: {} });
  const settings = defaultConfigForTests();
  settings.agent_bridge = config({ retention_days: 45, reply_max_attempts: 12 });
  await app.register(registerTrustRoutes, { config: () => settings, snapshot: { githubStatus: async () => ({ configured: false, source: 'absent' }) } });
  const response = await app.inject('/api/trust');
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().agentBridge.retention_days, 45);
  assert.equal(response.json().agentBridge.reply_max_attempts, 12);
  assert.equal(response.json().agentBridge.enabled, true);
  assert.equal(response.json().agentBridge.projects[0].name, 'Project A');
  assert.deepEqual(response.json().agentBridge.projects[0].thread_ids, ['thread-b']);
  service.store.setPolicy('project-a', { enabled: false, thread_ids: null });
  assert.deepEqual((await app.inject('/api/trust')).json().agentBridge.projects, []);
  await app.close(); db.close();
});

test('targets route exposes only enabled project threads with names/timestamps and runtime limits', async () => {
  const { db } = fixture(); const service = new AgentBridgeService(db, config());
  const app = Fastify(); app.decorate('db', db); await app.register(registerAgentBridgeRoutes, { service });
  service.store.setPolicy('project-a', { enabled: true, thread_ids: ['thread-b'] });
  let data = (await app.inject('/api/agent-bridge/targets')).json();
  assert.equal(data.instanceId, 'nexus-test'); assert.equal(data.mode, 'queue_for_approval'); assert.equal(data.maxMessageBytes, 1024);
  assert.equal(data.projects.length, 1); assert.equal(data.projects[0].name, 'Project A');
  assert.deepEqual(data.projects[0].threads.map((thread: any) => thread.id), ['thread-b']);
  assert.equal(data.projects[0].threads[0].name, 'thread-b'); assert.ok(data.projects[0].threads[0].updatedAt);
  assert.deepEqual(Object.keys(data.projects[0].threads[0]).sort(), ['id', 'name', 'updatedAt']);
  service.store.setPolicy('project-a', { enabled: true, thread_ids: [] });
  assert.deepEqual((await app.inject('/api/agent-bridge/targets')).json().projects, []);
  service.store.setPolicy('project-a', { enabled: false, thread_ids: null });
  assert.deepEqual((await app.inject('/api/agent-bridge/targets')).json().projects, []);
  service.store.setPolicy('project-a', { enabled: true, thread_ids: null }); service.config.enabled = false;
  data = (await app.inject('/api/agent-bridge/targets')).json(); assert.equal(data.enabled, false); assert.deepEqual(data.projects, []);
  await app.close(); db.close();
});
