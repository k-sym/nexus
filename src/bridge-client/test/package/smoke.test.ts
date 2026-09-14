import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exec = promisify(execFile);
test('packed artifact installs outside the workspace, exposes the bin and starts MCP with native SQLite', { timeout: 180000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-client-package-'));
  const pkg = new URL('../../', import.meta.url).pathname;
  let mcp: Client | undefined;
  try {
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--pack-destination', root], { cwd: pkg })).stdout)[0];
    assert.ok(packed.files.some((file: any) => file.path === 'dist/cli.js'));
    assert.ok(packed.files.every((file: any) => !file.path.includes('test/') && !file.path.includes('backend/')));
    writeFileSync(join(root, 'package.json'), '{"name":"isolated-client-check","private":true}');
    await exec('npm', ['install', '--no-audit', '--no-fund', ...(process.env.NEXUS_PACK_OFFLINE === '1' ? ['--offline'] : []), join(root, packed.filename)], { cwd: root, timeout: 150000 });
    const installed = join(root, 'node_modules/@nexus/bridge-client');
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.ok(Object.keys(manifest.dependencies).every(name => !name.startsWith('@nexus/')));
    const env = { PATH: process.env.PATH || '', NEXUS_BRIDGE_CONFIG: join(root, 'client.yaml'), NEXUS_BRIDGE_STATE_DIR: join(root, 'state') };
    writeFileSync(env.NEXUS_BRIDGE_CONFIG, 'instance_id: test\nsender_id: pack-test\n');
    const bin = join(root, 'node_modules/.bin/nexus-bridge');
    const who = await exec(bin, ['whoami'], { cwd: root, env }); assert.equal(JSON.parse(who.stdout).senderId, 'pack-test');
    mcp = new Client({ name: 'package-test', version: '1.0' });
    await mcp.connect(new StdioClientTransport({ command: bin, args: ['mcp'], cwd: root, env, stderr: 'pipe' }));
    assert.equal((await mcp.listTools()).tools.length, 2);
  } finally { await mcp?.close(); rmSync(root, { recursive: true, force: true }); }
});
