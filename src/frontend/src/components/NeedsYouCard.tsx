import { useCallback, useEffect, useRef, useState } from 'react';
import { api, AttentionItem, AttentionResponse, AttentionSnoozePreset, AttentionVerb } from '../api';

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
//   3. `draft` is the one verb that takes time: the partner answers 202 and the
//      item sits `resolving` while its routine runs. The row says so and polls
//      the detail every 3 s (up to 5 min) until the status moves.
//   4. Failures stay on the row until the next action. A verb the partner
//      refused must never look like one that worked.
const POLL_MS = 60_000;
const DRAFT_POLL_MS = 3_000;
const DRAFT_POLL_MAX = 100;

const VERB_ORDER: AttentionVerb[] = ['draft', 'open', 'snooze', 'dismiss'];
const KNOWN_VERBS = new Set<string>(VERB_ORDER);

export const KIND_LABELS: Record<string, string> = {
  'mail.waiting': 'Mail waiting',
  'mail.urgent': 'Urgent mail',
  'draft.pending': 'Draft pending',
  'meeting.prep': 'Meeting prep',
  'quiz.prep': 'Quiz prep',
  'quiz.harvest': 'Quiz harvest',
  'autonomy.proposal': 'Autonomy proposal',
};

const KIND_DOTS: Record<string, string> = {
  'mail.waiting': 'bg-sky-400',
  'mail.urgent': 'bg-orange-400',
  'draft.pending': 'bg-sky-400',
  'meeting.prep': 'bg-violet-400',
  'quiz.prep': 'bg-pink-400',
  'quiz.harvest': 'bg-pink-400',
  'autonomy.proposal': 'bg-emerald-400',
};

const VERB_LABELS: Record<AttentionVerb, string> = {
  draft: 'Draft a reply',
  open: 'Open',
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

/** Verbs the desktop may offer right now, in the partner's canonical order. */
export function offeredVerbs(item: AttentionItem): AttentionVerb[] {
  if (item.status !== 'open' && item.status !== 'snoozed') return [];
  return VERB_ORDER.filter((v) => item.verbs.includes(v));
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
  const [busy, setBusy] = useState<AttentionVerb | null>(null);
  const [snoozing, setSnoozing] = useState(false);
  const [drafting, setDrafting] = useState(listed.status === 'resolving');
  const [draftTimedOut, setDraftTimedOut] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The list refreshes every minute; adopt its view of the item only when it
  // is newer than what this row holds. `seq` is the partner's write counter,
  // so a list fetched before a verb landed here cannot roll the row back, and
  // a draft in flight keeps its own 3 s poll as the truth.
  useEffect(() => {
    if (drafting) return;
    setItem((current) => (listed.seq > current.seq ? listed : current));
  }, [listed, drafting]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = null;
  }, []);

  const pollUntilSettled = useCallback((remaining = DRAFT_POLL_MAX) => {
    stopPolling();
    if (remaining <= 0) {
      setDraftTimedOut(true);
      setDrafting(false);
      return;
    }
    pollRef.current = setTimeout(async () => {
      try {
        const fresh = await api.attention.get(item.id);
        setItem(fresh);
        if (fresh.status !== 'resolving') {
          setDrafting(false);
          onChanged();
          return;
        }
      } catch {
        // A blip mid-poll is not news; try again on the next tick.
      }
      pollUntilSettled(remaining - 1);
    }, DRAFT_POLL_MS);
  }, [item.id, onChanged, stopPolling]);

  useEffect(() => {
    if (drafting) pollUntilSettled();
    return stopPolling;
  }, [drafting, pollUntilSettled, stopPolling]);

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
  };

  const run = async (verb: AttentionVerb, preset?: AttentionSnoozePreset) => {
    setBusy(verb);
    setError(null);
    setNote(null);
    try {
      const updated = await api.attention.resolve(item.id, preset ? { verb, preset } : { verb });
      setItem(updated);
      if (verb === 'draft' && updated.status === 'resolving') {
        setDraftTimedOut(false);
        setDrafting(true);
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

  // `open` follows the item's link and records the event while the partner
  // still accepts one (it 409s on a resolved item, so that case is silent).
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
    if (item.status !== 'open' && item.status !== 'snoozed') return;
    try {
      setItem(await api.attention.resolve(item.id, { verb: 'open' }));
    } catch {
      /* recording the open is a convenience, not the action itself */
    }
  };

  const verbs = offeredVerbs(item);
  const proposed = item.proposed_verb;
  const settled = item.status === 'resolved' || item.status === 'expired';
  const draftId = draftIdOf(item);
  const errorMessage = !drafting && item.status === 'open' && item.events?.at(-1)?.verb === 'error' ? lastErrorMessage(item) : null;

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
          {drafting || item.status === 'resolving' ? 'drafting…'
            : item.status === 'snoozed' ? 'snoozed'
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
          {error && <div className="text-red-400">{error}</div>}
          {note && <div className="text-zinc-300">{note}</div>}
          {errorMessage && <div className="text-amber-400">Drafting did not produce a reply — {errorMessage}</div>}

          {(drafting || item.status === 'resolving') && (
            <div className="text-zinc-300">
              Drafting… the partner is writing a reply.
              {draftTimedOut && <span className="text-faint"> Still running after 5 minutes; the draft appears in Drafts when it lands.</span>}
            </div>
          )}

          {settled && (
            <div className="text-zinc-300">
              {item.resolution
                ? `${VERB_LABELS[item.resolution.verb as AttentionVerb] ?? item.resolution.verb} · ${item.resolution.by} from ${item.resolution.surface} · ${relative(item.resolution.at)}`
                : item.status === 'expired' ? 'Expired without action.' : 'Resolved.'}
              {draftId && <span className="text-faint"> · the draft is in "Drafts awaiting you" below.</span>}
            </div>
          )}

          {verbs.length > 0 && !drafting && (
            <div className="flex items-center gap-2 pt-0.5 flex-wrap">
              {snoozing ? (
                <>
                  <span className="text-faint">Snooze until</span>
                  {PRESETS.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => void run('snooze', p.id)}
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
                verbs.map((verb) => {
                  const isProposed = verb === proposed;
                  const base = 'px-2 py-1 rounded-md text-[11px] disabled:opacity-50';
                  const style = isProposed
                    ? 'bg-sky-600 hover:bg-sky-500 text-white'
                    : verb === 'dismiss' ? 'border border-subtle text-red-300 hover:text-red-200' : 'border border-subtle';
                  const onClick = verb === 'snooze' ? () => setSnoozing(true) : verb === 'open' ? () => void open() : () => void run(verb);
                  return (
                    <button key={verb} onClick={onClick} disabled={busy !== null} className={`${base} ${style}`}>
                      {busy === verb ? `${VERB_LABELS[verb]}…` : verb === 'snooze' ? 'Snooze…' : VERB_LABELS[verb]}
                    </button>
                  );
                })
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

  const openCount = list?.open ?? 0;

  return (
    <div className="surface-glass rounded-xl border border-subtle p-4" data-testid="needs-you-card">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Needs you</div>
        {openCount > 0 && (
          <div className="text-[10px] text-sky-400">
            {openCount} open
          </div>
        )}
      </div>
      {loadError && <div className="text-xs text-red-400">{loadError}</div>}
      {list?.error && <div className="text-xs text-faint">Adapter unreachable · {list.error}</div>}
      {items.map((item) => (
        <AttentionRow key={item.id} item={item} onChanged={() => void load()} />
      ))}
    </div>
  );
}
