import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineRegistry } from '../engines/registry.js';
import { PiEngine } from '../engines/pi-engine.js';
import type { ChatEngine, EngineModel, EngineSession } from '../engines/types.js';

const fakeSession = { subscribe: () => () => {}, prompt: async () => {}, abort: async () => {}, setModel: async () => {} } as unknown as EngineSession;

function engine(id: 'pi' | 'claude-code', models: EngineModel[]): ChatEngine & { dropped: string[] } {
  const dropped: string[] = [];
  return {
    id,
    dropped,
    listModels: () => models,
    findModel: (provider, modelId) => models.find((m) => m.provider === provider && m.id === modelId),
    sessionFor: async () => fakeSession,
    hasSession: () => false,
    dropSession: (threadId, cwd) => { dropped.push(`${threadId}::${cwd}`); },
  };
}

test('resolveModel picks the engine whose catalog owns the provider/id', () => {
  const pi = engine('pi', [{ provider: 'openrouter', id: 'moonshotai/kimi-k2.7-code', name: 'Kimi' }]);
  const claude = engine('claude-code', [{ provider: 'claude-code', id: 'claude-opus-5', name: 'Claude Opus 5' }]);
  const registry = new EngineRegistry([pi, claude]);

  assert.equal(registry.resolveModel('claude-code/claude-opus-5')?.engine.id, 'claude-code');
  assert.equal(registry.resolveModel('openrouter/moonshotai/kimi-k2.7-code')?.engine.id, 'pi');
  assert.equal(registry.resolveModel('openrouter/moonshotai/kimi-k2.7-code')?.model.id, 'moonshotai/kimi-k2.7-code');
  assert.equal(registry.resolveModel('nope'), undefined);
  assert.equal(registry.resolveModel('claude-code/unknown'), undefined);
});

test('listModels concatenates every engine catalog in registration order', () => {
  const pi = engine('pi', [{ provider: 'openrouter', id: 'a', name: 'A' }]);
  const claude = engine('claude-code', [{ provider: 'claude-code', id: 'b', name: 'B' }]);
  assert.deepEqual(new EngineRegistry([pi, claude]).listModels().map((m) => m.id), ['a', 'b']);
});

test('PiEngine exposes the runtime catalog with configured flags from getAvailable', () => {
  const all = [
    { provider: 'openrouter', id: 'a', name: 'A', reasoning: true },
    { provider: 'anthropic', id: 'b', name: 'B' },
  ];
  const runtime = {
    models: { getAll: () => all, getAvailable: () => [all[0]], find: (p: string, id: string) => all.find((m) => m.provider === p && m.id === id) },
    sessionFor: async () => fakeSession,
    hasSession: () => true,
    dropSession: () => {},
  };
  const pi = new PiEngine(runtime as any);
  assert.deepEqual(pi.listModels().map((m) => [m.id, m.configured]), [['a', true], ['b', false]]);
  // findModel returns the runtime's own model object: Pi's setModel needs the real Model instance.
  assert.strictEqual(pi.findModel('openrouter', 'a'), all[0]);
  assert.equal(pi.id, 'pi');
});

test('PiEngine hides models the predicate rejects from both listModels and findModel', () => {
  const all = [
    { provider: 'anthropic', id: 'claude-fable-5', name: 'Fable' },
    { provider: 'openrouter', id: 'a', name: 'A' },
  ];
  const runtime = {
    models: { getAll: () => all, getAvailable: () => all, find: (p: string, id: string) => all.find((m) => m.provider === p && m.id === id) },
    sessionFor: async () => fakeSession, hasSession: () => false, dropSession: () => {},
  };
  const pi = new PiEngine(runtime as any, { isHidden: (m) => m.provider === 'anthropic' });
  assert.deepEqual(pi.listModels().map((m) => m.id), ['a']);
  assert.equal(pi.findModel('anthropic', 'claude-fable-5'), undefined);
  assert.ok(pi.findModel('openrouter', 'a'));
});
