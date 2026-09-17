import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, lensVerbs, itemReason, kindLabel, isNoticeItem, verbToast, needsRow, needsCounts, needsTitle, landsOnNeeds, cardVerbRows } from './attention.ts'
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
const notice = (id: string) => item({ id, kind: 'night.summary', category: 'notice', proposed_verb: 'dismiss', verbs: ['open', 'dismiss'], lens_verbs: ['dismiss'], title: 'Night summary' })
const pr = (id: string) => item({ id, kind: 'pr.review', title: '#212 Tighten the poll', why: 'RISKY', proposed_verb: 'open', verbs: ['open', 'close', 'snooze', 'dismiss'], lens_verbs: ['dismiss'] })

test('entries: sessions needing attention first, then open actions, then open notices (D51)', () => {
  const entries = attentionEntries([session('s2', false), session('s1', true)], [notice('n'), item({ id: 'snoozed', status: 'snoozed' }), pr('p'), item({ id: 'm' })])
  assert.deepEqual(entries.map((e) => e.id), ['s1', 'p', 'm', 'n'])
  assert.deepEqual(attentionEntries([], undefined), [])
})

test('needs rows: tier glyph, name and a short meta per source', () => {
  const [s, p, m, n] = attentionEntries([session('s1', true)], [pr('p'), item({ id: 'm' }), notice('n')])
  assert.deepEqual(needsRow(s!), { id: 'session:s1', glyph: '★', name: 's1', meta: 'needs you', kind: 'session' })
  assert.deepEqual(needsRow(p!), { id: 'item:p', glyph: '★', name: '#212 Tighten the poll', meta: 'PR review', kind: 'item' })
  assert.equal(needsRow(m!).meta, 'mail waiting')
  assert.deepEqual(needsRow(n!), { id: 'item:n', glyph: '○', name: 'Night summary', meta: 'notice', kind: 'item' })
})

test('counts and title: sessions count as actions, notices apart; the landing rule follows the actions', () => {
  const both = attentionEntries([session('s1', true)], [pr('p'), notice('n')])
  assert.deepEqual(needsCounts(both), { actions: 2, notices: 1 })
  assert.equal(needsTitle(needsCounts(both)), '2 to action · 1 to see')
  assert.equal(needsTitle(needsCounts([])), 'nothing needs you')
  assert.equal(needsTitle({ actions: 0, notices: 3 }), '3 to see')
  assert.equal(landsOnNeeds(both), true)
  assert.equal(landsOnNeeds(attentionEntries([session('s1', true)], [])), true, 'a session waiting on a human lands')
  assert.equal(landsOnNeeds(attentionEntries([], [notice('n')])), false, 'a notice alone does not land (D54)')
  assert.equal(landsOnNeeds([]), false)
})

test('card rows: the lens verbs, labelled; Seen on a notice; never open or close', () => {
  assert.deepEqual(cardVerbRows(item({ id: 'm' })), [
    { verb: 'draft', label: 'Draft a reply' }, { verb: 'snooze', label: 'Snooze until tomorrow' }, { verb: 'dismiss', label: 'Dismiss' },
  ])
  assert.deepEqual(cardVerbRows(notice('n')), [{ verb: 'dismiss', label: 'Seen' }])
  assert.deepEqual(cardVerbRows(item({ id: 'x', kind: 'pr.review', verbs: ['open', 'close', 'snooze', 'dismiss'], lens_verbs: ['open', 'close', 'dismiss'] })), [{ verb: 'dismiss', label: 'Dismiss' }])
  assert.deepEqual(cardVerbRows(item({ id: 'y', lens_verbs: ['teleport'] })), [])
})

test('lens verbs: the partner subset, never open, never an unknown, only where the item lists it', () => {
  assert.deepEqual(lensVerbs(item({ id: 'a' })), ['draft', 'snooze', 'dismiss'])
  assert.deepEqual(lensVerbs(item({ id: 'b', lens_verbs: ['open', 'draft', 'teleport', 'dismiss'], verbs: ['open', 'draft'] })), ['draft'])
  assert.equal(isNoticeItem(notice('n')), true)
  assert.equal(isNoticeItem(item({ id: 'old' })), false, 'absent category = action')
})

test('reason, kind labels and toasts', () => {
  assert.equal(itemReason(item({ id: 'a', why: '' })), 'mail waiting')
  assert.equal(kindLabel('pr.review'), 'PR review')
  assert.equal(kindLabel('future.kind'), 'future.kind')
  assert.equal(verbToast('dismiss', true), 'Seen')
  assert.equal(verbToast('dismiss'), 'Dismissed')
  assert.equal(verbToast('draft'), 'Drafting a reply…')
})
