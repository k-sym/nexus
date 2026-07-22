/** Pure Monday item → mirror row. No I/O, no clock — syncedAt is passed in. */
import type { MondayItem } from '@nexus/shared';
import type { RawMondayItem, RawMondayColumnValue, RawMondayUpdate } from './client.js';

/** The first status-type column is the item's headline status. */
function statusColumn(cols: RawMondayColumnValue[]): RawMondayColumnValue | undefined {
  return cols.find((c) => c.type === 'status');
}

/** People columns render as a comma-joined display-name list in `text`. */
function owners(cols: RawMondayColumnValue[]): string[] {
  const people = cols.find((c) => c.type === 'people');
  const text = people?.text?.trim();
  if (!text) return [];
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Status colour lives in the column's JSON value, when present. */
function statusColor(col: RawMondayColumnValue | undefined): string | null {
  if (!col?.value) return null;
  try {
    const parsed = JSON.parse(col.value) as { color?: string } | null;
    return parsed?.color ?? null;
  } catch {
    return null;
  }
}

/**
 * Normalizes the raw `updates` connection into the mirror's stored shape.
 * Purely structural — no sorting, no filtering by content — because ordering
 * is a read-time concern owned by session-deps.ts's recentUpdates(), which
 * has to tolerate rows written by any past version of this function anyway.
 * Defensive against `updates` being absent/null despite the type saying
 * otherwise: this is external API data, not something we control.
 */
function normalizedUpdates(raw: RawMondayItem): { text: string; created_at: string | null }[] {
  const list: RawMondayUpdate[] = Array.isArray(raw.updates) ? raw.updates : [];
  return list.map((u) => ({
    text: typeof u?.text_body === 'string' ? u.text_body : '',
    created_at: typeof u?.created_at === 'string' ? u.created_at : null,
  }));
}

/** 'missing' is Nexus-local (set by the sync layer when an item vanishes
 *  from Monday while a link survives) — mapItem must never produce it, so
 *  the predicate's return type excludes it rather than merely happening to
 *  never return it. */
function isKnownState(state: string | undefined): state is Exclude<MondayItem['state'], 'missing'> {
  return state === 'active' || state === 'archived' || state === 'deleted';
}

export function mapItem(raw: RawMondayItem, syncedAt: string): MondayItem {
  const cols = raw.column_values ?? [];
  const status = statusColumn(cols);
  const byId: Record<string, RawMondayColumnValue> = {};
  for (const c of cols) byId[c.id] = c;

  return {
    item_id: String(raw.id),
    board_id: raw.board?.id ? String(raw.board.id) : '',
    board_name: raw.board?.name ?? '',
    group_id: raw.group?.id ?? null,
    group_title: raw.group?.title ?? null,
    name: raw.name ?? '',
    state: isKnownState(raw.state) ? raw.state : 'active',
    status_label: status?.text?.trim() ? status.text.trim() : null,
    status_color: statusColor(status),
    owners_json: JSON.stringify(owners(cols)),
    url: raw.url ?? null,
    column_values_json: JSON.stringify(byId),
    updates_json: JSON.stringify(normalizedUpdates(raw)),
    monday_updated_at: raw.updated_at ?? null,
    synced_at: syncedAt,
  };
}
