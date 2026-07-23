import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  boundOutput,
  ComposeFileError,
  composeArgs,
  composeDown,
  composeLogs,
  composeProjectName,
  composeStatus,
  composeUp,
  isNexusProject,
  listNexusProjects,
  probeDocker,
  resolveComposeFile,
  DEFAULT_LOG_TAIL,
  MAX_LOG_TAIL,
  type DockerExec,
  type ExecResult,
} from '../docker/compose';

const OK: ExecResult = { stdout: '', stderr: '', code: 0 };

/** Records the argv every invocation used. */
function recordingExec(result: Partial<ExecResult> = {}): { exec: DockerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    calls.push(args);
    return { ...OK, ...result };
  };
  return { exec, calls };
}

test('the compose project name is derived from the thread id alone', () => {
  // This is what makes teardown possible without stored state: the same thread
  // id always yields the same project, even after a restart that lost
  // everything in memory.
  const name = composeProjectName('Thread-ABC_123');
  assert.equal(name, composeProjectName('Thread-ABC_123'));
  assert.equal(name, 'nexus-thread-abc_123');
  assert.ok(isNexusProject(name));
});

test('project names are legal for compose whatever the thread id looks like', () => {
  // Compose requires [a-z0-9][a-z0-9_-]*; ids with slashes, dots or unicode
  // must not produce something it rejects.
  for (const id of ['A/B.C', '../evil', 'thread with spaces', 'Ünïcøde', '-leading', '']) {
    const name = composeProjectName(id);
    assert.match(name, /^[a-z0-9][a-z0-9_-]*$/, `${JSON.stringify(id)} → ${name}`);
    assert.ok(isNexusProject(name));
  }
});

test('every command is pinned to the thread project, and up is always detached', async () => {
  const { exec, calls } = recordingExec();
  const options = { cwd: '/repo', projectName: 'nexus-t1', exec };

  await composeUp(options, ['db']);
  assert.deepEqual(calls[0], ['compose', '--project-name', 'nexus-t1', 'up', '--detach', 'db']);
  // There is deliberately no way to ask for the blocking form: `up` without
  // --detach would hang the turn until the tool timeout.
  assert.ok(calls[0].includes('--detach'));

  await composeDown(options);
  assert.deepEqual(calls[1], ['compose', '--project-name', 'nexus-t1', 'down', '--remove-orphans']);

  await composeStatus(options);
  assert.deepEqual(calls[2], ['compose', '--project-name', 'nexus-t1', 'ps', '--format', 'json']);
});

test('a compose file is passed through as --file', () => {
  assert.deepEqual(
    composeArgs('nexus-t1', 'docker/compose.yml', ['ps']),
    ['compose', '--project-name', 'nexus-t1', '--file', 'docker/compose.yml', 'ps'],
  );
  assert.deepEqual(composeArgs('nexus-t1', undefined, ['ps']), ['compose', '--project-name', 'nexus-t1', 'ps']);
});

test('log tail is clamped into range', async () => {
  const { exec, calls } = recordingExec();
  const options = { cwd: '/repo', projectName: 'nexus-t1', exec };

  await composeLogs(options, [], 5);
  assert.equal(calls[0][calls[0].indexOf('--tail') + 1], '5');

  await composeLogs(options, [], 10_000);
  assert.equal(calls[1][calls[1].indexOf('--tail') + 1], String(MAX_LOG_TAIL), 'clamped down');

  await composeLogs(options, [], 0);
  assert.equal(calls[2][calls[2].indexOf('--tail') + 1], '1', 'clamped up');

  await composeLogs(options);
  assert.equal(calls[3][calls[3].indexOf('--tail') + 1], String(DEFAULT_LOG_TAIL));
});

// ── compose file containment ──────────────────────────────────────────────────

test('a compose file outside the project directory is refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-docker-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  try {
    // A compose file is executable configuration — it can bind-mount host paths
    // and publish ports — so the model must not be able to point at one outside
    // the repo it is working in.
    await assert.rejects(
      resolveComposeFile(repo, '../docker-compose.yml'),
      ComposeFileError,
    );
    await assert.rejects(
      resolveComposeFile(repo, '/etc/docker-compose.yml'),
      (e: Error) => e instanceof ComposeFileError && /relative/.test(e.message),
    );
    await assert.rejects(
      resolveComposeFile(repo, 'nested/../../escape.yml'),
      ComposeFileError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink inside the repo cannot point out of it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-docker-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(root, 'outside.yml'), 'services: {}\n');
  symlinkSync(join(root, 'outside.yml'), join(repo, 'link.yml'));
  try {
    // Lexical containment is not enough; the path has to be resolved first.
    await assert.rejects(resolveComposeFile(repo, 'link.yml'), ComposeFileError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a compose file inside the project is accepted, and omitting it is fine', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-docker-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docker'), { recursive: true });
  writeFileSync(join(repo, 'docker', 'compose.yml'), 'services: {}\n');
  try {
    assert.equal(await resolveComposeFile(repo, 'docker/compose.yml'), 'docker/compose.yml');
    // Undefined means "let Compose discover it", rooted at cwd.
    assert.equal(await resolveComposeFile(repo, undefined), undefined);
    assert.equal(await resolveComposeFile(repo, '   '), undefined);
    // A file that doesn't exist yet still passes containment — Compose reports
    // "no such file" better than we can.
    assert.equal(await resolveComposeFile(repo, 'not-created-yet.yml'), 'not-created-yet.yml');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── output bounding ───────────────────────────────────────────────────────────

test('output is bounded, keeping the tail', () => {
  const small = 'hello\nworld';
  assert.equal(boundOutput(small, 1024), small);

  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const bounded = boundOutput(big, 200);
  assert.ok(Buffer.byteLength(bounded, 'utf8') <= 200 + 30, 'trimmed to roughly the budget');
  assert.match(bounded, /^\[earlier output truncated\]/);
  // The end is what matters for docker output — the error, the newest logs.
  assert.match(bounded, /line 499$/);
});

test('bounding never splits a multi-byte character', () => {
  const text = '✅'.repeat(200);
  const bounded = boundOutput(text, 64);
  assert.ok(!bounded.includes('�'), 'no replacement characters from a mid-character cut');
});

// ── probing ───────────────────────────────────────────────────────────────────

test('probeDocker uses `info`, so a CLI without a daemon reads as unavailable', async () => {
  const { exec, calls } = recordingExec();
  assert.deepEqual(await probeDocker(exec), { available: true });
  // `docker version` succeeds with only the CLI installed, which would register
  // the tool and then fail on every call.
  assert.deepEqual(calls[0], ['info', '--format', '{{.ServerVersion}}']);

  const failing: DockerExec = async () => ({ stdout: '', stderr: 'Cannot connect to the Docker daemon\nmore', code: 1 });
  const result = await probeDocker(failing);
  assert.equal(result.available, false);
  assert.equal(result.reason, 'Cannot connect to the Docker daemon');
});

test('probeDocker treats a missing binary as unavailable, not an error', async () => {
  const throwing: DockerExec = async () => { throw new Error('spawn docker ENOENT'); };
  const result = await probeDocker(throwing);
  assert.equal(result.available, false);
  assert.match(result.reason ?? '', /ENOENT/);
});

// ── orphan discovery ──────────────────────────────────────────────────────────

test('listNexusProjects returns only projects this module owns', async () => {
  const exec: DockerExec = async () => ({
    stdout: JSON.stringify([
      { Name: 'nexus-thread-1', Status: 'running(2)' },
      { Name: 'someone-elses-stack', Status: 'running(1)' },
      { Name: 'nexus-thread-2', Status: 'exited(1)' },
    ]),
    stderr: '',
    code: 0,
  });
  assert.deepEqual(await listNexusProjects(exec), ['nexus-thread-1', 'nexus-thread-2']);
});

test('listNexusProjects degrades to empty rather than throwing on odd output', async () => {
  // A docker whose `compose ls --format json` shape differs is not worth
  // failing a cleanup sweep over.
  for (const stdout of ['not json', '{}', '', 'null']) {
    const exec: DockerExec = async () => ({ stdout, stderr: '', code: 0 });
    assert.deepEqual(await listNexusProjects(exec), []);
  }
  const failing: DockerExec = async () => ({ stdout: '', stderr: 'boom', code: 1 });
  assert.deepEqual(await listNexusProjects(failing), []);
});
