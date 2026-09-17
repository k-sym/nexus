// The Needs-you list's two sources (#477, slice 7): sessions blocking on a human
// (thread-born, as before) and the partner's open attention items. Pure and
// import-free on purpose — `node --test` runs this file's tests directly, and the
// rules here (what the lens may offer, what counts as an action, what lands the
// cockpit on the list) deserve tests that need no glasses runtime.
import type { AttentionItem, AttentionVerb, SessionSummary } from '../types'

export type AttentionEntry =
  | { kind: 'session'; id: string; session: SessionSummary }
  | { kind: 'item'; id: string; item: AttentionItem }

/** A notice wants "seen", never a decision (D19/D36). Absent category = action. */
export function isNoticeItem(item: Pick<AttentionItem, 'category'>): boolean {
  return item.category === 'notice'
}

/** Sessions needing attention first (their order is the caller's), then the
 *  partner's open actions, then its open notices (D36/D51: an action stays in
 *  front of a digest). Anything not `open` (snoozed, resolving) never needs a
 *  glance. */
export function attentionEntries(sessions: SessionSummary[], items: AttentionItem[] | undefined): AttentionEntry[] {
  const fromSessions: AttentionEntry[] = sessions.filter((s) => s.needsAttention).map((s) => ({ kind: 'session', id: s.id, session: s }))
  const open = (items ?? []).filter((i) => i.status === 'open')
  const toEntry = (i: AttentionItem): AttentionEntry => ({ kind: 'item', id: i.id, item: i })
  return [...fromSessions, ...open.filter((i) => !isNoticeItem(i)).map(toEntry), ...open.filter(isNoticeItem).map(toEntry)]
}

// Never `open` (the lens has nowhere to open to) and never `close` (an external
// GitHub write the partner refuses from the lens anyway — baker-internal D25).
const LENS_VERBS: AttentionVerb[] = ['draft', 'snooze', 'dismiss']

/** The verbs the lens may run for this item: the partner's `lens_verbs`, kept only
 *  where the item also lists them, never `open` or `close`, never a verb this
 *  client does not know. Order is the partner's. */
export function lensVerbs(item: AttentionItem): AttentionVerb[] {
  return item.lens_verbs.filter((v): v is AttentionVerb => (LENS_VERBS as string[]).includes(v) && item.verbs.includes(v))
}

export const KIND_LABELS: Record<string, string> = {
  'mail.waiting': 'mail waiting',
  'mail.urgent': 'urgent mail',
  'draft.pending': 'draft pending',
  'meeting.prep': 'meeting prep',
  'quiz.prep': 'quiz prep',
  'quiz.harvest': 'quiz harvest',
  'autonomy.proposal': 'autonomy proposal',
  'pr.review': 'PR review',
  'recon.decision': 'reconciliation decision',
  'brief.morning': 'morning brief',
  'evening.triage': 'evening triage',
  'night.summary': 'night summary',
  'recon.update': 'reconciliation update',
  'system.alert': 'system alert',
}


export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** Subline for an item: its why, or the kind when the why is empty. Callers clip. */
export function itemReason(item: AttentionItem): string {
  return item.why?.trim() || kindLabel(item.kind)
}

/** What the list shows for an entry (D51, the intent's "glyph, title, why"): a
 *  tier glyph, the name, and the reason — the hub's reason for a session, the
 *  item's why (its kind label when the why is empty). Pixel fitting is the HUD's job. */
export interface NeedsRow { id: string; glyph: string; name: string; meta: string; kind: 'session' | 'item' }
export const NEEDS_GLYPH = { action: '★', notice: '○' } as const

// Human-readable reason from the hub's attention payload on a session.
const SESSION_REASON: Record<string, string> = {
  permission_prompt: 'permission',
  idle_prompt: 'idle — waiting',
  agent_needs_input: 'needs input',
  elicitation_dialog: 'has a question',
}
export function sessionReason(s: SessionSummary): string {
  const a = s.attention
  if (!a) return 'needs you'
  return SESSION_REASON[a.type] || (a.message || 'needs you').trim()
}

export function needsRow(entry: AttentionEntry): NeedsRow {
  if (entry.kind === 'session') {
    const s = entry.session
    return { id: `session:${s.id}`, glyph: NEEDS_GLYPH.action, name: s.title || s.project || s.id.slice(0, 8), meta: sessionReason(s), kind: 'session' }
  }
  const notice = isNoticeItem(entry.item)
  return { id: `item:${entry.item.id}`, glyph: notice ? NEEDS_GLYPH.notice : NEEDS_GLYPH.action, name: entry.item.title, meta: itemReason(entry.item), kind: 'item' }
}

/** Actions = sessions needing a human + open action items; notices apart (D51). */
export function needsCounts(entries: AttentionEntry[]): { actions: number; notices: number } {
  let actions = 0, notices = 0
  for (const e of entries) {
    if (e.kind === 'item' && isNoticeItem(e.item)) notices += 1
    else actions += 1
  }
  return { actions, notices }
}

/** The list chrome's right-hand text: "2 to action · 1 to see", or "nothing needs you". */
export function needsTitle(counts: { actions: number; notices: number }): string {
  const parts: string[] = []
  if (counts.actions > 0) parts.push(`${counts.actions} to action`)
  if (counts.notices > 0) parts.push(`${counts.notices} to see`)
  return parts.length ? parts.join(' · ') : 'nothing needs you'
}

/** Whether the cockpit opens on the list (D54): only when something is actionable —
 *  a session waiting on a human or an open action item. Notices alone do not. */
export function landsOnNeeds(entries: AttentionEntry[]): boolean {
  return needsCounts(entries).actions > 0
}

const CARD_LABELS: Record<AttentionVerb, string> = { draft: 'Draft a reply', open: 'Open', snooze: 'Snooze until tomorrow', dismiss: 'Dismiss' }

/** The item card's rows (D52): the item's lens verbs, labelled; a notice's dismiss
 *  reads "Seen". Never `open` or `close` (lensVerbs already excludes them). */
export function cardVerbRows(item: AttentionItem): Array<{ verb: AttentionVerb; label: string }> {
  const notice = isNoticeItem(item)
  return lensVerbs(item).map((verb) => ({ verb, label: verb === 'dismiss' && notice ? 'Seen' : CARD_LABELS[verb] }))
}

/** One-line acknowledgement after a lens verb was sent. A notice's dismiss
 *  was offered as "Seen" (D36), so its toast says the same. */
export function verbToast(verb: AttentionVerb, notice = false): string {
  switch (verb) {
    case 'draft': return 'Drafting a reply…'
    case 'snooze': return 'Snoozed until tomorrow'
    case 'dismiss': return notice ? 'Seen' : 'Dismissed'
    case 'open': return 'Opened'
  }
}
