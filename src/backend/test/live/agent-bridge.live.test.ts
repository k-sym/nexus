import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import { connect } from '@nats-io/transport-node';
import { jetstream, jetstreamManager } from '@nats-io/jetstream';
import { getDb } from '../../db.js';
import { AgentBridgeService } from '../../agent-bridge/service.js';
import { bridgeSubject, bridgeResultSubject, AGENT_BRIDGE_RESULTS_STREAM } from '../../agent-bridge/protocol.js';
import { registerAgentBridgeRoutes, createManagedTurnRunner } from '../../routes/agent-bridge.js';
import { registerChatRoutes } from '../../routes/chat.js';
import { capabilitiesFromModel } from '../../pi/model-capabilities.js';
import { ConcurrencyTracker } from '../../pi/concurrency.js';
import { QuestionBroker } from '../../pi/questions.js';
import { ApprovalBroker, decideToolCall } from '../../pi/approvals.js';
import { createToolPolicyResolver } from '../../pi/tool-policy.js';

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('real broker → approval → managed chat → supervised work / expiry → durable confirmed reply', { timeout: 60_000 }, async (t) => {
  const binary = process.env.NATS_SERVER_BINARY || 'nats-server';
  const root = mkdtempSync(join(tmpdir(), 'nexus-bridge-live-'));
  const port = await freePort();
  const broker = spawn(binary, ['-js', '-a', '127.0.0.1', '-p', String(port), '-sd', join(root, 'jetstream')], { stdio: 'ignore' });
  let launchError: Error | undefined;
  broker.on('error', error => { launchError = error; });
  let nc: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await until(async () => {
      if (launchError) return true;
      try { nc = await connect({ servers: `nats://127.0.0.1:${port}`, timeout: 100, reconnect: false }); return true; }
      catch { return false; }
    }, 'broker startup');
    if (launchError) {
      if (process.env.NEXUS_REQUIRE_LIVE === '1') throw launchError;
      t.skip('Install nats-server or set NATS_SERVER_BINARY'); return;
    }
    const db = getDb(join(root, 'nexus.db'));
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('project', 'project', 'Project', root, now, now);
    for (const id of ['a', 'b']) db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, last_model_key) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'project', id, now, now, 'test/model');
    const config = { enabled: true, mode: 'queue_for_approval' as const, url: `nats://127.0.0.1:${port}`, instance_id: 'live',
      allowed_senders: ['reviewer'], token: '', max_message_bytes: 4096, max_messages_per_minute: 30, max_hops: 4 };
    let service = new AgentBridgeService(db, config);
    const questions = new QuestionBroker();
    const approvals = new ApprovalBroker();
    const concurrency = new ConcurrencyTracker();
    const executed: string[] = [];
    const supervised = new Set<string>(['a']);
    const runtime = {
      questions, approvals, models: { find: () => ({ provider: 'test', id: 'model', contextWindow: 32000, maxTokens: 1024 }) },
      readMessages: async () => [], getSessionModel: () => undefined, setSessionModel: () => {}, dropSession: () => {},
      isSupervised: (id: string) => supervised.has(id), setSupervised: (id: string, enabled: boolean) => enabled ? supervised.add(id) : supervised.delete(id),
      sessionFor: async (id: string) => {
        const controller = new AbortController();
        const listeners = new Set<(event: any) => void>();
        return { setModel: async () => {}, subscribe: (fn: (event: any) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
          abort: async () => { controller.abort(); },
          prompt: async (content: string) => {
            if (content.includes('ask-question')) {
              await questions.register(id, 'question', { questions: [{ id: 'q', header: 'Scope', question: 'Proceed?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }], multiple: false, allowOther: false }] }, controller.signal);
              assert.equal(controller.signal.aborted, true, 'expiry aborts before the model can continue');
              return;
            }
            if (content.includes('fail-run')) throw new Error('Test model failure');
            const decision = await decideToolCall({ threadId: id, toolCallId: 'write', toolName: 'write', input: { path: 'result.txt' }, cwd: root,
              broker: approvals, signal: controller.signal, policy: createToolPolicyResolver({ isSupervised: () => supervised.has(id) }) });
            if (decision.block || controller.signal.aborted) return;
            executed.push(id);
            for (const listener of listeners) listener({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Review complete: all checks passed.' }] } });
          } };
      },
    };
    const app = Fastify();
    const events: any[] = [];
    app.decorate('db', db); app.decorate('pi', runtime); app.decorate('chatConcurrency', concurrency);
    app.decorate('activity', { bus: { emit: (event: any) => events.push(event) } });
    await app.register(registerChatRoutes, { questionTimeoutMs: 200, detectGitBranch: async () => '', capabilityResolver: { peek: capabilitiesFromModel, resolve: async (model: any) => capabilitiesFromModel(model) } });
    let httpPort = 0;
    await app.register(registerAgentBridgeRoutes, { service, runManagedTurn: (message, model) => createManagedTurnRunner({ port: httpPort, token: '' })(message, model) });
    await app.listen({ port: 0, host: '127.0.0.1' }); httpPort = (app.server.address() as { port: number }).port;
    const post = (path: string, payload?: unknown) => app.inject({ method: 'POST', url: path, payload });
    const js = jetstream(nc!); const jsm = await jetstreamManager(nc!);
    const envelope = (id: string, content = 'review') => ({ version: 1, kind: 'message', id, sentAt: new Date().toISOString(), sender: { id: 'reviewer' }, target: { instanceId: 'live', projectId: 'project', threadId: 'a' }, content, replyTo: 'reviewer' });
    const deliver = async (id: string, content?: string) => {
      await js.publish(bridgeSubject('live'), new TextEncoder().encode(JSON.stringify(envelope(id, content))));
      await until(() => !!service.store.get(id), `ingest ${id}`);
    };
    try {
      service.start(); await until(() => service.status().state === 'connected', 'service connected');
      await deliver('one'); await deliver('one');
      assert.equal(executed.length, 0);
      assert.equal(service.store.list().length, 1);
      assert.equal((await post('/api/agent-bridge/messages/one/approve')).statusCode, 202);
      await until(() => { if (service.store.get('one')?.status === 'failed') throw new Error(service.store.get('one')?.rejection_reason || 'run failed'); return approvals.listPending().length === 1; }, 'supervised tool gate');
      assert.equal(executed.length, 0, 'inbound approval does not bypass supervision');
      const blocked = await post('/api/threads/b/messages/stream', { content: 'other', modelKey: 'test/model' });
      assert.equal(blocked.statusCode, 409, 'real project claim blocks other threads');
      approvals.decide('a', 'write', 'allow');
      await until(() => service.store.get('one')?.status === 'completed', 'completion');
      assert.deepEqual(executed, ['a']);
      assert.ok(events.some(event => event.type === 'start'));
      assert.equal(concurrency.getProject('project'), undefined);
      const draft = service.store.reply('one')!;
      assert.match(draft.payload, /Review complete/);
      assert.equal(draft.status, 'pending_approval');
      assert.equal((await jsm.streams.info(AGENT_BRIDGE_RESULTS_STREAM)).state.messages, 0, 'no unapproved publication');
      assert.equal((await post('/api/agent-bridge/messages/one/reply/send')).statusCode, 202);
      await until(() => service.store.reply('one')?.status === 'sent', 'published reply');
      const stored = await jsm.streams.getMessage(AGENT_BRIDGE_RESULTS_STREAM, { seq: 1 });
      const result = JSON.parse(new TextDecoder().decode(stored.data));
      assert.equal(result.inReplyTo, 'one'); assert.equal(result.id, draft.id);
      assert.equal(stored.subject, bridgeResultSubject('reviewer'));
      await post('/api/agent-bridge/messages/one/reply/send');
      assert.equal((await jsm.streams.info(AGENT_BRIDGE_RESULTS_STREAM)).state.messages, 1);
      await deliver('expiry', 'ask-question');
      await post('/api/agent-bridge/messages/expiry/approve');
      await until(() => service.store.get('expiry')?.status === 'failed', 'question expiry');
      assert.equal(JSON.parse(service.store.reply('expiry')!.payload).status, 'interrupted');
      assert.equal(concurrency.getProject('project'), undefined);
      await deliver('cancel'); await post('/api/agent-bridge/messages/cancel/approve');
      await until(() => approvals.listPending().length === 1, 'cancel gate');
      await post('/api/threads/a/abort');
      await until(() => service.store.get('cancel')?.status === 'failed', 'cancelled run');
      assert.equal(JSON.parse(service.store.reply('cancel')!.payload).status, 'cancelled');
      assert.deepEqual(executed, ['a']);
      await deliver('failure', 'fail-run'); await post('/api/agent-bridge/messages/failure/approve');
      await until(() => service.store.get('failure')?.status === 'failed', 'failed run');
      // A rejected broker publish must stay queued for retry with its ID intact.
      await jsm.streams.delete(AGENT_BRIDGE_RESULTS_STREAM);
      await post('/api/agent-bridge/messages/failure/reply/send');
      await until(() => !!service.store.reply('failure')?.error, 'failed publication retained');
      assert.equal(service.store.reply('failure')?.status, 'queued');
      // Stop the receiver: the broker retains arrivals, and SQLite retains
      // previously approved outgoing replies and interrupted work.
      await service.stop();
      service.store.approveReply('failure');
      const retryId = service.store.reply('failure')!.id;
      await js.publish(bridgeSubject('live'), new TextEncoder().encode(JSON.stringify(envelope('offline'))));
      service.store.ingest(envelope('interrupted') as any, config);
      service.store.transition('interrupted', 'pending_approval', 'running');
      service = new AgentBridgeService(db, config);
      assert.equal(service.store.get('interrupted')?.status, 'pending_approval');
      service.start();
      await until(() => !!service.store.get('offline'), 'offline delivery after restart');
      await until(() => service.store.reply('failure')?.status === 'sent', 'approved reply after restart');
      assert.equal(service.store.reply('failure')!.id, retryId);
      assert.deepEqual(executed, ['a'], 'restart never reruns accepted work');
    } finally { await service.stop(); await app.close(); db.close(); }
  } finally {
    await nc?.close();
    if (broker.pid && broker.exitCode === null) { broker.kill('SIGTERM'); await new Promise(resolve => broker.once('exit', resolve)); }
    rmSync(root, { recursive: true, force: true });
  }
});
