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
  // Weakness fix: the two assertions above would also pass if the truncation
  // logic dropped EVERY update (finding 2's failure mode) — neither checks
  // that any update actually survived. Assert that directly.
  assert.match(block, /Recent updates:/, 'at least one update must survive truncation at this size');
});

test('regression: an off-by-one in the update budget must not drop every update (finding 2)', () => {
  // maxChars=433 with this 40-update fixture is one of the sizes the reviewer
  // found where the pre-fix reservation arithmetic landed the assembled block
  // exactly one char over budget, tripping the head-only fallback and losing
  // every update even though real room existed for several.
  const many = { ...INPUT, updates: Array.from({ length: 40 }, (_, i) => `Update number ${i} with a good deal of text`) };
  const block = buildMondayContextBlock(many, 433);
  assert.ok(block.length <= 433, `block was ${block.length} chars`);
  assert.match(block, /Recent updates:/, 'updates must survive at maxChars=433');
});

test('a missing item is flagged rather than rendered as normal', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, state: 'missing' } });
  assert.match(block, /no longer present in Monday/i);
});

test('an archived item is flagged rather than rendered as normal', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, state: 'archived' } });
  assert.match(block, /archived/i);
});

test('a deleted item is flagged rather than rendered as normal', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, state: 'deleted' } });
  assert.match(block, /deleted/i);
});

test('malformed owners_json degrades to unknown instead of throwing', () => {
  assert.doesNotThrow(() => buildMondayContextBlock({ ...INPUT, item: { ...ITEM, owners_json: '{not json' } }));
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, owners_json: '{not json' } });
  assert.match(block, /Owners: unknown/);
});

test('a non-array owners_json degrades to unknown instead of throwing', () => {
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, owners_json: '{"a":1}' } });
  assert.match(block, /Owners: unknown/);
});

test('a name long enough to overflow the cap on its own is truncated so the block still fits', () => {
  const hugeName = 'X'.repeat(2000);
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, name: hugeName }, updates: [] }, 600);
  assert.ok(block.length <= 600, `block was ${block.length} chars, expected <= 600`);
  assert.match(block, /monday_get_item/, 'the refresh hint must survive even when the name must be truncated');
});

test('the head-only fallback keeps a blank line before the refresh hint', () => {
  // Same scenario as the huge-name truncation above: forces the no-updates
  // fallback path, which previously concatenated head and tail with no
  // separator (single newline instead of the blank line used elsewhere).
  const hugeName = 'X'.repeat(2000);
  const block = buildMondayContextBlock({ ...INPUT, item: { ...ITEM, name: hugeName }, updates: [] }, 600);
  assert.match(block, /\n\nThis is a snapshot/, 'a blank line must precede the refresh hint');
});

test('an item with no owners or status renders without empty fields', () => {
  const block = buildMondayContextBlock({
    ...INPUT,
    item: { ...ITEM, status_label: null, owners_json: '[]' },
  });
  assert.doesNotMatch(block, /Owners:\s*$/m);
  assert.doesNotMatch(block, /Status:\s*$/m);
});
