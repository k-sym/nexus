import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMondayContextBlock } from '../pi/monday-context';
import type { MondayItem } from '@nexus/shared';

const ITEM: MondayItem = {
  item_id: '900', board_id: 'b1', board_name: 'Portfolio', group_id: 'g1', group_title: 'Q3',
  name: 'Ship the thing', state: 'active', status_label: 'Working on it', status_color: null,
  owners_json: '["Keith Symmonds"]', url: 'https://x.monday.com/900', column_values_json: '{}',
  monday_updated_at: '2026-07-20T09:00:00Z', synced_at: '2026-07-22T10:00:00Z',
};

const INPUT = { item: ITEM, rollupText: '1 of 5 done', siblingCount: 5, updates: ['Kicked off', 'Blocked on infra'] };

test('the block names the item, status, owners, and roll-up', () => {
  const block = buildMondayContextBlock(INPUT);
  assert.match(block, /Ship the thing/);
  assert.match(block, /Working on it/);
  assert.match(block, /Keith Symmonds/);
  assert.match(block, /1 of 5 done/);
  assert.match(block, /https:\/\/x\.monday\.com\/900/);
});

test('the block states it is a snapshot and names the refresh tool', () => {
  const block = buildMondayContextBlock(INPUT);
  assert.match(block, /snapshot/i);
  assert.match(block, /monday_get_item/);
});

test('the block is capped and drops updates first', () => {
  const many = { ...INPUT, updates: Array.from({ length: 40 }, (_, i) => `Update number ${i} with a good deal of text`) };
  const block = buildMondayContextBlock(many, 600);
  assert.ok(block.length <= 600, `block was ${block.length} chars`);
  assert.match(block, /Ship the thing/, 'the headline must survive truncation');
  assert.match(block, /monday_get_item/, 'the refresh hint must survive truncation');
});

test('a missing item is flagged rather than rendered as normal', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, state: 'missing' } });
  assert.match(block, /no longer present in Monday/i);
});

test('an item with no owners or status renders without empty fields', () => {
  const block = buildMondayContextBlock({
    ...INPUT,
    item: { ...ITEM, status_label: null, owners_json: '[]' },
  });
  assert.doesNotMatch(block, /Owners:\s*$/m);
  assert.doesNotMatch(block, /Status:\s*$/m);
});
