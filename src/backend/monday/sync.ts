/**
 * Two read paths, matched to two freshness needs.
 *
 * syncScope is lazy — driven by opening the Project Management view. It walks
 * the whole scoped board and reconciles the mirror against it.
 *
 * refreshLinkedItems is the background path. It asks for exactly the linked
 * item ids, so its cost is flat in board size no matter how large the board
 * grows. This is what roll-up writes read against.
 *
 * Neither swallows a client error: a failed fetch must never be reconciled as
 * "the board is empty", or an auth failure would prune the entire mirror.
 */
import type Database from 'better-sqlite3';
import {
  fetchBoardItems, fetchItemsByIds,
  type MondayClientOptions, type RawMondayItem,
} from './client.js';
import { mapItem } from './map.js';
import { upsertItems, pruneScope, listLinkedItemIds, getItem } from './store.js';

export interface MondaySyncResult {
  fetched: number;
  pruned: number;
}

type FetchBoard = (opts: MondayClientOptions, boardId: string, groupId: string | null) => Promise<RawMondayItem[]>;
type FetchByIds = (opts: MondayClientOptions, ids: string[]) => Promise<RawMondayItem[]>;

/**
 * Full sync of one project's scope. Throws on client failure — the caller
 * (route or poll) decides how to surface it. Nothing is pruned unless the
 * fetch succeeded.
 */
export async function syncScope(
  db: Database.Database,
  opts: MondayClientOptions,
  boardId: string,
  groupId: string | null,
  now: string,
  fetchImpl: FetchBoard = fetchBoardItems,
): Promise<MondaySyncResult> {
  const rawItems = await fetchImpl(opts, boardId, groupId);
  const rows = rawItems.map((raw) => mapItem(raw, now));
  upsertItems(db, rows);
  const pruned = pruneScope(db, boardId, groupId, rows.map((r) => r.item_id), now);
  return { fetched: rows.length, pruned };
}

/**
 * Refresh every linked item across all projects in one query. Returns the
 * number of items refreshed. A linked item Monday no longer returns is marked
 * 'missing' rather than dropped — the link survives.
 */
export async function refreshLinkedItems(
  db: Database.Database,
  opts: MondayClientOptions,
  now: string,
  fetchImpl: FetchByIds = fetchItemsByIds,
): Promise<number> {
  const ids = listLinkedItemIds(db);
  if (ids.length === 0) return 0;

  const rawItems = await fetchImpl(opts, ids);
  const rows = rawItems.map((raw) => mapItem(raw, now));
  upsertItems(db, rows);

  const returned = new Set(rows.map((r) => r.item_id));
  const missing = ids.filter((id) => !returned.has(id));
  const markMissing = db.prepare("UPDATE monday_items SET state = 'missing', synced_at = ? WHERE item_id = ?");
  for (const id of missing) {
    if (getItem(db, id)) markMissing.run(now, id);
  }
  return rows.length;
}
