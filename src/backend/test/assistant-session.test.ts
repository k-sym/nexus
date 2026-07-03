import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openAssistantSession,
  appendUserMessage,
  appendAssistantMessage,
  appendToolResult,
  appendRunStart,
  appendRunEnd,
  readAssistantEntries,
} from '../pi/assistant-session.js';

test('assistant Pi-session round-trips user/assistant/tool/run entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-assistant-pi-'));
  const cwd = join(dir, 'cwd');
  const sessionDir = join(dir, 'sessions');
  try {
    const sm = await openAssistantSession('sess-1', sessionDir, cwd);
    appendRunStart(sm, { event: 'start', runId: 'run-1', threadId: 'sess-1', startedAt: '2026-07-02T10:00:00.000Z' });
    appendUserMessage(sm, 'do the thing');
    const assistantId = appendAssistantMessage(sm, {
      text: 'done',
      toolCalls: [{ type: 'toolCall', id: 'call-1', name: 'read_file', arguments: { path: '/x' } }],
    });
    appendToolResult(sm, { toolCallId: 'call-1', toolName: 'read_file', output: 'file body' });
    appendRunEnd(sm, { event: 'end', runId: 'run-1', threadId: 'sess-1', assistantEntryId: assistantId, completedAt: '2026-07-02T10:00:01.000Z', status: 'completed' });

    const entries = await readAssistantEntries('sess-1', sessionDir, cwd) as any[];
    const roles = entries.filter((e) => e.type === 'message').map((e) => e.message.role);
    assert.deepEqual(roles, ['user', 'assistant', 'toolResult']);
    const custom = entries.filter((e) => e.type === 'custom' && e.customType === 'nexus.agent_run');
    assert.deepEqual(custom.map((e: any) => e.data.event), ['start', 'end']);
    const assistant = entries.find((e) => e.type === 'message' && e.message.role === 'assistant') as any;
    assert.equal(assistant.message.content.find((c: any) => c.type === 'toolCall').id, 'call-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
