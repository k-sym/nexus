import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PiRuntime } from '../../pi/runtime.js';
import { ClaudeEngine } from '../../engines/claude/engine.js';
import { findClaudeModel } from '../../engines/claude/models.js';

// Opt-in: NEXUS_LIVE_CLAUDE=1 plus a working `claude` login or CLAUDE_CODE_OAUTH_TOKEN.
const enabled = process.env.NEXUS_LIVE_CLAUDE === '1';

test('Claude engine completes a real turn on Haiku and resumes it', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-live-'));
  try {
    const pi = await PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') });
    const engine = new ClaudeEngine({ pi, config: () => ({ enabled: true, auth: 'subscription', oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}', executable_path: '' }), log: (l) => console.log(l) });
    const session = await engine.sessionFor('live-thread', dir);
    await session.setModel(findClaudeModel('claude-haiku-4-5')!);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('Reply with exactly the word PONG and nothing else.');
    const end = events.filter((e) => e.type === 'message_end').at(-1);
    assert.match(end.message.content.map((b: any) => b.text ?? '').join(''), /PONG/);
    assert.ok((session as any).engineSessionId, 'session id recorded');
    await session.prompt('What word did you just say? Answer with that word only.');
    const second = events.filter((e) => e.type === 'message_end').at(-1);
    assert.match(second.message.content.map((b: any) => b.text ?? '').join(''), /PONG/);
    assert.ok(session.getContextUsage()?.contextWindow, 'context usage populated');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude engine runs a tool through the Nexus policy and persists one entry per message_end', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-claude-live-'));
  try {
    const pi = await PiRuntime.create({ authFile: join(dir, 'auth.json'), sessionsDir: join(dir, 'sessions') });
    const engine = new ClaudeEngine({ pi, config: () => ({ enabled: true, auth: 'subscription', oauth_token: '${CLAUDE_CODE_OAUTH_TOKEN}', executable_path: '' }), log: (l) => console.log(l) });
    const session = await engine.sessionFor('live-tool-thread', dir);
    await session.setModel(findClaudeModel('claude-haiku-4-5')!);
    const events: any[] = [];
    session.subscribe((ev) => { events.push(ev); });
    await session.prompt('Use the Bash tool to run `echo nexus-live` and reply with only its output.');

    const entries = (session as any).sessionManager.getEntries() as any[];
    const messages = entries.filter((e) => e.type === 'message').map((e) => e.message);
    const assistants = messages.filter((m: any) => m.role === 'assistant');
    const toolResults = messages.filter((m: any) => m.role === 'toolResult');
    const ends = events.filter((e) => e.type === 'message_end');
    // The regression this guards: per-content-block `assistant` frames used to
    // persist one entry per block, so a think→text→tool turn wrote three.
    assert.equal(assistants.length, ends.length, 'one persisted assistant entry per message_end');
    assert.ok(toolResults.length >= 1, 'at least one tool result persisted');
    assert.ok(events.some((e) => e.type === 'tool_execution_start'), 'the tool call was announced');
    assert.match(ends.at(-1).message.content.map((b: any) => b.text ?? '').join(''), /nexus-live/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
