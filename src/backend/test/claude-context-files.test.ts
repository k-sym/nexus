import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTEXT_FILE_MAX_CHARS, formatContextFiles, projectContextAppendix, selectContextFiles } from '../engines/claude/context-files.js';

test('selectContextFiles drops CLAUDE.md only when the SDK loads project settings itself', () => {
  const files = [{ path: '/r/AGENTS.md', content: 'a' }, { path: '/r/CLAUDE.md', content: 'c' }];
  assert.deepEqual(selectContextFiles(files, []).map((f) => f.path), ['/r/AGENTS.md', '/r/CLAUDE.md']);
  assert.deepEqual(selectContextFiles(files, ['project']).map((f) => f.path), ['/r/AGENTS.md']);
  assert.deepEqual(selectContextFiles(files, ['user']).map((f) => f.path), ['/r/AGENTS.md', '/r/CLAUDE.md']);
});

test('formatContextFiles labels each file and truncates long ones', () => {
  assert.equal(formatContextFiles([]), '');
  const out = formatContextFiles([{ path: '/r/AGENTS.md', content: 'Be terse.' }, { path: '/r/sub/CLAUDE.md', content: 'x'.repeat(CONTEXT_FILE_MAX_CHARS + 10) }]);
  assert.match(out, /^# Project instructions \(AGENTS\.md\)\n\nBe terse\./);
  assert.match(out, /# Project instructions \(CLAUDE\.md\)\n\nx+\n\n\[truncated\]$/);
  assert.ok(out.length < CONTEXT_FILE_MAX_CHARS + 200);
});

test('projectContextAppendix reads AGENTS.md from the cwd via the Pi loader and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ctx-'));
  try {
    const cwd = join(dir, 'repo'); mkdirSync(cwd); writeFileSync(join(cwd, 'AGENTS.md'), 'Use pnpm.');
    const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
    assert.match(projectContextAppendix(cwd, agentDir, []), /Use pnpm\./);
    assert.equal(projectContextAppendix(join(dir, 'missing'), agentDir, []), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
