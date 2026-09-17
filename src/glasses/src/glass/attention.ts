// The needs-you hero's two sources (#477): sessions blocking on a human (thread-
// born, as before) and the partner's open attention items. Pure and import-free
// on purpose — `node --test` runs this file's tests directly, and the rules here
// (what the lens may offer) deserve tests that need no glasses runtime.
import type { AttentionItem, AttentionVerb, SessionSummary } from '../types'

export type AttentionEntry =
  | { kind: 'session'; id: string; session: SessionSummary }
  | { kind: 'item'; id: string; item: AttentionItem }

/** A notice wants "seen", never a decision (D19/D36). Absent category = action. */
export function isNoticeItem(item: Pick<AttentionItem, 'category'>): boolean {
  return item.category === 'notice'
}

/** Sessions needing attention first (their order is the caller's), then the
 *  partner's open actions, then its open notices (D36: an action stays in
 *  front of a digest). Anything not `open` (snoozed, resolving) never needs a
 *  glance. */
export function attentionEntries(sessions: SessionSummary[], items: AttentionItem[] | undefined): AttentionEntry[] {
  const fromSessions: AttentionEntry[] = sessions.filter((s) => s.needsAttention).map((s) => ({ kind: 'session', id: s.id, session: s }))
  const open = (items ?? []).filter((i) => i.status === 'open')
  const toEntry = (i: AttentionItem): AttentionEntry => ({ kind: 'item', id: i.id, item: i })
  return [...fromSessions, ...open.filter((i) => !isNoticeItem(i)).map(toEntry), ...open.filter(isNoticeItem).map(toEntry)]
}

/** The hero's headline: a notice is not a demand (D36). */
export function heroHeadline(entry: AttentionEntry | null | undefined): string {
  return entry?.kind === 'item' && isNoticeItem(entry.item) ? 'NOTICE' : 'NEEDS YOU'
}

/** Stable key for the current attention set. While it equals the dismissed key the
 *  interrupt stays down; any change re-raises it. An item's key carries its
 *  alert_seq so a renotify (the partner bumping it) is news again after a dismissal. */
export function attentionKey(entries: AttentionEntry[]): string {
  return entries
    .map((e) => (e.kind === 'session' ? e.id : `item:${e.id}@${e.item.alert_seq}`))
    .sort()
    .join(',')
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

const VERB_LABELS: Record<AttentionVerb, string> = { draft: 'Draft', open: 'Open', snooze: 'Snooze', dismiss: 'Dismiss' }

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** Subline for an item: its why, or the kind when the why is empty. Callers clip. */
export function itemReason(item: AttentionItem): string {
  return item.why?.trim() || kindLabel(item.kind)
}

export interface TapPlan {
  tapLabel: string
  /** null = acknowledge locally, nothing sent. */
  tapVerb: AttentionVerb | null
  doubleTapLabel: string
  doubleTapVerb: 'dismiss' | null
}

/** What the two gestures do for an entry. Sessions keep today's Review/Dismiss
 *  (dismiss = local acknowledgement). An item's tap is its first lens verb; its
 *  double-tap is `dismiss` when the lens may, else a local "Later". A notice's
 *  dismiss reads "Seen" (D36): same verb, honest name. */
export function tapPlan(entry: AttentionEntry): TapPlan {
  if (entry.kind === 'session') return { tapLabel: 'Review', tapVerb: null, doubleTapLabel: 'Dismiss', doubleTapVerb: null }
  const verbs = lensVerbs(entry.item)
  const first = verbs[0] ?? null
  const canDismiss = verbs.includes('dismiss')
  const dismissLabel = isNoticeItem(entry.item) ? 'Seen' : 'Dismiss'
  return {
    tapLabel: first ? (first === 'dismiss' ? dismissLabel : VERB_LABELS[first]) : 'Later',
    tapVerb: first,
    doubleTapLabel: canDismiss ? dismissLabel : 'Later',
    doubleTapVerb: canDismiss ? 'dismiss' : null,
  }
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
