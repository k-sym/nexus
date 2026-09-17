import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, attentionKey, lensVerbs, tapPlan, itemReason, kindLabel, heroHeadline, isNoticeItem, verbToast } from './attention.ts'
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

// Slice 6c (design D32/D36): notices after actions, NOTICE + Seen on the hero,
// and `close` never a lens verb whatever the row says.
test('open actions come before open notices; sessions stay first', () => {
  const notice = item({ id: 'n', kind: 'night.summary', category: 'notice', proposed_verb: 'dismiss', verbs: ['open', 'dismiss'], lens_verbs: ['dismiss'] })
  const action = item({ id: 'a', kind: 'pr.review', verbs: ['open', 'close', 'snooze', 'dismiss'], lens_verbs: ['dismiss'] })
  const entries = attentionEntries([session('s', true)], [notice, action, item({ id: 'snoozed', status: 'snoozed', category: 'notice' })])
  assert.deepEqual(entries.map((e) => e.id), ['s', 'a', 'n'])
  assert.equal(isNoticeItem(notice), true)
  assert.equal(isNoticeItem(action), false)
  assert.equal(isNoticeItem(item({ id: 'old' })), false, 'absent category = action')
})

test('a notice hero says NOTICE and its gestures read Seen; an action stays NEEDS YOU / Dismiss', () => {
  const notice = item({ id: 'n', kind: 'brief.morning', category: 'notice', proposed_verb: 'dismiss', verbs: ['open', 'dismiss'], lens_verbs: ['dismiss'] })
  const [entry] = attentionEntries([], [notice])
  assert.equal(heroHeadline(entry), 'NOTICE')
  assert.deepEqual(tapPlan(entry!), { tapLabel: 'Seen', tapVerb: 'dismiss', doubleTapLabel: 'Seen', doubleTapVerb: 'dismiss' })
  const [action] = attentionEntries([], [item({ id: 'a', kind: 'meeting.prep', verbs: ['open', 'snooze', 'dismiss'], lens_verbs: ['dismiss'] })])
  assert.equal(heroHeadline(action), 'NEEDS YOU')
  assert.equal(tapPlan(action!).tapLabel, 'Dismiss')
  assert.equal(heroHeadline(null), 'NEEDS YOU')
  assert.equal(heroHeadline(attentionEntries([session('s', true)], [])[0]), 'NEEDS YOU')
})

test('close is never a lens verb, even when lens_verbs lists it', () => {
  const pr = item({ id: 'a', kind: 'pr.review', verbs: ['open', 'close', 'snooze', 'dismiss'], lens_verbs: ['close', 'dismiss'] })
  assert.deepEqual(lensVerbs(pr), ['dismiss'])
  assert.equal(tapPlan({ kind: 'item', id: 'a', item: pr }).tapLabel, 'Dismiss')
  assert.equal(kindLabel('pr.review'), 'PR review')
  assert.equal(kindLabel('system.alert'), 'system alert')
})

test('the toast after a notice\'s dismiss says Seen, as the gesture did', () => {
  assert.equal(verbToast('dismiss', true), 'Seen')
  assert.equal(verbToast('dismiss'), 'Dismissed')
  assert.equal(verbToast('snooze', true), 'Snoozed until tomorrow')
})
