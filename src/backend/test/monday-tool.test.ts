delete process.env.MONDAY_TOKEN;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMondayExtension, mondayToolNames } from '../pi/monday-tool';
import type { MondayItem } from '@nexus/shared';

const ITEM: MondayItem = {
  item_id: '1', board_id: 'b1', board_name: 'Portfolio', group_id: null, group_title: null,
  name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/1', column_values_json: '{}',
  monday_updated_at: null, synced_at: 'now',
};

const READ_DEPS = {
  search: async () => [ITEM],
  getItem: async () => ({ item: ITEM, updates: ['Kicked off'], linked_tasks: [{ id: 't1', title: 'A', status: 'deploy' as const }] }),
};

/** Minimal Pi stub capturing registerTool calls. */
function fakePi() {
  const tools: { name: string; description: string; promptSnippet?: string; execute: Function }[] = [];
  return { tools, registerTool: (t: any) => tools.push(t) };
}

test('read tools register when Monday is configured', () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), ['monday_get_item', 'monday_search']);
});

test('monday_post_update is omitted when the project has updates disabled', () => {
  assert.deepEqual(mondayToolNames(READ_DEPS as any).sort(), ['monday_get_item', 'monday_search']);
});

test('monday_post_update registers only when postUpdate is supplied', () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, postUpdate: async () => {} } as any)(pi as any);
  assert.deepEqual(pi.tools.map((t) => t.name).sort(), ['monday_get_item', 'monday_post_update', 'monday_search']);
});

test('every tool carries a promptSnippet', () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, postUpdate: async () => {} } as any)(pi as any);
  for (const tool of pi.tools) {
    assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0, `${tool.name} needs a promptSnippet`);
  }
});

test('monday_search returns formatted results', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const search = pi.tools.find((t) => t.name === 'monday_search')!;
  const result = await search.execute('call-1', { query: 'ship' });
  assert.match(result.content[0].text, /Ship the thing/);
  assert.equal(result.details.count, 1);
});

test('monday_search rejects an empty query', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const search = pi.tools.find((t) => t.name === 'monday_search')!;
  await assert.rejects(() => search.execute('call-1', { query: '  ' }), /non-empty/);
});

test('monday_get_item includes status, owners, updates, and linked tasks', async () => {
  const pi = fakePi();
  createMondayExtension(READ_DEPS as any)(pi as any);
  const get = pi.tools.find((t) => t.name === 'monday_get_item')!;
  const result = await get.execute('call-1', { item_id: '1' });
  const text = result.content[0].text as string;
  assert.match(text, /Working on it/);
  assert.match(text, /Keith Symmonds/);
  assert.match(text, /Kicked off/);
  assert.match(text, /A \(deploy\)/);
});

test('monday_get_item reports a missing item without throwing', async () => {
  const pi = fakePi();
  createMondayExtension({ ...READ_DEPS, getItem: async () => null } as any)(pi as any);
  const get = pi.tools.find((t) => t.name === 'monday_get_item')!;
  const result = await get.execute('call-1', { item_id: '404' });
  assert.equal(result.details.status, 'missing');
});

test('monday_post_update passes the body through to the dep', async () => {
  const pi = fakePi();
  let posted = '';
  createMondayExtension({ ...READ_DEPS, postUpdate: async (_id: string, body: string) => { posted = body; } } as any)(pi as any);
  const post = pi.tools.find((t) => t.name === 'monday_post_update')!;
  await post.execute('call-1', { item_id: '1', body: 'Done the migration' });
  assert.equal(posted, 'Done the migration');
});
