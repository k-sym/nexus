import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerExtension, type DockerToolDeps } from '../pi/docker-tool';
import type { DockerExec, ExecResult } from '../docker/compose';
import {
  DockerAvailability,
  buildDockerToolDeps,
  buildTearDownServices,
  PROBE_TTL_MS,
} from '../docker/session-deps';
import type { NexusConfig } from '@nexus/shared';

const OK: ExecResult = { stdout: '', stderr: '', code: 0 };

/** Register the tool and hand back its definition, plus the recorded argv. */
async function registerTool(overrides: Partial<DockerToolDeps> = {}, result: Partial<ExecResult> = {}) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => { calls.push(args); return { ...OK, ...result }; };
  const started: Array<{ projectName: string; cwd: string }> = [];
  const deps: DockerToolDeps = {
    threadId: 'thread-1',
    cwd: '/repo',
    exec,
    onStarted: (projectName, cwd) => started.push({ projectName, cwd }),
    ...overrides,
  };
  let tool: any;
  await createDockerExtension(deps)({ registerTool(value: unknown) { tool = value; } } as never);
  return { tool, calls, started };
}

test('the tool registers under one name with a fixed verb set', async () => {
  const { tool } = await registerTool();
  assert.equal(tool.name, 'docker_service');
  // The model picks a verb from a list; it never supplies a command line.
  const actions = tool.parameters.properties.action.anyOf.map((v: { const: string }) => v.const);
  assert.deepEqual(actions.sort(), ['down', 'logs', 'status', 'up']);
});

test('up runs detached under the thread project and reports it started', async () => {
  const { tool, calls, started } = await registerTool();
  const result = await tool.execute('call-1', { action: 'up', services: ['db'] });

  // `up` is preceded by a `config` mount-check call, so find the up invocation.
  assert.deepEqual(calls.find((c) => c.includes('up')), ['compose', '--project-name', 'nexus-thread-1', 'up', '--detach', 'db']);
  assert.equal(result.details.status, 'ok');
  assert.equal(result.details.projectName, 'nexus-thread-1');
  // Recorded so the session can be torn down even if the model never says `down`.
  assert.deepEqual(started, [{ projectName: 'nexus-thread-1', cwd: '/repo' }]);
});

test('only up records a start', async () => {
  const { tool, started } = await registerTool();
  await tool.execute('c', { action: 'status' });
  await tool.execute('c', { action: 'logs' });
  await tool.execute('c', { action: 'down' });
  assert.deepEqual(started, [], 'nothing claims to have started services but up');
});

test('blank service names are dropped rather than passed through', async () => {
  const { tool, calls } = await registerTool();
  await tool.execute('c', { action: 'up', services: ['db', '  ', '', ' cache '] });
  assert.deepEqual(calls.find((c) => c.includes('up'))!.slice(-2), ['db', 'cache']);
});

test('a failing compose command throws with its output, not a bare exit code', async () => {
  const { tool } = await registerTool({}, { code: 1, stderr: 'service "db" has no image' });
  // Pi turns a throw into an error tool result and continues the turn, so the
  // model gets something it can act on.
  await assert.rejects(
    tool.execute('c', { action: 'up' }),
    (error: Error) => /no image/.test(error.message),
  );
});

test('compose progress on stderr is not mistaken for failure', async () => {
  // Compose writes "Creating…/Started" to stderr even when it succeeds.
  const { tool } = await registerTool({}, { code: 0, stderr: ' Container repo-db-1  Started' });
  const result = await tool.execute('c', { action: 'up' });
  assert.equal(result.details.status, 'ok');
  assert.match(result.content[0].text, /Started/);
});

test('a successful command with no output still says what happened', async () => {
  const { tool } = await registerTool();
  const result = await tool.execute('c', { action: 'down' });
  assert.match(result.content[0].text, /down completed \(project nexus-thread-1\)/);
});

test('a compose file outside the project is refused before docker is invoked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-docker-tool-'));
  try {
    const { tool, calls } = await registerTool({ cwd: root });
    await assert.rejects(
      tool.execute('c', { action: 'up', compose_file: '../escape.yml' }),
      /inside the project directory/,
    );
    assert.deepEqual(calls, [], 'nothing was spawned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two threads on one repo get separate compose projects', async () => {
  const a = await registerTool({ threadId: 'thread-a' });
  const b = await registerTool({ threadId: 'thread-b' });
  await a.tool.execute('c', { action: 'up' });
  await b.tool.execute('c', { action: 'up' });
  // The collision this whole design exists to prevent: without per-thread
  // projects both of these would be the same compose project, sharing and
  // stealing each other's containers.
  assert.notEqual(a.calls[0][2], b.calls[0][2]);
  assert.equal(a.calls[0][2], 'nexus-thread-a');
  assert.equal(b.calls[0][2], 'nexus-thread-b');
});

// ── host-mount containment on `up` ────────────────────────────────────────────

/** A tool whose exec serves a `compose config` JSON for the mount check and OK
 *  for everything else, recording the argv of each call. */
async function toolWithConfig(configJson: unknown, over: Partial<DockerToolDeps> = {}) {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args.includes('config')) return { ...OK, stdout: JSON.stringify(configJson) };
    return OK;
  };
  let tool: any;
  await createDockerExtension({ threadId: 'thread-1', cwd: '/repo', exec, ...over })(
    { registerTool(v: unknown) { tool = v; } } as never,
  );
  return { tool, calls };
}

const bind = (source: string, target = '/x') => ({ type: 'bind', source, target });
const svcConfig = (volumes: unknown[]) => ({ services: { web: { volumes } } });

test('up runs the mount check and refuses a host path outside the repo', async () => {
  const { tool, calls } = await toolWithConfig(svcConfig([bind('/etc', '/host-etc')]));
  await assert.rejects(
    tool.execute('c', { action: 'up' }),
    (e: Error) => /bind-mounts host paths outside the project/.test(e.message) && /\/etc/.test(e.message),
  );
  // The mount check ran; the `up` never did.
  assert.ok(calls.some((c) => c.includes('config')));
  assert.equal(calls.some((c) => c.includes('up')), false, 'nothing was started');
});

test('up proceeds when all mounts are inside the repo', async () => {
  const { tool, calls } = await toolWithConfig(svcConfig([bind('/repo/data', '/data')]));
  const result = await tool.execute('c', { action: 'up' });
  assert.equal(result.details.status, 'ok');
  assert.ok(calls.some((c) => c.includes('up')));
});

test('an allowlisted host mount is permitted', async () => {
  const { tool } = await toolWithConfig(svcConfig([bind('/var/run/docker.sock', '/var/run/docker.sock')]), {
    allowHostMounts: ['/var/run/docker.sock'],
  });
  const result = await tool.execute('c', { action: 'up' });
  assert.equal(result.details.status, 'ok');
});

test('up fails closed when the compose config cannot be resolved', async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    if (args.includes('config')) return { stdout: '', stderr: 'yaml: line 3: mapping values not allowed', code: 1 };
    return OK;
  };
  let tool: any;
  await createDockerExtension({ threadId: 'thread-1', cwd: '/repo', exec })(
    { registerTool(v: unknown) { tool = v; } } as never,
  );
  // Can't verify the mounts → refuse, surfacing the config error; don't start.
  await assert.rejects(tool.execute('c', { action: 'up' }), /mapping values not allowed/);
  assert.equal(calls.some((c) => c.includes('up')), false);
});

test('down/status/logs skip the mount check entirely', async () => {
  const { tool, calls } = await toolWithConfig(svcConfig([bind('/etc')]));
  await tool.execute('c', { action: 'down' });
  await tool.execute('c', { action: 'status' });
  // No `config` call for non-up actions — the check is an up-only concern.
  assert.equal(calls.some((c) => c.includes('config')), false);
});

// ── session deps ──────────────────────────────────────────────────────────────

const configWith = (enabled: boolean) => () => ({ docker: { enabled } }) as unknown as NexusConfig;

async function availabilityFor(available: boolean): Promise<DockerAvailability> {
  const exec: DockerExec = async () => (available ? OK : { stdout: '', stderr: 'no daemon', code: 1 });
  const availability = new DockerAvailability({ exec });
  await availability.refresh();
  return availability;
}

test('the tool is omitted when the feature is off, and offered when it is on', async () => {
  const availability = await availabilityFor(true);
  assert.equal(buildDockerToolDeps(availability, { getConfig: configWith(false) })('t', '/repo'), null);
  assert.ok(buildDockerToolDeps(availability, { getConfig: configWith(true) })('t', '/repo'));
});

test('the tool carries the configured allow_host_mounts, read live', async () => {
  const availability = await availabilityFor(true);
  let hosts: unknown = ['/var/run/docker.sock'];
  const getConfig = () => ({ docker: { enabled: true, allow_host_mounts: hosts } }) as unknown as NexusConfig;

  const deps = buildDockerToolDeps(availability, { getConfig })('t', '/repo');
  assert.deepEqual(deps?.allowHostMounts, ['/var/run/docker.sock']);

  // Non-string / bad entries are filtered; a change lands on the next resolve.
  hosts = ['/opt/x', 42, '', '  '];
  assert.deepEqual(buildDockerToolDeps(availability, { getConfig })('t', '/repo')?.allowHostMounts, ['/opt/x']);

  // Absent list ⇒ empty (fail closed: nothing permitted).
  const noList = () => ({ docker: { enabled: true } }) as unknown as NexusConfig;
  assert.deepEqual(buildDockerToolDeps(availability, { getConfig: noList })('t', '/repo')?.allowHostMounts, []);
});

test('the tool is omitted when no daemon answered the probe', async () => {
  const availability = await availabilityFor(false);
  // A session must never advertise a tool that cannot run.
  assert.equal(buildDockerToolDeps(availability, { getConfig: configWith(true) })('t', '/repo'), null);
});

test('the tool is omitted for a session with no project directory', async () => {
  const availability = await availabilityFor(true);
  assert.equal(buildDockerToolDeps(availability, { getConfig: configWith(true) })('t', ''), null);
});

test('a config that throws costs the tool, not the session', async () => {
  const availability = await availabilityFor(true);
  const throwing = () => { throw new Error('bad yaml'); };
  assert.equal(buildDockerToolDeps(availability, { getConfig: throwing })('t', '/repo'), null);
});

test('availability is cached and refreshed on a TTL', async () => {
  let calls = 0;
  let now = 1_000_000;
  const exec: DockerExec = async () => { calls += 1; return OK; };
  const availability = new DockerAvailability({ exec, now: () => now });

  await availability.refresh();
  assert.equal(calls, 1);
  assert.equal(availability.isAvailable(), true);
  // Repeated reads inside the TTL don't re-probe: session creation is
  // synchronous and must not pay for a daemon round trip.
  availability.isAvailable();
  availability.isAvailable();
  assert.equal(calls, 1);

  now += PROBE_TTL_MS + 1;
  availability.isAvailable();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls, 2, 'a stale read kicks off a background refresh');
});

test('a probe that throws reads as unavailable rather than propagating', async () => {
  const exec: DockerExec = async () => { throw new Error('spawn ENOENT'); };
  const availability = new DockerAvailability({ exec });
  assert.equal(await availability.refresh(), false);
  assert.equal(availability.isAvailable(), false);
});

test('teardown runs down for the thread project', async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => { calls.push(args); return OK; };
  const availability = new DockerAvailability({ exec });
  await availability.refresh();

  buildTearDownServices(availability, { exec })('thread-1', '/repo');
  await new Promise((r) => setTimeout(r, 5));

  const down = calls.find((c) => c.includes('down'));
  assert.ok(down, 'issued a compose down');
  assert.deepEqual(down, ['compose', '--project-name', 'nexus-thread-1', 'down', '--remove-orphans']);
});

test('teardown ignores the enable flag so turning the feature off cannot strand containers', async () => {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => { calls.push(args); return OK; };
  const availability = new DockerAvailability({ exec });
  await availability.refresh();

  // The flag governs whether an agent may START services, not whether we may
  // clean up after one that already did.
  buildTearDownServices(availability, { exec, getConfig: configWith(false) })('thread-1', '/repo');
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(calls.some((c) => c.includes('down')));
});

test('teardown is silent when docker is unreachable', async () => {
  const availability = await availabilityFor(false);
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => { calls.push(args); return OK; };
  buildTearDownServices(availability, { exec })('thread-1', '/repo');
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, []);
});

test('a failing teardown never surfaces as an unhandled rejection', async () => {
  const exec: DockerExec = async () => { throw new Error('daemon died mid-teardown'); };
  const availability = new DockerAvailability({ exec: async () => OK });
  await availability.refresh();
  // dropSession is synchronous and must not fail because Docker did.
  buildTearDownServices(availability, { exec })('thread-1', '/repo');
  await new Promise((r) => setTimeout(r, 10));
});
