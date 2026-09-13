import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaudeEngineConfig } from '../engines/claude/status.js';

const base = { enabled: true, auth: 'subscription' as const, oauth_token: '', executable_path: '' };

test('normalizeClaudeEngineConfig drops unknown setting_sources entries', () => {
  const result = normalizeClaudeEngineConfig({ ...base, setting_sources: ['user', 'bogus', 42] as any, skills: 'all' });
  assert.deepEqual(result.settingSources, ['user']);
});

test('normalizeClaudeEngineConfig coerces an unrecognized skills value to "all"', () => {
  const result = normalizeClaudeEngineConfig({ ...base, setting_sources: [], skills: 'garbage' as any });
  assert.equal(result.skills, 'all');
});

test('normalizeClaudeEngineConfig treats an empty skills list as "none"', () => {
  const result = normalizeClaudeEngineConfig({ ...base, setting_sources: [], skills: [] });
  assert.equal(result.skills, 'none');
});

test('normalizeClaudeEngineConfig filters junk entries out of a skills list', () => {
  const result = normalizeClaudeEngineConfig({ ...base, setting_sources: [], skills: ['pdf', '', 3] as any });
  assert.deepEqual(result.skills, ['pdf']);
});

test('normalizeClaudeEngineConfig treats a skills list that filters down to nothing as "none"', () => {
  const result = normalizeClaudeEngineConfig({ ...base, setting_sources: [], skills: ['', 3, '   '] as any });
  assert.equal(result.skills, 'none');
});

test('desktopStatus reports the app and its session index on macOS only', async () => {
  const { desktopStatus } = await import('../engines/claude/desktop.js');
  assert.deepEqual(desktopStatus({ platform: 'linux', exists: () => true }), { appFound: false, indexFound: false });
  assert.deepEqual(desktopStatus({ platform: 'darwin', exists: (p) => p.endsWith('Claude.app') }), { appFound: true, indexFound: false });
  assert.deepEqual(desktopStatus({ platform: 'darwin', exists: (p) => p.endsWith('claude-code-sessions') }), { appFound: false, indexFound: true });
});

test('desktopResumeUrl only accepts a Claude Code session id', async () => {
  const { desktopResumeUrl, modelKeyFor } = await import('../engines/claude/desktop.js');
  assert.equal(desktopResumeUrl('AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee'), 'claude://resume?session=AAAAAAAA-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.throws(() => desktopResumeUrl('last'), /Not a Claude Code session id/);
  assert.throws(() => desktopResumeUrl('x; open /'), /Not a Claude Code session id/);
  assert.equal(modelKeyFor('claude-opus-5'), 'claude-code/claude-opus-5');
  assert.match(modelKeyFor('claude-unknown-9'), /^claude-code\//);
  assert.match(modelKeyFor(undefined), /^claude-code\//);
});
