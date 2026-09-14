import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import { connect } from '@nats-io/transport-node';
import { jetstream } from '@nats-io/jetstream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { getDb } from '../../../backend/db.js';
import { AgentBridgeService } from '../../../backend/agent-bridge/service.js';
import { registerAgentBridgeRoutes } from '../../../backend/routes/agent-bridge.js';
import { registerBackendAuth } from '../../../backend/auth-gate.js';
import { resultsSubject } from '../../src/protocol.js';

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 30)); }
}
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
const cliPath = new URL('../../dist/cli.js', import.meta.url).pathname;
function command(args: string[], env: Record<string, string>, input?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    const child = execFile(process.execPath, [cliPath, ...args], { env, timeout: 20000 }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, stdout, stderr }));
    child.stdin!.end(input);
  });
}

test('CLI and stdio MCP send through scoped Nexus; approvals, retry, restart and reply dedup work over real NATS', { timeout: 90000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-client-live-'));
  const brokerPort = await freePort(); const url = `nats://127.0.0.1:${brokerPort}`;
  let broker: ReturnType<typeof spawn> | undefined; let launchError: Error | undefined;
  const startBroker = () => {
    broker = spawn(process.env.NATS_SERVER_BINARY || 'nats-server', ['-js', '-a', '127.0.0.1', '-p', String(brokerPort), '--auth', 'broker-secret', '-sd', join(root, 'broker')], { stdio: 'ignore' });
    broker.on('error', error => { launchError = error; });
  };
  const stopBroker = async () => {
    if (broker?.pid && broker.exitCode === null) { const exit = new Promise(resolve => broker!.once('exit', resolve)); broker.kill('SIGTERM'); await exit; }
  };
  let nc: Awaited<ReturnType<typeof connect>> | undefined;
  const brokerReady = async () => {
    await until(async () => {
      if (launchError) return true;
      try { nc = await connect({ servers: url, token: 'broker-secret', timeout: 100, reconnect: false }); return true; } catch { return false; }
    }, 'broker startup');
  };
  const db = getDb(join(root, 'backend.sqlite'));
  const app = Fastify(); app.decorate('db', db); registerBackendAuth(app, 'backend-secret');
  let service: AgentBridgeService | undefined; let mcp: Client | undefined;
  try {
    startBroker(); await brokerReady();
    if (launchError) { if (process.env.NEXUS_REQUIRE_LIVE === '1') throw launchError; t.skip('Install nats-server'); return; }
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, slug, name, repo_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('p', 'p', 'Nexus', root, now, now);
    for (const id of ['t', 'excluded']) db.prepare('INSERT INTO chat_threads (id, project_id, title, created_at, updated_at, last_model_key) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'p', id === 't' ? 'Review' : 'Hidden', now, now, 'test/model');
    service = new AgentBridgeService(db, { enabled: true, mode: 'queue_for_approval', url, token: 'broker-secret', instance_id: 'test', allowed_senders: ['reviewer'],
      max_message_bytes: 1024, max_messages_per_minute: 100, max_hops: 4, retention_days: 30, reply_max_attempts: 60 });
    service.store.setPolicy('p', { enabled: true, thread_ids: ['t'] });
    let runs = 0;
    await app.register(registerAgentBridgeRoutes, { service, runManagedTurn: async () => { runs++; return { completed: true, content: 'Verified report' }; } });
    await app.listen({ host: '127.0.0.1', port: 0 }); const port = (app.server.address() as { port: number }).port;
    service.start(); await until(() => service!.status().state === 'connected', 'backend connected');
    const configFile = join(root, 'client.yaml'); writeFileSync(configFile, `instance_id: test\nsender_id: reviewer\nurl: ${url}\nbackend_url: http://127.0.0.1:${port}\n`);
    const env = { PATH: process.env.PATH || '', NEXUS_BRIDGE_CONFIG: configFile, NEXUS_BRIDGE_STATE_DIR: join(root, 'state'), NEXUS_AGENT_BRIDGE_TOKEN: 'broker-secret', NEXUS_BRIDGE_BACKEND_TOKEN: 'backend-secret' };
    const post = (id: string, action: string) => app.inject({ method: 'POST', url: `/api/agent-bridge/messages/${id}/${action}`, headers: { authorization: 'Bearer backend-secret' } });
    const badAuth = await command(['send', '--project', 'p', '--thread', 't', 'hello'], { ...env, NEXUS_BRIDGE_BACKEND_TOKEN: 'wrong-secret' });
    assert.equal(badAuth.code, 1); assert.match(badAuth.stderr, /HTTP 401/); assert.equal(badAuth.stderr.includes('wrong-secret'), false);
    const missing = await command(['send', '--project', 'Nexus', '--thread', 'Hidden', 'hello'], env);
    assert.equal(missing.code, 1); assert.match(missing.stderr, /Review/); assert.equal(service.store.list().length, 0);
    const start = Date.now();
    const sent = await command(['send', '--project', 'Nexus', '--thread', 'Review', '--correlation', 'case-1', '-'], env, 'hello');
    assert.equal(sent.code, 0, sent.stderr); const first = JSON.parse(sent.stdout).id;
    await until(() => !!service!.store.get(first), 'CLI inbox'); assert.ok(Date.now() - start < 2000);
    assert.equal(service.store.get(first)?.status, 'pending_approval'); assert.equal(runs, 0);
    service.config.mode = 'notify_only';
    const second = await command(['send', '--project', 'p', '--thread', 't', 'hello'], env); assert.equal(second.code, 0, second.stderr);
    assert.notEqual(JSON.parse(second.stdout).id, first);
    await until(() => !!service!.store.get(JSON.parse(second.stdout).id), 'notify-only delivery');
    assert.equal(service.store.get(JSON.parse(second.stdout).id)?.status, 'received');
    service.config.mode = 'queue_for_approval';
    assert.equal((await command(['send', '--retry', first], env)).code, 0);
    assert.equal(service.store.list().filter(message => message.id === first).length, 1);
    assert.equal((await post(first, 'approve')).statusCode, 202); await until(() => !!service!.store.reply(first), 'reply draft');
    assert.equal((await command(['results'], env)).stdout, '', 'no reply before approval');
    assert.equal((await post(first, 'reply/send')).statusCode, 202); await until(() => service!.store.reply(first)?.status === 'sent', 'reply published');
    const follower = spawn(process.execPath, [cliPath, 'results', '--follow'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const received = { stdout: '', stderr: '' };
    follower.stdout.on('data', chunk => { received.stdout += chunk; }); follower.stderr.on('data', chunk => { received.stderr += chunk; });
    try {
      await until(() => received.stdout.includes('\n'), 'follow prints reply');
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally { const exited = new Promise(resolve => follower.once('exit', resolve)); follower.kill('SIGTERM'); await exited; }
    assert.equal(received.stderr, '');
    assert.equal(JSON.parse(received.stdout).content, 'Verified report'); assert.equal(JSON.parse(received.stdout).correlationId, 'case-1');
    assert.equal((await command(['results'], env)).stdout, '', 'no duplicate on client restart');
    await jetstream(nc!).publish(resultsSubject('reviewer'), Buffer.from(service.store.reply(first)!.payload));
    await jetstream(nc!).publish(resultsSubject('reviewer'), Buffer.from('{"kind":"message"}'));
    assert.equal((await command(['results'], env)).stdout, '', 'redelivery and malformed results are not printed');
    // Real stdio transport: protocol startup, tools discovery, send and results.
    mcp = new Client({ name: 'acceptance', version: '1.0.0' });
    await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [cliPath, 'mcp'], env, stderr: 'pipe' }));
    assert.deepEqual((await mcp.listTools()).tools.map(tool => tool.name), ['nexus_bridge_send', 'nexus_bridge_results']);
    const mcpSent = await mcp.callTool({ name: 'nexus_bridge_send', arguments: { project: 'Nexus', thread: 'Review', content: 'MCP review' } });
    assert.notEqual(mcpSent.isError, true, JSON.stringify(mcpSent)); const mcpId = (mcpSent.structuredContent as any).id;
    await until(() => !!service!.store.get(mcpId), 'MCP inbox');
    await post(mcpId, 'approve'); await until(() => !!service!.store.reply(mcpId), 'MCP reply draft');
    await post(mcpId, 'reply/send'); await until(() => service!.store.reply(mcpId)?.status === 'sent', 'MCP reply published');
    const mcpResults = await mcp.callTool({ name: 'nexus_bridge_results', arguments: {} });
    assert.notEqual(mcpResults.isError, true, JSON.stringify(mcpResults)); assert.equal((mcpResults.structuredContent as any).results[0].inReplyTo, mcpId);
    await mcp.close(); mcp = undefined;
    assert.equal((await command(['results'], env)).stdout, '', 'MCP output is durably marked delivered');
    // Store an uncertain send through a real outage, then retry from a fresh CLI process.
    await nc!.close(); nc = undefined; await stopBroker();
    const failed = await command(['send', '--project', 'p', '--thread', 't', 'outage-send'], env);
    assert.equal(failed.code, 1); const retry = failed.stderr.match(/--retry ([a-f0-9-]+)/)![1];
    assert.equal(failed.stderr.includes('broker-secret'), false);
    startBroker(); await brokerReady(); await until(() => service!.status().state === 'connected', 'backend reconnect');
    const recovered = await command(['send', '--retry', retry], env); assert.equal(recovered.code, 0, recovered.stderr);
    await until(() => !!service!.store.get(retry), 'recovered send'); assert.equal(service.store.get(retry)?.content, 'outage-send');
    assert.equal((await command(['send', '--retry', retry], env)).code, 0);
    assert.equal(service.store.list().filter(message => message.id === retry).length, 1);
    for (const file of readdirSync(env.NEXUS_BRIDGE_STATE_DIR)) {
      const data = readFileSync(join(env.NEXUS_BRIDGE_STATE_DIR, file));
      assert.equal(data.includes(Buffer.from('broker-secret')), false); assert.equal(data.includes(Buffer.from('backend-secret')), false);
    }
  } finally {
    await mcp?.close(); await service?.stop(); await app.close(); await nc?.close(); await stopBroker(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
