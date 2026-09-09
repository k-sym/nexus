/**
 * Session-first board (#439). Cards are chat threads; lanes are derived by the
 * backend from live state (D1/D2), so there is nothing to drag. The Inbox lane
 * lists GitHub issues and Monday items with no session yet — clicking one opens
 * the OriginSessionPanel beside the board; the "+" files an idea (D14).
 */
import { useEffect, useMemo, useState } from 'react';
import { BOARD_LANES, BOARD_LANE_LABELS } from '@nexus/shared';
import type { BoardCard, BoardInboxItem, BoardLane, BoardOrigin, BoardResponse, ChatThread, MondayItemWithLinks } from '@nexus/shared';
import { MondayBadge } from './MondayBadge';
import { fetchMondayItems } from '../api';

interface KanbanBoardProps {
  board: BoardResponse | null;
  loading?: boolean;
  /** Owning project — loads the thread→Monday-item map for the card badges.
   *  A failure there never blocks the board: cards simply render without one. */
  projectId: string;
  /** `${kind}:${id}` of the Inbox row whose panel is open, so it reads as selected. */
  selectedInboxKey?: string | null;
  onOpenThread: (threadId: string) => void;
  onOpenInboxItem: (item: BoardInboxItem) => void;
  onNewIdea: () => void;
  onOpenDiffReview: (card: BoardCard) => void;
}

/** `${kind}:${id}` — the same key App uses to mark the selected Inbox row. */
export function inboxKey(item: Pick<BoardInboxItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

function relativeTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return null;
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** `provider/model-id` → `model-id`; the provider is noise on a card. */
function shortModelName(key: string): string {
  const idx = key.indexOf('/');
  return idx > 0 ? key.slice(idx + 1) : key;
}

/** The thread's last model, when the backend sends one. Optional on the wire
 *  (older threads have none), so read defensively. */
function lastModelKey(thread: ChatThread): string | null {
  const value = thread.last_model_key;
  return typeof value === 'string' && value ? value : null;
}

function originLabel(origin: BoardOrigin): string | null {
  switch (origin.kind) {
    case 'ticket': return origin.key;
    case 'github': return `#${origin.number}`;
    case 'monday': return origin.name;
    default: return null;
  }
}

function originTitle(origin: BoardOrigin): string | undefined {
  switch (origin.kind) {
    case 'ticket': return `Jira ticket ${origin.key}`;
    case 'github': return `GitHub issue #${origin.number}`;
    case 'monday': return `Monday item ${origin.name}`;
    default: return undefined;
  }
}

function InboxRow({ item, selected, onOpen }: { item: BoardInboxItem; selected: boolean; onOpen: () => void }) {
  const badge = item.kind === 'github' ? `GH #${item.id}` : 'Monday';
  const meta = item.kind === 'github' ? item.labels : item.status_label ? [item.status_label] : [];
  return (
    <button
      type="button"
      data-kanban-inbox-item
      data-inbox-key={inboxKey(item)}
      onClick={onOpen}
      aria-pressed={selected}
      title={item.title}
      className={`kanban-card w-full text-left border rounded-lg px-2.5 py-2 transition-colors ${
        selected ? 'ring-1 ring-[var(--accent)]' : ''
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-[10px] font-semibold surface-elevated text-faint px-1.5 py-0.5 rounded-sm uppercase tracking-wide">
          {badge}
        </span>
        <span className="text-xs text-primary truncate flex-1">{item.title}</span>
      </div>
      {meta.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {meta.map((label) => (
            <span key={label} className="text-[10px] text-muted surface-elevated px-1 py-0.5 rounded-sm">{label}</span>
          ))}
        </div>
      )}
    </button>
  );
}

function Card({ card, mondayItem, onOpen, onOpenDiffReview }: {
  card: BoardCard;
  mondayItem: MondayItemWithLinks | undefined;
  onOpen: () => void;
  onOpenDiffReview: () => void;
}) {
  const label = originLabel(card.origin);
  const model = lastModelKey(card.thread);
  const updated = relativeTime(card.thread.updated_at);
  const showDiff = card.lane === 'idle' || card.lane === 'running';
  const needsYou = card.lane === 'needs_you';

  return (
    <div
      data-kanban-card
      data-lane={card.lane}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title="Open session"
      className="kanban-card border rounded-lg p-3 cursor-pointer transition-colors group"
    >
      <div className="flex items-start justify-between gap-2 mb-1">
        <h3 className="text-sm font-medium leading-tight flex-1 min-w-0 break-words">{card.thread.title}</h3>
        {card.running && (
          <span
            aria-label="Running"
            title="Running"
            className="shrink-0 mt-1 inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"
          />
        )}
      </div>

      {needsYou && (
        <div className="mb-1.5 text-[11px] font-medium text-amber-400" data-needs-you>
          Needs you
          <span className="text-faint font-normal">
            {card.pending_questions > 0 ? ` · ${card.pending_questions} question${card.pending_questions === 1 ? '' : 's'}` : ''}
            {card.pending_approvals > 0 ? ` · ${card.pending_approvals} approval${card.pending_approvals === 1 ? '' : 's'}` : ''}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1 min-w-0">
          {label && (
            <span
              data-origin={card.origin.kind}
              title={originTitle(card.origin)}
              className="text-[10px] surface-elevated accent-text px-1.5 py-0.5 rounded-sm max-w-[10rem] truncate"
            >
              {label}
            </span>
          )}
          {model && (
            <span className="text-[10px] surface-elevated text-faint px-1.5 py-0.5 rounded-sm max-w-[9rem] truncate" title={model}>
              {shortModelName(model)}
            </span>
          )}
          <MondayBadge item={mondayItem} />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {updated && <span className="text-[10px] text-faint">{updated}</span>}
          {showDiff && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenDiffReview(); }}
              className="text-[10px] text-faint hover:text-[var(--text-primary)] border border-subtle rounded-sm px-1.5 py-0.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
            >
              Diff
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function KanbanBoard({ board, loading = false, projectId, selectedInboxKey, onOpenThread, onOpenInboxItem, onNewIdea, onOpenDiffReview }: KanbanBoardProps) {
  const [filter, setFilter] = useState('');

  // Loaded once per project, not per card. Keyed by thread id via `thread_ids`,
  // with the item id as a fallback for a card whose link landed after the fetch.
  const [mondayItems, setMondayItems] = useState<{ byThread: Map<string, MondayItemWithLinks>; byItem: Map<string, MondayItemWithLinks> }>(
    () => ({ byThread: new Map(), byItem: new Map() }),
  );
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchMondayItems(projectId);
        if (cancelled) return;
        const byThread = new Map<string, MondayItemWithLinks>();
        const byItem = new Map<string, MondayItemWithLinks>();
        // null = no Monday scope on this project yet: no badges, no error.
        for (const item of items ?? []) {
          byItem.set(item.item_id, item);
          for (const threadId of item.thread_ids ?? []) byThread.set(threadId, item);
        }
        setMondayItems({ byThread, byItem });
      } catch {
        if (!cancelled) setMondayItems({ byThread: new Map(), byItem: new Map() });
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const mondayItemFor = (card: BoardCard): MondayItemWithLinks | undefined => {
    if (!card.monday_item_id) return undefined;
    return mondayItems.byThread.get(card.thread.id) ?? mondayItems.byItem.get(card.monday_item_id);
  };

  const cardsByLane = useMemo(() => {
    const map = new Map<BoardLane, BoardCard[]>();
    for (const lane of BOARD_LANES) map.set(lane, []);
    for (const card of board?.cards ?? []) map.get(card.lane)?.push(card);
    return map;
  }, [board]);

  const inbox = useMemo(() => {
    const items = board?.inbox ?? [];
    const q = filter.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.title.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
  }, [board, filter]);

  const inboxErrors = board?.inbox_errors ?? {};

  return (
    <div className="flex gap-3 p-4 h-full overflow-x-auto" data-kanban-board aria-busy={loading && !board}>
      {BOARD_LANES.map((lane) => {
        const isInbox = lane === 'inbox';
        const laneCards = cardsByLane.get(lane) ?? [];
        const count = isInbox ? (board?.inbox.length ?? 0) : laneCards.length;
        const empty = isInbox ? inbox.length === 0 : laneCards.length === 0;

        return (
          <div key={lane} className="flex flex-col w-64 shrink-0" data-lane-column={lane}>
            <div className="flex items-center justify-between mb-2 px-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-faint uppercase tracking-wider">
                  {BOARD_LANE_LABELS[lane]}
                </span>
                <span className="surface-elevated text-faint text-[10px] px-1.5 py-0.5 rounded-full">
                  {count}
                </span>
              </div>
              {isInbox && (
                <button
                  type="button"
                  onClick={onNewIdea}
                  title="New idea"
                  aria-label="New idea"
                  className="text-faint hover:text-[var(--text-primary)] text-lg leading-none transition-colors"
                >
                  +
                </button>
              )}
            </div>

            <div
              data-kanban-lane
              className="flex-1 kanban-lane rounded-lg p-2 space-y-2 overflow-y-auto min-h-[100px] transition-colors"
            >
              {isInbox && (
                <>
                  <input
                    type="search"
                    aria-label="Filter inbox"
                    placeholder="Filter…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="w-full surface-panel border border-subtle rounded-sm px-2 py-1 text-xs text-primary placeholder:text-faint"
                  />
                  {inboxErrors.github && (
                    <p className="text-[10px] text-amber-400 px-1" role="status">GitHub: {inboxErrors.github}</p>
                  )}
                  {inboxErrors.monday && (
                    <p className="text-[10px] text-amber-400 px-1" role="status">Monday: {inboxErrors.monday}</p>
                  )}
                  {inbox.map((item) => (
                    <InboxRow
                      key={inboxKey(item)}
                      item={item}
                      selected={selectedInboxKey === inboxKey(item)}
                      onOpen={() => onOpenInboxItem(item)}
                    />
                  ))}
                </>
              )}

              {!isInbox && laneCards.map((card) => (
                <Card
                  key={card.thread.id}
                  card={card}
                  mondayItem={mondayItemFor(card)}
                  onOpen={() => onOpenThread(card.thread.id)}
                  onOpenDiffReview={() => onOpenDiffReview(card)}
                />
              ))}

              {empty && (
                <div className="text-center text-xs text-faint/70 py-4 border border-dashed border-[rgba(168,185,208,0.16)] rounded-lg">
                  {loading && !board ? 'Loading…' : 'Nothing here'}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
