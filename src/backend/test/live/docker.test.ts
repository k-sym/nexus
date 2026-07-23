/**
 * Live integration test for `docker_service`, against a real Docker daemon.
 *
 * Skipped when no daemon answers (see ./gate.ts). The unit tests in
 * ../docker-tool.test.ts and ../docker-compose.test.ts drive a fake `exec` and
 * prove the argv and the branching; this proves the claims that only a real
 * daemon can — that `up` is genuinely detached, that two threads on one repo
 * don't collide, and that teardown and the orphan sweep actually remove
 * containers.
 *
 * Uses alpine (tiny, pulls fast on a cold runner) running `sleep`, publishes no
 * ports, and namespaces every project by pid so a rerun or a parallel job
 * cannot clash. Everything it starts is torn down in `after`, including on
 * failure.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerExtension } from '../../pi/docker-tool';
import { probeDocker, realDockerExec, composeProjectName, composeDown, listNexusProjects } from '../../docker/compose';
import { liveSkip } from './gate';

const probe = await probeDocker();
const skip = liveSkip('Docker daemon', probe.available, probe.reason ?? 'docker info failed');

// A distinct thread id per project role, namespaced by pid so concurrent or
// repeated runs never share a compose project.
const suffix = `livetest-${process.pid}`;
const ALPHA = `${suffix}-alpha`;
const BETA = `${suffix}-beta`;
const ORPHAN = `${suffix}-orphan`;
const ALL = [ALPHA, BETA, ORPHAN];

const COMPOSE = `services:
  web:
    image: alpine:3
    command: ["sh", "-c", "echo NEXUS_LIVE_MARKER; sleep 3600"]
  side:
    image: alpine:3
    command: ["sh", "-c", "sleep 3600"]
`;

let repo: string;

function toolFor(threadId: string, cwd: string) {
  let tool: any;
  createDockerExtension({ threadId, cwd, exec: realDockerExec })({
    registerTool(value: unknown) { tool = value; },
  } as never);
  return tool;
}

async function runningContainers(threadId: string): Promise<string[]> {
  const result = await realDockerExec(
    ['ps', '--filter', `label=com.docker.compose.project=${composeProjectName(threadId)}`, '--format', '{{.Names}}'],
    { timeoutMs: 20_000 },
  );
  return result.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

before(async () => {
  if (skip !== false) return;
  repo = mkdtempSync(join(tmpdir(), 'nexus-live-docker-'));
  writeFileSync(join(repo, 'docker-compose.yml'), COMPOSE);
  // Pre-pull so the per-test `up` timing measures the tool, not a cold image pull.
  await realDockerExec(['pull', 'alpine:3'], { timeoutMs: 180_000 });
});

after(async () => {
  for (const threadId of ALL) {
    await realDockerExec(
      ['compose', '--project-name', composeProjectName(threadId), 'down', '--remove-orphans'],
      { cwd: repo, timeoutMs: 60_000 },
    ).catch(() => {});
  }
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('up starts services detached and returns while they keep running', { skip }, async () => {
  const tool = toolFor(ALPHA, repo);
  const started = Date.now();
  const result = await tool.execute('c1', { action: 'up' });
  const elapsed = Date.now() - started;

  assert.equal(result.details.status, 'ok');
  // Detached: the call returns promptly even though the containers run for an
  // hour. A blocking `up` would sit here until the tool timeout.
  assert.ok(elapsed < 60_000, `up returned in ${elapsed}ms`);
  assert.equal((await runningContainers(ALPHA)).length, 2);
});

test('status and logs reflect the running services', { skip }, async () => {
  const tool = toolFor(ALPHA, repo);
  const status = await tool.execute('c2', { action: 'status' });
  assert.match(status.content[0].text, /web/);
  assert.match(status.content[0].text, /side/);

  const logs = await tool.execute('c3', { action: 'logs', services: ['web'], tail: 20 });
  assert.match(logs.content[0].text, /NEXUS_LIVE_MARKER/);
});

test('two threads on one repo get isolated container sets', { skip }, async () => {
  const beta = toolFor(BETA, repo);
  await beta.execute('c4', { action: 'up', services: ['web'] });

  const alpha = await runningContainers(ALPHA);
  const betaContainers = await runningContainers(BETA);

  // The collision the per-thread compose project exists to prevent: without it
  // both threads would share one project and steal each other's containers.
  assert.equal(alpha.length, 2, 'alpha untouched by beta');
  assert.equal(betaContainers.length, 1, 'beta has its own');
  assert.equal(alpha.some((name) => betaContainers.includes(name)), false, 'no shared container');
});

test('an unknown service name surfaces as an error', { skip }, async () => {
  const tool = toolFor(ALPHA, repo);
  await assert.rejects(tool.execute('c5', { action: 'up', services: ['nope'] }));
});

test('down removes only the calling thread\'s containers', { skip }, async () => {
  const alpha = toolFor(ALPHA, repo);
  await alpha.execute('c6', { action: 'down' });

  assert.equal((await runningContainers(ALPHA)).length, 0, 'alpha torn down');
  assert.equal((await runningContainers(BETA)).length, 1, 'beta left alone');
});

test('a running project is listed by name for the orphan sweep', { skip }, async () => {
  // The sweep decides what to keep vs remove purely from `listNexusProjects`,
  // whose real-Docker behaviour is parsing `docker compose ls --format json`.
  // BETA is still up from the isolation test. (The keep-vs-remove logic itself
  // is covered against a fake exec in ../docker-sweep.test.ts — running the real
  // global sweep here would tear down a developer's own nexus- projects.)
  const projects = await listNexusProjects(realDockerExec);
  assert.ok(projects.includes(composeProjectName(BETA)), 'a running Nexus project is discoverable by name alone');
});

test('teardown by project name works with no compose file — the orphan-cleanup path', { skip }, async () => {
  // This is what lets the sweep clean up a project whose repo was deleted:
  // `compose down` reconstructs the project from container labels, so it needs
  // neither the compose file nor its original cwd. Start ORPHAN, then tear it
  // down addressing only the project name.
  const orphanTool = toolFor(ORPHAN, repo);
  await orphanTool.execute('c7', { action: 'up', services: ['web'] });
  assert.equal((await runningContainers(ORPHAN)).length, 1, 'orphan is running');

  const result = await composeDown({ projectName: composeProjectName(ORPHAN), exec: realDockerExec });
  assert.equal(result.code, 0);
  assert.equal((await runningContainers(ORPHAN)).length, 0, 'removed by project name, no compose file given');
});
