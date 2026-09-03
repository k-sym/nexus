import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEXUS_MCP_PREFIX, toClaudeToolName, toDisplayToolName, toPolicyToolName } from '../engines/claude/tool-names.js';

test('policy names are Pi lowercase names for built-ins and bare names for Nexus MCP tools', () => {
  assert.equal(toPolicyToolName('Bash'), 'bash');
  assert.equal(toPolicyToolName('Edit'), 'edit');
  assert.equal(toPolicyToolName('MultiEdit'), 'edit');
  assert.equal(toPolicyToolName('Write'), 'write');
  assert.equal(toPolicyToolName('Read'), 'read');
  assert.equal(toPolicyToolName('Grep'), 'grep');
  assert.equal(toPolicyToolName('Glob'), 'find');
  assert.equal(toPolicyToolName('WebSearch'), 'web_search');
  assert.equal(toPolicyToolName('mcp__nexus__question'), 'question');
  assert.equal(toPolicyToolName('mcp__nexus__docker_service'), 'docker_service');
  // Unknown built-ins and foreign MCP tools pass through (policy treats them as `unknown`).
  assert.equal(toPolicyToolName('Task'), 'Task');
  assert.equal(toPolicyToolName('mcp__other__thing'), 'mcp__other__thing');
});

test('display names keep Claude built-ins and strip only the Nexus MCP prefix', () => {
  assert.equal(toDisplayToolName('Bash'), 'Bash');
  assert.equal(toDisplayToolName('mcp__nexus__question'), 'question');
  assert.equal(toDisplayToolName('mcp__other__thing'), 'mcp__other__thing');
});

test('toClaudeToolName round-trips a Nexus tool name', () => {
  assert.equal(toClaudeToolName('question'), `${NEXUS_MCP_PREFIX}question`);
  assert.equal(toDisplayToolName(toClaudeToolName('memory_recall')), 'memory_recall');
});
