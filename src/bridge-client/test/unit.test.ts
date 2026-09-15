import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, validateConfig, identity, safeError, type ClientConfig } from '../src/config.js';
import { envelope, parseResult, resultsSubject, inboxSubject } from '../src/protocol.js';
import { resolveTarget } from '../src/targets.js';
import { State } from '../src/state.js';
import { BridgeClient } from '../src/client.js';

export function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'nexus-client-unit-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const config: ClientConfig = { url: 'nats://127.0.0.1:4222', backend_url: 'http://127.0.0.1:4173', instance_id: 'test', sender_id: 'reviewer', token: '', backend_token: '', state_dir: root };
  return { root, config };
}
test('configuration uses env over YAML and never prints credentials', t => {
  const { root } = fixture(t); const path = join(root, 'client.yaml');
  writeFileSync(path, 'instance_id: file\nsender_id: file-sender\nurl: nats://localhost:4222\n');
  const config = loadConfig(path, { NEXUS_BRIDGE_INSTANCE: 'env', NEXUS_BRIDGE_SENDER: 'env-sender', NEXUS_AGENT_BRIDGE_TOKEN: 'broker-secret', NEXUS_BRIDGE_BACKEND_TOKEN: 'http-secret' });
  assert.equal(config.instance_id, 'env'); assert.equal(config.sender_id, 'env-sender');
  assert.equal(config.url, 'nats://localhost:4222');
  assert.equal(JSON.stringify(identity(config)).includes('secret'), false);
  assert.equal(safeError(new Error('broker-secret/http-secret'), config), '[redacted]/[redacted]');
  writeFileSync(path, 'instance_id: yaml\nsender_id: yaml-sender\nurl: tls://broker.example:4222\nbackend_url: https://nexus.example\ntoken: broker-secret\nbackend_token: http-secret\n');
  assert.equal(loadConfig(path, {}).token, 'broker-secret');
  assert.equal(loadConfig(path, {}).backend_token, 'http-secret');
  writeFileSync(path, 'instance_id: [\nsecret-token');
  assert.throws(() => loadConfig(path, {}), error => !String(error).includes('secret-token'));
  assert.throws(() => loadConfig(join(root, 'missing'), {}), /Could not read/);
});
test('unsafe URLs and missing identity fail before opening state or connections', t => {
  const { config } = fixture(t);
  for (const patch of [
    { url: 'nats://broker.example:4222', token: 'secret' }, { url: 'tls://localhost:4222' }, { url: 'tls://broker.example:4222' },
    { url: 'nats://user:secret@localhost:4222' }, { backend_url: 'https://example.test/?token=secret' },
    { backend_url: 'http://example.test:4173' }, { url: 'https://localhost' }, { sender_id: '' }, { instance_id: 'bad.instance' },
  ]) assert.throws(() => validateConfig({ ...config, ...patch }));
  assert.doesNotThrow(() => validateConfig({ ...config, url: 'tls://broker.example:4222', token: 'secret', backend_url: 'https://nexus.example' }));
});
test('resolution uses IDs or unique scoped names and reports ambiguous/missing candidates', () => {
  const targets = { instanceId: 'i', enabled: true, mode: 'notify_only', maxMessageBytes: 1024, projects: [
    { id: 'p', name: 'Project', updatedAt: '', threads: [{ id: 'a', name: 'Review', updatedAt: '' }, { id: 'b', name: 'Review', updatedAt: '' }] },
  ] };
  assert.deepEqual(resolveTarget(targets, 'Project', 'a'), { instanceId: 'i', projectId: 'p', threadId: 'a' });
  assert.throws(() => resolveTarget(targets, 'p', 'Review'), /"Review" \(a\).*"Review" \(b\)/);
  assert.throws(() => resolveTarget(targets, 'Other', 'a'), /"Project" \(p\)/);
});
test('v1 envelopes use unique IDs, UTF-8 byte limits and fixed reply destinations', () => {
  const target = { instanceId: 'test', projectId: 'p', threadId: 't' };
  const a = envelope('sender', target, ' Hello ', 20, 'correlation'); const b = envelope('sender', target, 'Hello', 20);
  assert.notEqual(a.id, b.id); assert.equal(a.content, 'Hello'); assert.equal(a.replyTo, 'sender');
  assert.equal(a.sender.harness, 'nexus-bridge-client'); assert.equal(a.correlationId, 'correlation');
  assert.equal(inboxSubject('test'), 'nexus.bridge.v1.inbox.test'); assert.equal(resultsSubject('sender'), 'nexus.bridge.v1.results.c2VuZGVy');
  assert.throws(() => envelope('sender', target, '😀', 3), /size limit/);
  assert.throws(() => envelope('sender', target, 'hello', 20, 'bad id'));
});
const result = { version: 1, kind: 'result', id: 'reply', sentAt: '2026-09-14T10:00:00Z', inReplyTo: 'send', correlationId: 'send',
  sender: { id: 'test' }, target: { senderId: 'reviewer' }, status: 'completed', content: 'Review complete' };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
test('results enforce source, destination and bounded v1 content', () => {
  assert.deepEqual(parseResult(bytes(result), 'reviewer', 'test'), result);
  for (const patch of [{ kind: 'message' }, { version: 2 }, { target: { senderId: 'other' } }, { sender: { id: 'other' } }, { status: 'run' }, { content: 'x'.repeat(8001) }, { error: 'x'.repeat(2001) }, { id: 'bad id' }]) {
    assert.throws(() => parseResult(bytes({ ...result, ...patch }), 'reviewer', 'test'));
  }
});
test('state survives restart, deduplicates replies, isolates identities and recovers reader leases', t => {
  const { config, root } = fixture(t); let state = new State(config);
  const message = envelope('reviewer', { instanceId: 'test', projectId: 'p', threadId: 't' }, 'hello', 100);
  state.saveSend(message); state.receive(result as any); state.receive(result as any);
  assert.equal(state.unread().length, 1);
  const second = new State(config); assert.equal(state.namespace, second.namespace);
  const unlock = state.lockReader(); assert.throws(() => second.lockReader(), /Another result reader/); unlock();
  const release = second.lockReader(); release(); second.close();
  state.close(); state = new State(config);
  assert.deepEqual(state.send(message.id), message);
  assert.equal(state.unread().length, 1); state.delivered(['reply']); state.close(); state = new State(config);
  assert.deepEqual(state.unread(), []);
  state.db.prepare('INSERT INTO reader VALUES (1, ?, ?)').run('crashed', Date.now() - 1);
  state.lockReader()(); state.close();
  const other = new State({ ...config, sender_id: 'another' }); assert.equal(other.send(message.id), undefined); other.close();
  assert.equal(statSync(root).mode & 0o777, 0o700);
  for (const file of readdirSync(root)) assert.equal(statSync(join(root, file)).mode & 0o777, 0o600);
});
test('retry arguments are immutable and missing saved IDs cannot publish', async t => {
  const { config } = fixture(t); const client = new BridgeClient(config);
  await assert.rejects(client.send({ retryId: 'unknown' }), /No stored send/);
  await assert.rejects(client.send({ retryId: 'unknown', content: 'different' }), /cannot be combined/);
  await client.close();
});

test('target discovery sends only the backend credential and rejects bad responses before saving a send', async t => {
  const { config } = fixture(t); config.backend_token = 'backend-secret'; config.token = 'broker-secret';
  const client = new BridgeClient(config);
  const valid = { instanceId: 'test', enabled: true, mode: 'queue_for_approval', maxMessageBytes: 1024, projects: [] };
  let response: unknown = valid;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'http://127.0.0.1:4173/api/agent-bridge/targets');
    assert.deepEqual(init.headers, { Authorization: 'Bearer backend-secret' }); assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response(JSON.stringify(response), { status: 200 });
  });
  await assert.rejects(client.send({ project: 'p', thread: 't', content: 'hello' }), /Candidates/);
  response = { ...valid, instanceId: 'another' }; await assert.rejects(client.send({ project: 'p', thread: 't', content: 'hello' }), /instance mismatch/);
  response = { ...valid, enabled: false }; await assert.rejects(client.send({ project: 'p', thread: 't', content: 'hello' }), /disabled/);
  response = { ...valid, maxMessageBytes: 999999999 }; await assert.rejects(client.send({ project: 'p', thread: 't', content: 'hello' }), /Invalid target/);
  assert.equal((client.state.db.prepare('SELECT COUNT(*) AS n FROM sends').get() as any).n, 0);
  await client.close();
});

test('shared Nexus YAML loads without shell exports, standalone and environment overrides win', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'config.yaml'), 'server:\n  token: server-only-secret\nbridge_client:\n  instance_id: nexus-test\n  sender_id: chonk\n  url: tls://broker.example:4222\n  backend_url: https://nexus.example\n  token: broker-secret\n  backend_token: backend-secret\n');
  const config = loadConfig(undefined, { NEXUS_HOME: root });
  assert.equal(config.sender_id, 'chonk'); assert.equal(config.token, 'broker-secret'); assert.equal(config.backend_token, 'backend-secret');
  assert.equal(JSON.stringify(identity(config)).includes('secret'), false);
  assert.equal(safeError(new Error('broker-secret backend-secret'), config), '[redacted] [redacted]');
  writeFileSync(join(root, 'bridge-client.yaml'), 'sender_id: standalone\n');
  assert.equal(loadConfig(undefined, { NEXUS_HOME: root }).sender_id, 'standalone');
  assert.equal(loadConfig(undefined, { NEXUS_HOME: root, NEXUS_AGENT_BRIDGE_TOKEN: 'override' }).token, 'override');
  assert.equal(loadConfig(join(root, 'config.yaml'), {}).sender_id, 'chonk');
});
test('shared YAML never infers credentials from the Nexus server or broker sections', t => {
  const { root } = fixture(t);
  writeFileSync(join(root, 'config.yaml'), 'server:\n  token: server-secret\nagent_bridge:\n  token: broker-secret\nbridge_client:\n  instance_id: test\n  sender_id: chonk\n');
  assert.equal(loadConfig(undefined, { NEXUS_HOME: root }).token, '');
  assert.equal(loadConfig(undefined, { NEXUS_HOME: root }).backend_token, '');
});
