import { useCallback, useEffect, useState } from 'react';
import { api, DraftsResponse, OutboundDraft, OutboundDraftDetail } from '../api';

// Outbound draft queue card (baker-internal#42). Unlike the routines card next
// to it, this one acts: Send here puts an email in someone's inbox.
//
// Three rules follow from that and are worth keeping:
//   1. Send is only reachable from the expanded row, after the full body has
//      been fetched and rendered. Approving a preview is not consent.
//   2. Send asks for a second click ("Confirm send") — the whole point of the
//      queue is that a person deliberately chose, and a stray tap on a phone-
//      sized card is not a decision.
//   3. Failures stay on screen until dismissed. A send that failed must never
//      look like one that worked.
//   4. Editing (baker-internal#97) and sending are mutually exclusive states:
//      while the textarea differs from what the server holds, Send does not
//      exist — the card can never send stale text it is no longer displaying.
//      Save round-trips through the adapter (which returns the draft to
//      pending and voids any approval) before Send reappears.
const POLL_MS = 60_000;

function DraftRow({ draft, onDecided }: { draft: OutboundDraft; onDecided: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<OutboundDraftDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'reject' | 'save' | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [editText, setEditText] = useState<string | null>(null); // null = not editing

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    setConfirming(false);
    if (next && !detail) {
      try {
        setDetail(await api.drafts.get(draft.id));
      } catch (err: any) {
        setError(err?.message || 'Failed to load the draft.');
      }
    }
  };

  const saveEdit = async () => {
    if (editText === null || !detail) return;
    setBusy('save');
    setError(null);
    try {
      const updated = await api.drafts.edit(draft.id, editText);
      setDetail(updated);
      setEditText(null); // back to read mode — Send is reachable again
    } catch (err: any) {
      setError(err?.message || 'Could not save the edit.');
    } finally {
      setBusy(null);
    }
  };

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(action);
    setError(null);
    try {
      const decision = action === 'approve' ? await api.drafts.approve(draft.id) : await api.drafts.reject(draft.id);
      setResult(action === 'approve' ? (decision.sent ? 'Sent.' : 'Approved.') : 'Rejected — nothing sent.');
      onDecided();
    } catch (err: any) {
      // Includes the 409 "already decided" case: say what happened rather than
      // silently refreshing the row away.
      setError(err?.message || `Could not ${action} this draft.`);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  const target = draft.reply_to ? `reply · ${draft.rationale || draft.account}` : `to ${draft.to.join(', ')}`;

  return (
    <div className="border-b border-subtle last:border-b-0">
      <button
        onClick={toggle}
        className="w-full flex items-center gap-2.5 py-1.5 text-left hover:bg-[var(--surface-hover)] transition-colors rounded-sm px-1"
        aria-label={`Draft for ${draft.account}: ${draft.subject}`}
      >
        <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0 bg-sky-400" />
        <span className="text-xs font-medium text-zinc-200 truncate">{draft.subject}</span>
        <span className="text-[11px] text-muted ml-auto shrink-0">{draft.account}</span>
      </button>
      {expanded && (
        <div className="px-1 pb-2 text-[11px] text-muted space-y-2">
          <div className="text-faint">{target}</div>
          {error && <div className="text-red-400">{error}</div>}
          {result && <div className="text-emerald-400">{result}</div>}
          {!detail && !error && <div className="text-faint">Loading the full draft…</div>}
          {detail && (
            <>
              {editText !== null ? (
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  aria-label="Edit draft body"
                  className="w-full text-[11px] leading-5 text-zinc-200 bg-[var(--surface-hover)] rounded-md p-2 max-h-64 min-h-32 font-mono"
                />
              ) : (
                <pre className="text-[11px] leading-5 text-zinc-300 bg-[var(--surface-hover)] rounded-md p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {detail.body}
                </pre>
              )}
              {detail.edited && editText === null && !result && (
                <div className="text-[10px] text-amber-400">edited — will record as approved-with-edits</div>
              )}
              {editText !== null && !result && (
                <div className="flex items-center gap-2 pt-0.5">
                  <button
                    onClick={() => void saveEdit()}
                    disabled={busy !== null || !editText.trim()}
                    className="px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11px] disabled:opacity-50"
                  >
                    {busy === 'save' ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditText(null)}
                    disabled={busy !== null}
                    className="px-2 py-1 rounded-md border border-subtle text-[11px] disabled:opacity-50"
                  >
                    Discard changes
                  </button>
                </div>
              )}
              {editText === null && !result && (
                <div className="flex items-center gap-2 pt-0.5">
                  {confirming ? (
                    <>
                      <button
                        onClick={() => void decide('approve')}
                        disabled={busy !== null}
                        className="px-2 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] disabled:opacity-50"
                      >
                        {busy === 'approve' ? 'Sending…' : 'Confirm send'}
                      </button>
                      <button
                        onClick={() => setConfirming(false)}
                        disabled={busy !== null}
                        className="px-2 py-1 rounded-md border border-subtle text-[11px] disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => setConfirming(true)}
                        className="px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white text-[11px]"
                      >
                        Send…
                      </button>
                      <button
                        onClick={() => { setConfirming(false); setEditText(detail.body); }}
                        className="px-2 py-1 rounded-md border border-subtle text-[11px]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => void decide('reject')}
                        disabled={busy !== null}
                        className="px-2 py-1 rounded-md border border-subtle text-[11px] disabled:opacity-50"
                      >
                        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default function DraftsCard() {
  const [queue, setQueue] = useState<DraftsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setQueue(await api.drafts.list('pending'));
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Failed to load drafts.');
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const drafts = queue?.drafts ?? [];

  // An empty queue is the normal state; don't take up space saying so.
  if (queue?.configured === false || (drafts.length === 0 && !loadError && !queue?.error)) return null;

  return (
    <div className="surface-glass rounded-xl border border-subtle p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] uppercase tracking-wider text-faint font-medium">Drafts awaiting you</div>
        {drafts.length > 0 && (
          <div className="text-[10px] text-sky-400">
            {drafts.length} to review
          </div>
        )}
      </div>
      {loadError && <div className="text-xs text-red-400">{loadError}</div>}
      {queue?.error && <div className="text-xs text-faint">Adapter unreachable · {queue.error}</div>}
      {drafts.map((draft) => (
        <DraftRow key={draft.id} draft={draft} onDecided={() => void load()} />
      ))}
    </div>
  );
}
