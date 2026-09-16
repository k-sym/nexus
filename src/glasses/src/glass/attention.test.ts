import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, attentionKey, lensVerbs, tapPlan, itemReason, kindLabel } from './attention.ts'
import type { AttentionItem, SessionSummary } from '../types.ts'

const session = (id: string, needsAttention: boolean): SessionSummary => ({
  id, title: id, cwd: '/', project: 'p', lastPrompt: '', lastAssistant: '', lastActivityAt: 0, turns: 0,
  live: true, recent: true, needsAttention, attention: needsAttention ? { type: 'agent_needs_input', message: 'x' } : null,
})

const item = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  kind: 'mail.waiting', title: 'Re: something', why: 'waiting 3d', status: 'open', proposed_verb: 'draft',
  verbs: ['draft', 'open', 'snooze', 'dismiss'], lens_verbs: ['draft', 'snooze', 'dismiss'],
  alert_seq: 4, created_at: 0, snoozed_until: null, ...over,
})

test('entries: sessions needing attention first, then open items only', () => {
  const entries = attentionEntries(
    [session('s1', true), session('s2', false)],
    [item({ id: 'a' }), item({ id: 'b', status: 'snoozed' }), item({ id: 'c', status: 'resolving' })],
  )
  assert.deepEqual(entries.map((e) => `${e.kind}:${e.id}`), ['session:s1', 'item:a'])
  assert.deepEqual(attentionEntries([], undefined), [])
})

test('key carries an item alert_seq so a renotify re-raises a dismissed hero', () => {
  const before = attentionKey(attentionEntries([session('s1', true)], [item({ id: 'a', alert_seq: 4 })]))
  const same = attentionKey(attentionEntries([session('s1', true)], [item({ id: 'a', alert_seq: 4 })]))
  const renotified = attentionKey(attentionEntries([session('s1', true)], [item({ id: 'a', alert_seq: 5 })]))
  assert.equal(before, same)
  assert.notEqual(before, renotified)
  assert.equal(before, 'item:a@4,s1')
})

test('lens verbs: the partner subset, never open, never an unknown, only where the item lists it', () => {
  assert.deepEqual(lensVerbs(item({ id: 'a' })), ['draft', 'snooze', 'dismiss'])
  assert.deepEqual(lensVerbs(item({ id: 'a', lens_verbs: ['open', 'snooze', 'teleport', 'dismiss'] })), ['snooze', 'dismiss'])
  assert.deepEqual(lensVerbs(item({ id: 'a', lens_verbs: ['draft', 'dismiss'], verbs: ['dismiss'] })), ['dismiss'])
  assert.deepEqual(lensVerbs(item({ id: 'a', lens_verbs: [] })), [])
})

test('tap plans: session = Review/Dismiss locally; item = first lens verb, dismiss when allowed, else Later', () => {
  assert.deepEqual(tapPlan({ kind: 'session', id: 's', session: session('s', true) }),
    { tapLabel: 'Review', tapVerb: null, doubleTapLabel: 'Dismiss', doubleTapVerb: null })
  assert.deepEqual(tapPlan({ kind: 'item', id: 'a', item: item({ id: 'a' }) }),
    { tapLabel: 'Draft', tapVerb: 'draft', doubleTapLabel: 'Dismiss', doubleTapVerb: 'dismiss' })
  assert.deepEqual(tapPlan({ kind: 'item', id: 'a', item: item({ id: 'a', lens_verbs: ['snooze'] }) }),
    { tapLabel: 'Snooze', tapVerb: 'snooze', doubleTapLabel: 'Later', doubleTapVerb: null })
  assert.deepEqual(tapPlan({ kind: 'item', id: 'a', item: item({ id: 'a', lens_verbs: [] }) }),
    { tapLabel: 'Later', tapVerb: null, doubleTapLabel: 'Later', doubleTapVerb: null })
})

test('reason and kind labels fall back to the raw kind for a future producer', () => {
  assert.equal(itemReason(item({ id: 'a' })), 'waiting 3d')
  assert.equal(itemReason(item({ id: 'a', why: '  ', kind: 'meeting.prep' })), 'meeting prep')
  assert.equal(kindLabel('future.kind'), 'future.kind')
})
