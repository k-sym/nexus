import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBridgeConfig } from '@nexus/shared';
import { getDb } from '../db.js';
import { AgentBridgeService } from '../agent-bridge/service.js';
import { bridgeSubject, validateAgentBridgeConfig, type AgentBridgeEnvelopeV1 } from '../agent-bridge/protocol.js';
import { registerAgentBridgeRoutes } from '../routes/agent-bridge.js';

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
    ...overrides,
  };
}

function fixture() {
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
