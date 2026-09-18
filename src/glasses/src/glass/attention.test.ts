import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attentionEntries, lensVerbs, itemReason, kindLabel, isNoticeItem, verbToast, needsRow, needsCounts, needsTitle, landsOnNeeds, cardVerbRows, clampListItem, LIST_ITEM_MAX_BYTES, readSource, pageLines, todoProject, messageHeader } from './attention.ts'
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
const notice = (id: string) => item({ id, kind: 'night.summary', category: 'notice', proposed_verb: 'dismiss', verbs: ['open', 'dismiss'], lens_verbs: ['dismiss'], title: 'Night summary', why: 'seen is enough' })
const pr = (id: string) => item({ id, kind: 'pr.review', title: '#212 Tighten the poll', why: 'RISKY', proposed_verb: 'open', verbs: ['open', 'close', 'snooze', 'dismiss'], lens_verbs: ['dismiss'] })

test('entries: sessions needing attention first, then open actions, then open notices (D51)', () => {
  const entries = attentionEntries([session('s2', false), session('s1', true)], [notice('n'), item({ id: 'snoozed', status: 'snoozed' }), pr('p'), item({ id: 'm' })])
  assert.deepEqual(entries.map((e) => e.id), ['s1', 'p', 'm', 'n'])
  assert.deepEqual(attentionEntries([], undefined), [])
})

test('needs rows: tier glyph, name and the reason — the hub reason, the why, or the kind when the why is empty', () => {
  const [s, p, m, n] = attentionEntries([session('s1', true)], [pr('p'), item({ id: 'm' }), notice('n')])
  assert.deepEqual(needsRow(s!), { id: 'session:s1', glyph: '★', name: 's1', meta: 'needs input', kind: 'session' })
  assert.deepEqual(needsRow(p!), { id: 'item:p', glyph: '★', name: '#212 Tighten the poll', meta: 'RISKY', kind: 'item' })
  assert.equal(needsRow(m!).meta, 'waiting 3d')
  assert.deepEqual(needsRow(n!), { id: 'item:n', glyph: '○', name: 'Night summary', meta: 'seen is enough', kind: 'item' })
  assert.equal(needsRow(attentionEntries([], [item({ id: 'e', why: '' })])[0]!).meta, 'mail waiting', 'an empty why falls back to the kind')
  const bare = { ...session('s2', true), attention: { type: 'custom', message: 'Pick a branch' } }
  assert.equal(needsRow(attentionEntries([bare], [])[0]!).meta, 'Pick a branch')
  assert.equal(needsRow(attentionEntries([{ ...session('s3', true), attention: null }], [])[0]!).meta, 'needs you')
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

test('list items are clamped to the firmware\'s 63 bytes on a code-point boundary, ending in an ellipsis', () => {
  const bytes = (t: string) => new TextEncoder().encode(t).length
  const long = '★  Item 14 — mail.waiting with a title long enough to clip at the edge   ·   why for item 14'
  assert.ok(bytes(long) > LIST_ITEM_MAX_BYTES)
  const clamped = clampListItem(long)
  assert.ok(bytes(clamped) <= LIST_ITEM_MAX_BYTES, `${bytes(clamped)} bytes`)
  assert.ok(clamped.endsWith('…'))
  assert.ok(clamped.startsWith('★  Item 14'))
  assert.equal(clampListItem('short row'), 'short row')
  // a multibyte glyph right at the boundary is dropped whole, never split
  const edge = 'x'.repeat(60) + '★★'
  assert.ok(bytes(clampListItem(edge)) <= LIST_ITEM_MAX_BYTES)
  assert.ok(!clampListItem(edge).includes('\uFFFD'))
})

// Slice 8 (D59/D62): what Read shows, how it pages, where a To-do lands.
test('read source: thread for mail, page when a vault page exists, body when non-empty, else nothing', () => {
  assert.equal(readSource(item({ id: 'm' })), 'thread')
  assert.equal(readSource(item({ id: 'p', kind: 'meeting.prep', has_page: true, body: 'pack' })), 'page')
  assert.equal(readSource(notice('n')), null)
  assert.equal(readSource({ ...notice('n'), body: 'Drained 3 tasks.' }), 'body')
  assert.equal(readSource(item({ id: 'x', kind: 'pr.review', body: '   ' })), null)
})

test('pages of seven rows; an empty text is one blank page', () => {
  const lines = Array.from({ length: 16 }, (_, i) => `l${i + 1}`)
  const pages = pageLines(lines, 7)
  assert.equal(pages.length, 3)
  assert.equal(pages[0], 'l1\nl2\nl3\nl4\nl5\nl6\nl7')
  assert.equal(pages[2], 'l15\nl16')
  assert.deepEqual(pageLines([], 7), [''])
})

test('a to-do lands on the suggested project by slug or badge, case-insensitively, else asks', () => {
  const projects = [{ id: '1', slug: 'nexus', badge: 'NEX', name: 'Nexus' }, { id: '2', slug: 'ssuk', badge: 'SSU', name: 'Safety Services UK' }]
  assert.equal(todoProject('nexus', projects)?.id, '1')
  assert.equal(todoProject('ssu', projects)?.id, '2')
  assert.equal(todoProject('NEX', projects)?.id, '1')
  assert.equal(todoProject('wisesafety', projects), null)
  assert.equal(todoProject(null, projects), null)
})

test('a message header names who and when', () => {
  const now = Date.parse('2026-09-18T12:00:00Z')
  assert.equal(messageHeader({ from: 'jane@x.com', from_name: 'Jane Holloway', date: '2026-09-17T12:00:00Z' }, now), 'From Jane Holloway · 1d ago')
  assert.equal(messageHeader({ from: 'jane@x.com' }, now), 'From jane@x.com')
  assert.equal(messageHeader({}, now), 'From someone')
})
