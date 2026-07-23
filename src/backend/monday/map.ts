/** Pure Monday item → mirror row. No I/O, no clock — syncedAt is passed in. */
import type { MondayItem } from '@nexus/shared';
import type { RawMondayItem, RawMondayColumnValue, RawMondayUpdate } from './client.js';

/** The first status-type column is the item's headline status. */
function statusColumn(cols: RawMondayColumnValue[]): RawMondayColumnValue | undefined {
  return cols.find((c) => c.type === 'status');
}

/** Monday's people-column `value` JSON, when the account/API version includes
 *  a display name per person (not guaranteed — see the comment in `owners`
 *  below). Shape: `{ personsAndTeams: [{ id, kind, name? }] }`. */
interface RawPeopleColumnValue {
  personsAndTeams?: { name?: string }[];
}

/**
 * People columns render as a comma-joined display-name list in `text` —
 * naively splitting that on "," corrupts any display name that itself
 * contains a comma (e.g. "Symmonds, Keith" reads as two owners: "Symmonds"
 * and "Keith"). There is no separator that can distinguish "a comma inside
 * one name" from "a comma between two names" once the names have already
 * been joined into one string, so splitting the text is never safe.
 *
 * Prefer the column's structured JSON `value` instead: when it carries a
 * `name` per person, those are real, individually-scoped names — no
 * splitting needed or possible to get wrong. When `value` is absent, isn't
 * parseable, or doesn't carry names (Monday's API does not always include
 * them there), fall back to the whole `text` as ONE unsplit string rather
 * than inventing owners by guessing where one name ends and the next
 * begins.
 */
function owners(cols: RawMondayColumnValue[]): string[] {
  const people = cols.find((c) => c.type === 'people');
  if (!people) return [];

  if (people.value) {
    try {
      const parsed = JSON.parse(people.value) as RawPeopleColumnValue | null;
      const named = parsed?.personsAndTeams
        ?.map((p) => p.name?.trim())
        .filter((n): n is string => Boolean(n));
      if (named && named.length > 0) return named;
    } catch {
      // Malformed JSON — fall through to the text-based fallback below.
    }
  }

  const text = people.text?.trim();
  return text ? [text] : [];
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
 * Normalizes the item's update thread into the shape the mirror stores.
 *
 * Read from `raw.updates` — the `updates` connection in client.ts's
 * ITEM_FIELDS — and never from `column_values`, which holds column values
 * keyed by column id. A board with a column whose id is literally "updates"
 * would otherwise have that column's value stored, and later shown to a
 * model, mislabelled as a comment from the item's thread.
 *
 * Structural only: no sorting and no filtering, so this stays pure and the
 * stored blob keeps whatever order Monday sent. Presentation order is a
 * read-time concern (session-deps.ts's recentUpdates), which has to cope with
 * rows written by every past version of this function regardless.
 *
 * Defensive despite the types: this is external API data, so a null, a
 * non-array, or entries of the wrong shape are all reachable and must
 * normalize rather than throw or leak `undefined` into the JSON.
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
