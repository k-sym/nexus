import { useCallback, useEffect, useRef, useState } from 'react';
import { api, AttentionItem, AttentionResponse, AttentionSnoozePreset, AttentionThreadMessage, AttentionVerb } from '../api';
import { confirmDialog } from '../lib/confirm';

// "Needs you" card (#477): the partner's attention items — what needs Keith,
// with the proposed next action and the verbs each surface may offer written
// into the record. Same shape as DraftsCard beside it: self-polling, hidden
// when empty, rows expand in place.
//
// Rules worth keeping:
//   1. The card renders exactly the verbs an item lists, and only while the
//      item is `open` or `snoozed`. The partner stores `verbs` on the item and
//      never strips them, and answers 409 in any other state — so a resolved
//      or resolving row shows its state, never a button that would fail.
//   2. Nothing here approves or sends. `open` on a draft.pending item points at
//      the Drafts card below, where the decision is minted as before.
//   3. Two verbs take time: `draft` (the partner writes a reply) and `close`
//      (the partner closes the PR behind a pr.review item with its own `gh`).
//      The partner answers 202 and the item sits `resolving` while the routine
//      runs. The row says which and polls the detail every 3 s (up to 5 min)
//      until the status moves. `close` is an external GitHub write, so the
//      desktop confirms before sending it (design D32); the lens never offers it.
//   4. Failures stay on the row until the next action. A verb the partner
//      refused must never look like one that worked.
//   5. Notices (category `notice`, slice 6b) rank after actions and want one
//      thing: "Seen" — the same `dismiss` verb under its honest name (D36).
//   6. A mail item shows the latest message of its thread (slice 6d), fetched
//      once when the row expands — never from the list poll — and shown for a
//      person to read: nothing here hands the body to a model (D42/D43). The
//      partner's refusal is a footer sentence, not an error; a backend or
//      partner without the route hides the block.
const POLL_MS = 60_000;
const SETTLE_POLL_MS = 3_000;
const SETTLE_POLL_MAX = 100;

const VERB_ORDER: AttentionVerb[] = ['draft', 'open', 'close', 'snooze', 'dismiss'];
const KNOWN_VERBS = new Set<string>(VERB_ORDER);

export const KIND_LABELS: Record<string, string> = {
  'mail.waiting': 'Mail waiting',
  'mail.urgent': 'Urgent mail',
  'draft.pending': 'Draft pending',
  'meeting.prep': 'Meeting prep',
  'quiz.prep': 'Quiz prep',
  'quiz.harvest': 'Quiz harvest',
  'autonomy.proposal': 'Autonomy proposal',
  'pr.review': 'PR review',
  'recon.decision': 'Reconciliation decision',
  'brief.morning': 'Morning brief',
  'evening.triage': 'Evening triage',
  'night.summary': 'Night summary',
  'recon.update': 'Reconciliation update',
  'system.alert': 'System alert',
};

const KIND_DOTS: Record<string, string> = {
  'mail.waiting': 'bg-sky-400',
  'mail.urgent': 'bg-orange-400',
  'draft.pending': 'bg-sky-400',
  'meeting.prep': 'bg-violet-400',
  'quiz.prep': 'bg-pink-400',
  'quiz.harvest': 'bg-pink-400',
  'autonomy.proposal': 'bg-emerald-400',
  'pr.review': 'bg-violet-400',
  'recon.decision': 'bg-amber-400',
  'brief.morning': 'bg-zinc-400',
  'evening.triage': 'bg-zinc-400',
  'night.summary': 'bg-zinc-400',
  'recon.update': 'bg-amber-300',
  'system.alert': 'bg-red-400',
};

const VERB_LABELS: Record<AttentionVerb, string> = {
  draft: 'Draft a reply',
  open: 'Open',
  close: 'Close PR',
  snooze: 'Snooze',
  dismiss: 'Dismiss',
};

const PRESETS: Array<{ id: AttentionSnoozePreset; label: string }> = [
  { id: 'later', label: 'later today' },
  { id: 'tomorrow', label: 'tomorrow' },
  { id: 'next_week', label: 'next week' },
];

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** A notice never pushes and never counts as an action (D19/D22a); absent category = action. */
export function isNotice(item: Pick<AttentionItem, 'category'>): boolean {
  return item.category === 'notice';
}

/** The one reconciliation item whose approval the skill reads back (D35):
 *  `recon.decision` keyed `recon:<statement>:cleanup`. Nothing else is approval. */
export function isCleanupApproval(item: Pick<AttentionItem, 'kind' | 'dedup_key'>): boolean {
  return item.kind === 'recon.decision' && typeof item.dedup_key === 'string' && item.dedup_key.endsWith(':cleanup');
}

/** A mail item has a conversation behind it the partner can read (6d). */
export function isMail(item: Pick<AttentionItem, 'kind'>): boolean {
  return item.kind.startsWith('mail.');
}

/** Verbs the desktop may offer right now, in the partner's canonical order. */
export function offeredVerbs(item: AttentionItem): AttentionVerb[] {
  if (item.status !== 'open' && item.status !== 'snoozed') return [];
  return VERB_ORDER.filter((v) => item.verbs.includes(v));
}

/** The slow verb an item can be running while `resolving`, by kind (D38): a
 *  pr.review can only be closing, everything else can only be drafting. */
export function slowVerbOf(item: Pick<AttentionItem, 'kind'>): 'close' | 'draft' {
  return item.kind === 'pr.review' ? 'close' : 'draft';
}

/** The label on the `open` verb, by where it goes (D33). */
export function openLabel(item: Pick<AttentionItem, 'kind' | 'links'>): string {
  if (item.links?.draft_id) return 'Review the draft';
  if (item.links?.url) return item.kind === 'pr.review' ? 'Open PR' : 'Open link';
  if (item.links?.vault_page) return item.kind.startsWith('recon.') ? 'Open Gap Report' : 'Show the page';
  return 'Open';
}

function relative(epoch: number, now = Date.now()): string {
  const diff = Math.round(epoch - now / 1000);
  const abs = Math.abs(diff);
  const unit = abs < 3600 ? [Math.max(1, Math.round(abs / 60)), 'm'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return diff < 0 ? `${unit[0]}${unit[1]} ago` : `in ${unit[0]}${unit[1]}`;
}

function draftIdOf(item: AttentionItem): string | null {
  const fromResolution = item.resolution?.result?.draft_id;
  return (typeof fromResolution === 'string' && fromResolution) || item.links?.draft_id || null;
}

function closedUrlOf(item: AttentionItem): string | null {
  const closed = item.resolution?.result?.closed;
  return typeof closed === 'string' && closed ? closed : null;
}

function lastErrorMessage(item: AttentionItem): string | null {
  const err = [...(item.events ?? [])].reverse().find((e) => e.verb === 'error');
  const r = err?.result;
  if (!r) return null;
  for (const key of ['error', 'message', 'detail']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  return null;
}

function AttentionRow({ item: listed, onChanged }: { item: AttentionItem; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [item, setItem] = useState<AttentionItem>(listed);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<AttentionVerb | 'approve' | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const [settling, setSettling] = useState(listed.status === 'resolving');
  const [settleTimedOut, setSettleTimedOut] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest message behind a mail item (6d): fetched once on expand.
  const [thread, setThread] = useState<
    { state: 'idle' } | { state: 'loading' } | { state: 'loaded'; message: AttentionThreadMessage } | { state: 'refused'; why: string } | { state: 'hidden' }
  >({ state: 'idle' });

  // The list refreshes every minute; adopt its view of the item only when it
  // is newer than what this row holds. `seq` is the partner's write counter,
  // so a list fetched before a verb landed here cannot roll the row back, and
  // a verb in flight keeps its own 3 s poll as the truth.
  useEffect(() => {
    if (settling) return;
    setItem((current) => (listed.seq > current.seq ? listed : current));
  }, [listed, settling]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const pollUntilSettled = useCallback((remaining = SETTLE_POLL_MAX) => {
    stopPolling();
    if (remaining <= 0) {
      setSettleTimedOut(true);
      setSettling(false);
      return;
    }
    pollRef.current = setTimeout(async () => {
      try {
        const fresh = await api.attention.get(item.id);
        setItem(fresh);
        if (fresh.status !== 'resolving') {
          setSettling(false);
          onChanged();
          return;
        }
      } catch {
        // A blip mid-poll is not news; try again on the next tick.
      }
      pollUntilSettled(remaining - 1);
    }, SETTLE_POLL_MS);
  }, [item.id, onChanged, stopPolling]);

  useEffect(() => {
    if (settling) pollUntilSettled();
    return stopPolling;
  }, [settling, pollUntilSettled, stopPolling]);

  const loadThread = async () => {
    setThread({ state: 'loading' });
    try {
      const t = await api.attention.thread(item.id);
      const message = t.messages?.[0];
      setThread(message?.body ? { state: 'loaded', message } : { state: 'hidden' });
    } catch (err: any) {
      const why = String(err?.message || '');
      // An older backend or partner without the route: hide (D41). A refusal
      // (not readable today) is the partner's sentence, shown as a footer.
      setThread(/not found/i.test(why) ? { state: 'hidden' } : { state: 'refused', why: why || 'The message could not be read.' });
    }
  };

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    setSnoozing(false);
    if (next && !item.events) {
      try {
        setItem(await api.attention.get(item.id));
      } catch (err: any) {
        setError(err?.message || 'Failed to load the item.');
      }
    }
    if (next && isMail(item) && thread.state === 'idle') void loadThread();
  };

  const run = async (verb: AttentionVerb, extra: { preset?: AttentionSnoozePreset; result?: Record<string, unknown> } = {}, busyAs: AttentionVerb | 'approve' = verb) => {
    setBusy(busyAs);
    setError(null);
    setNote(null);
    try {
      const updated = await api.attention.resolve(item.id, { verb, ...extra });
      setItem(updated);
      if ((verb === 'draft' || verb === 'close') && updated.status === 'resolving') {
        setSettleTimedOut(false);
        setSettling(true);
      }
      onChanged();
    } catch (err: any) {
      // Includes the 409 "item is resolved" case: say what happened rather
      // than silently refreshing the row away.
      setError(err?.message || `Could not ${verb} this item.`);
    } finally {
      setBusy(null);
      setSnoozing(false);
    }
  };

  // `close` is an external GitHub write (the partner runs `gh pr close`):
  // confirm first, send nothing on a decline (D32).
  const close = async () => {
    const where = item.links?.url ? ` (${item.links.url})` : '';
    const ok = await confirmDialog(`Close this pull request on GitHub${where}? The partner closes it with its own gh; this does not merge anything.`);
    if (!ok) return;
    await run('close');
  };

  // Approve cleanup (D35): a dismiss carrying the exact key the reconciliation
  // skill reads back. Nexus deletes nothing.
  const approveCleanup = async () => {
    const ok = await confirmDialog('Approve the cleanup? The partner deletes the files listed in this item on its next reconciliation run. Nexus deletes nothing.');
    if (!ok) return;
    await run('dismiss', { result: { approved: true } }, 'approve');
  };

  // `open` follows the item's link and records the event while the partner
  // still accepts one (it 409s on a resolved item, so that case is silent).
  // A `links.url` renders as an anchor instead (D33); this handles the rest.
  const recordOpen = async () => {
    if (item.status !== 'open' && item.status !== 'snoozed') return;
    try {
      setItem(await api.attention.resolve(item.id, { verb: 'open' }));
    } catch {
      /* recording the open is a convenience, not the action itself */
    }
  };
  const open = async () => {
    setError(null);
    if (item.links?.draft_id) {
      setNote('Review it in "Drafts awaiting you" below — approving there is what sends.');
    } else if (item.links?.vault_page) {
      setNote(`Vault page: ${item.links.vault_page}. Ask the partner for it from the Assistant view.`);
    } else if (item.links?.proposal_id) {
      setNote('Autonomy proposals are decided from the terminal (`partner autonomy`).');
    } else {
      setNote('Nothing to open for this item.');
    }
    await recordOpen();
  };

  const notice = isNotice(item);
  const verbs = offeredVerbs(item);
  const proposed = item.proposed_verb;
  const settled = item.status === 'resolved' || item.status === 'expired';
  const draftId = draftIdOf(item);
  const closedUrl = closedUrlOf(item);
  const slow = slowVerbOf(item);
  const errorMessage = !settling && item.status === 'open' && item.events?.at(-1)?.verb === 'error' ? lastErrorMessage(item) : null;
  const canApproveCleanup = isCleanupApproval(item) && verbs.includes('dismiss');
  const verbLabel = (verb: AttentionVerb) => (verb === 'dismiss' && notice ? 'Seen' : verb === 'open' ? openLabel(item) : VERB_LABELS[verb]);

  return (
    <div className="border-b border-subtle last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)] transition-colors rounded-sm px-1"
        aria-label={`${kindLabel(item.kind)}: ${item.title}`}
        aria-expanded={expanded}
      >
        <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${KIND_DOTS[item.kind] ?? 'bg-zinc-500'}`} title={kindLabel(item.kind)} />
        <span className="text-xs font-medium text-zinc-200 truncate">{item.title}</span>
        <span className="text-[11px] text-muted ml-auto shrink-0">
          {settling || item.status === 'resolving' ? (slow === 'close' ? 'closing…' : 'drafting…')
            : item.status === 'snoozed' ? 'snoozed'
            : notice ? 'notice'
            : KNOWN_VERBS.has(proposed) && verbs.includes(proposed as AttentionVerb) ? `${VERB_LABELS[proposed as AttentionVerb].split(' ')[0]}?`
            : kindLabel(item.kind)}
        </span>
      </button>
      {expanded && (
        <div className="px-1 pb-2 text-[11px] text-muted space-y-2">
          <div className="text-faint">
            {kindLabel(item.kind)} · {item.why}
            {item.producer && <> · from {item.producer}</>}
            {' · raised '}{relative(item.created_at)}
            {item.status === 'snoozed' && item.snoozed_until && <> · snoozed until {new Date(item.snoozed_until * 1000).toLocaleString()}</>}
            {item.expires_at && !settled && <> · expires {relative(item.expires_at)}</>}
          </div>
          {item.body && (
            <pre className="text-[11px] leading-5 text-zinc-300 bg-[var(--surface-hover)] rounded-md p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
              {item.body}
            </pre>
          )}
          {isMail(item) && thread.state !== 'hidden' && thread.state !== 'idle' && (
            <div data-testid="attention-thread" className="space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Latest message</div>
              {thread.state === 'loading' && <div className="text-faint">Reading the thread…</div>}
              {thread.state === 'refused' && <div className="text-faint">Not readable from here — {thread.why}</div>}
              {thread.state === 'loaded' && (
                <>
                  <div className="text-faint">
                    {thread.message.from_name ? `${thread.message.from_name} <${thread.message.from}>` : thread.message.from}
                    {thread.message.date && <> · {new Date(thread.message.date).toLocaleString()}</>}
                  </div>
                  <pre className="text-[11px] leading-5 text-zinc-300 bg-[var(--surface-hover)] rounded-md p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                    {thread.message.body}
                  </pre>
                </>
              )}
            </div>
          )}
          {error && <div className="text-red-400">{error}</div>}
          {note && <div className="text-zinc-300">{note}</div>}
          {errorMessage && (
            <div className="text-amber-400">
              {slow === 'close' ? 'Closing did not go through' : 'Drafting did not produce a reply'} — {errorMessage}
            </div>
          )}

          {(settling || item.status === 'resolving') && (
            <div className="text-zinc-300">
              {slow === 'close' ? 'Closing the PR… the partner is closing it on GitHub.' : 'Drafting… the partner is writing a reply.'}
              {settleTimedOut && <span className="text-faint"> Still running after 5 minutes; {slow === 'close' ? 'check the PR on GitHub.' : 'the draft appears in Drafts when it lands.'}</span>}
            </div>
          )}

          {settled && (
            <div className="text-zinc-300">
              {item.resolution
                ? `${item.resolution.verb === 'dismiss' && notice ? 'Seen' : VERB_LABELS[item.resolution.verb as AttentionVerb] ?? item.resolution.verb} · ${item.resolution.by} from ${item.resolution.surface} · ${relative(item.resolution.at)}`
                : item.status === 'expired' ? 'Expired without action.' : 'Resolved.'}
              {draftId && <span className="text-faint"> · the draft is in "Drafts awaiting you" below.</span>}
              {closedUrl && (
                <span className="text-faint"> · closed <a href={closedUrl} target="_blank" rel="noopener noreferrer" className="underline">{closedUrl}</a></span>
              )}
              {item.resolution?.result?.approved === true && <span className="text-faint"> · cleanup approved.</span>}
              {typeof item.resolution?.result?.filed_as === 'string' && <span className="text-faint"> · filed as a to-do.</span>}
            </div>
          )}

          {verbs.length > 0 && !settling && (
            <div className="flex items-center gap-2 pt-0.5 flex-wrap">
              {snoozing ? (
                <>
                  <span className="text-faint">Snooze until</span>
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => void run('snooze', { preset: p.id })}
                      disabled={busy !== null}
                      className="px-2 py-1 rounded-md border border-subtle text-[11px] disabled:opacity-50"
                    >
                      {busy === 'snooze' ? '…' : p.label}
                    </button>
                  ))}
                  <button onClick={() => setSnoozing(false)} disabled={busy !== null} className="px-2 py-1 rounded-md text-[11px] text-faint disabled:opacity-50">
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {verbs.map((verb) => {
                    const isProposed = verb === proposed;
                    const base = 'px-2 py-1 rounded-md text-[11px] disabled:opacity-50';
                    const style = isProposed
                      ? 'bg-sky-600 hover:bg-sky-500 text-white'
                      : verb === 'dismiss' && !notice ? 'border border-subtle text-red-300 hover:text-red-200'
                      : verb === 'close' ? 'border border-red-400/60 text-red-300 hover:text-red-200'
                      : 'border border-subtle';
                    if (verb === 'open' && item.links?.url && !item.links.draft_id) {
                      // A link opens in the browser; the event is recorded on the way out.
                      return (
                        <a
                          key={verb}
                          href={item.links.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => void recordOpen()}
                          className={`${base} ${style} inline-block`}
                        >
                          {openLabel(item)} ↗
                        </a>
                      );
                    }
                    const onClick = verb === 'snooze' ? () => setSnoozing(true)
                      : verb === 'open' ? () => void open()
                      : verb === 'close' ? () => void close()
                      : () => void run(verb);
                    return (
                      <button key={verb} onClick={onClick} disabled={busy !== null} className={`${base} ${style}`}>
                        {busy === verb ? `${verbLabel(verb)}…` : verb === 'snooze' ? 'Snooze…' : verbLabel(verb)}
                      </button>
                    );
                  })}
                  {canApproveCleanup && (
                    <button
                      onClick={() => void approveCleanup()}
                      disabled={busy !== null}
                      className="px-2 py-1 rounded-md text-[11px] disabled:opacity-50 border border-emerald-400/60 text-emerald-300 hover:text-emerald-200"
                    >
                      {busy === 'approve' ? 'Approving…' : 'Approve cleanup'}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function NeedsYouCard() {
  const [list, setList] = useState<AttentionResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [routeMissing, setRouteMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await api.attention.list('live'));
      setLoadError(null);
      setRouteMissing(false);
    } catch (err: any) {
      // An older backend without the route: absent means hidden (the intent's
      // rule), not an error card on the dashboard.
      if (/not found/i.test(err?.message || '')) {
        setRouteMissing(true);
        return;
      }
      setLoadError(err?.message || 'Failed to load attention items.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const items = list?.items ?? [];

  // An empty collection is the normal state; don't take up space saying so.
  if (routeMissing || list?.configured === false || (items.length === 0 && !loadError && !list?.error)) return null;

  // Actions first, notices after (D19/D36); counts come from the items, not
  // the partner's store-wide `open`, which cannot exclude notices.
  const actions = items.filter((i) => !isNotice(i));
  const notices = items.filter(isNotice);
  const toAction = actions.filter((i) => i.status === 'open').length;
  const counts = [toAction > 0 ? `${toAction} to action` : null, notices.length > 0 ? `${notices.length} to see` : null].filter(Boolean).join(' · ');

  return (
    <div className="surface-glass rounded-xl border border-subtle p-4" data-testid="needs-you-card">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Needs you</div>
        {counts && <div className="text-[10px] text-sky-400">{counts}</div>}
      </div>
      {loadError && <div className="text-xs text-red-400">{loadError}</div>}
      {list?.error && <div className="text-xs text-faint">Adapter unreachable · {list.error}</div>}
      {actions.map((item) => (
        <AttentionRow key={item.id} item={item} onChanged={() => void load()} />
      ))}
      {notices.length > 0 && (
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium mt-3 mb-1" data-testid="needs-you-notices">
          Notices
        </div>
      )}
      {notices.map((item) => (
        <AttentionRow key={item.id} item={item} onChanged={() => void load()} />
      ))}
    </div>
  );
}
