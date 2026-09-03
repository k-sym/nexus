import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolUseCorrelator } from '../engines/claude/tool-use-correlator.js';

test('claim returns the id whose input matches, then removes it', () => {
  const c = new ToolUseCorrelator();
  c.remember('mcp__nexus__question', 'toolu_1', { questions: [{ id: 'a' }] });
  c.remember('mcp__nexus__question', 'toolu_2', { questions: [{ id: 'b' }] });
  assert.equal(c.claim('mcp__nexus__question', { questions: [{ id: 'b' }] }), 'toolu_2');
  assert.equal(c.claim('mcp__nexus__question', { questions: [{ id: 'b' }] }), 'toolu_1'); // FIFO fallback
  assert.equal(c.claim('mcp__nexus__question', {}), undefined);
});

test('claim is scoped by tool name and clear drops everything', () => {
  const c = new ToolUseCorrelator();
  c.remember('mcp__nexus__memory_recall', 'toolu_9', { query: 'x' });
  assert.equal(c.claim('mcp__nexus__question', { query: 'x' }), undefined);
  c.clear();
  assert.equal(c.claim('mcp__nexus__memory_recall', { query: 'x' }), undefined);
});
