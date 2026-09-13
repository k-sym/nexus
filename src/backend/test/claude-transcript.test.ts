import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DESKTOP_SYNC_CUSTOM_TYPE } from '@nexus/shared';
import {
  advanceSyncCursorToEnd,
  claudeProjectDir,
  readSyncCursor,
  reconcileSharedTranscript,
  replaySdkMessages,
  transcriptPath,
} from '../engines/claude/transcript.js';

/** Enough of Pi's SessionManager for the replay: append-only, in memory. */
function fakeSessionManager() {
  const entries: any[] = [];
  return {
    entries,
    appendMessage: (message: any) => { entries.push({ type: 'message', message }); return String(entries.length); },
    appendCustomEntry: (customType: string, data?: unknown) => { entries.push({ type: 'custom', customType, data }); return String(entries.length); },
    getEntries: () => entries,
  };
}

const user = (uuid: string, content: any) => ({ type: 'user' as const, uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content } });
const assistant = (uuid: string, content: any[], extra: any = {}) => ({
  type: 'assistant' as const, uuid, session_id: 's', parent_tool_use_id: null, parent_agent_id: null,
  message: { id: `msg-${uuid}`, role: 'assistant', model: 'claude-opus-5', content, stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 }, ...extra },
});

const transcript = [
  user('u1', 'Hello there'),
  assistant('a1', [{ type: 'text', text: 'Hi.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/x' } }], { stop_reason: 'tool_use' }),
  user('u2', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file contents' }]),
  assistant('a2', [{ type: 'text', text: 'Done.' }]),
  user('u3', '<command-name>/clear</command-name>'),
  user('u4', [{ type: 'text', text: 'Thanks' }]),
];

test('replaySdkMessages turns a Claude transcript into Pi entries in order', () => {
  const sm = fakeSessionManager();
  const result = replaySdkMessages(sm as any, transcript as any, { model: 'claude-sonnet-5', now: () => 5 });
  const roles = sm.entries.map((e) => e.message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant', 'user']);
  assert.equal(result.appended, 5);
  assert.equal(result.lastUuid, 'u4');
  assert.equal(result.lastModel, 'claude-opus-5');
  assert.equal(sm.entries[0].message.content, 'Hello there');
  assert.equal(sm.entries[1].message.content[1].name, 'Read');
  assert.equal(sm.entries[1].message.stopReason, 'toolUse');
  assert.equal(sm.entries[2].message.toolName, 'Read');
  assert.equal(sm.entries[2].message.content[0].text, 'file contents');
  assert.equal(sm.entries[4].message.content, 'Thanks');
});

test('replaySdkMessages flushes a response the transcript left open and skips subagent traffic', () => {
  const sm = fakeSessionManager();
  const open = assistant('a9', [{ type: 'text', text: 'partial' }], { stop_reason: null });
  const sub = { ...assistant('a10', [{ type: 'text', text: 'sub' }]), parent_tool_use_id: 'toolu_parent' };
  replaySdkMessages(sm as any, [user('u1', 'go'), sub, open] as any, { model: 'm' });
  assert.deepEqual(sm.entries.map((e) => e.message.role), ['user', 'assistant']);
  assert.equal(sm.entries[1].message.content[0].text, 'partial');
});

function makeTranscriptDir(cwd: string, sessionId: string, env: NodeJS.ProcessEnv, lines = 3) {
  mkdirSync(claudeProjectDir(cwd, env), { recursive: true });
  writeFileSync(transcriptPath(cwd, sessionId, env), Array.from({ length: lines }, (_, i) => JSON.stringify({ line: i })).join('\n'));
}

test('reconcileSharedTranscript replays past the cursor, once, and is a stat when the file is unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-transcript-'));
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const cwd = join(dir, 'repo');
  const sessionId = '11111111-2222-3333-4444-555555555555';
  try {
    makeTranscriptDir(cwd, sessionId, env, 2);
    const sm = fakeSessionManager();
    let reads = 0;
    let served: any[] = transcript.slice(0, 2);
    const getSessionMessages = async () => { reads += 1; return served; };
    const first = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages });
    assert.equal(first.appended, 2);
    assert.equal(first.skipped, null);
    assert.equal(readSyncCursor(sm as any)?.lastUuid, 'a1');

    // Same size: no read at all.
    const second = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages });
    assert.equal(second.skipped, 'unchanged');
    assert.equal(reads, 1);

    // The desktop appended two more messages.
    makeTranscriptDir(cwd, sessionId, env, 5);
    served = transcript.slice(0, 4);
    const third = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages });
    assert.equal(third.appended, 2);
    assert.deepEqual(sm.entries.filter((e) => e.type === 'message').map((e) => e.message.role), ['user', 'assistant', 'toolResult', 'assistant']);
    assert.equal(readSyncCursor(sm as any)?.lastUuid, 'a2');
    assert.equal(sm.entries.filter((e) => e.type === 'custom' && e.customType === DESKTOP_SYNC_CUSTOM_TYPE).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reconcileSharedTranscript falls back to the message count when the cursor uuid is gone, and reports a missing transcript', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-transcript-'));
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const cwd = join(dir, 'repo');
  const sessionId = '11111111-2222-3333-4444-555555555555';
  try {
    const sm = fakeSessionManager();
    const missing = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages: async () => [] });
    assert.equal(missing.skipped, 'missing');

    makeTranscriptDir(cwd, sessionId, env, 1);
    sm.appendCustomEntry(DESKTOP_SYNC_CUSTOM_TYPE, { lastUuid: 'nope', messageCount: 1, fileSize: -1, syncedAt: 'x' });
    const logs: string[] = [];
    const result = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages: async () => transcript.slice(0, 2) as any, log: (l) => logs.push(l) });
    assert.equal(result.appended, 1);
    assert.match(logs[0], /falling back to offset 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('advanceSyncCursorToEnd records the end of the transcript without replaying', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-transcript-'));
  const env = { CLAUDE_CONFIG_DIR: join(dir, 'claude') };
  const cwd = join(dir, 'repo');
  const sessionId = '11111111-2222-3333-4444-555555555555';
  try {
    makeTranscriptDir(cwd, sessionId, env, 4);
    const sm = fakeSessionManager();
    const cursor = await advanceSyncCursorToEnd({ sessionManager: sm as any, cwd, sessionId, env, getSessionMessages: async () => transcript as any });
    assert.equal(cursor?.lastUuid, 'u4');
    assert.equal(cursor?.messageCount, transcript.length);
    assert.equal(sm.entries.filter((e) => e.type === 'message').length, 0);
    const nothing = await reconcileSharedTranscript({ sessionManager: sm as any, cwd, sessionId, model: 'm', env, getSessionMessages: async () => transcript as any });
    assert.equal(nothing.skipped, 'unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
