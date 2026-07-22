/**
 * The only place Nexus writes to Monday.
 *
 * The write invariant: only the project's configured roll-up column and the
 * item's updates feed. Never the status column, never anything else a human
 * owns. Nexus and a human editing the item therefore write disjoint fields,
 * so there is no read-modify-write conflict to lose and no way for an agent
 * to silently declare an initiative done.
 *
 * Throttling is leading-edge with a trailing flush: an isolated event posts
 * at once, and everything that arrives inside the window merges into a single
 * later post. Nothing is dropped, and a quiet project never waits 30 minutes
 * to say something.
 */
import type Database from 'better-sqlite3';
import type { MondayProjectConfig } from '@nexus/shared';
import { setSimpleColumnValue, createUpdate, type MondayClientOptions } from './client.js';
import { computeRollup, formatRollupText, formatRollupPercent } from './rollup.js';
import { listLinkedTaskStatuses, getItem } from './store.js';

/** Per-item throttle with coalescing. Pure: the clock is passed in. */
export class UpdateThrottle {
  private readonly lastPostAt = new Map<string, number>();
  private readonly pending = new Map<string, string[]>();

  constructor(private readonly windowMs: number) {}

  /**
   * Record an event. Returns the events to post NOW (leading edge), or null
   * when the event was queued for the trailing flush.
   */
  record(itemId: string, event: string, now: number): string[] | null {
    const last = this.lastPostAt.get(itemId);
    if (last === undefined || now - last >= this.windowMs) {
      this.lastPostAt.set(itemId, now);
      return [event];
    }
    const queue = this.pending.get(itemId) ?? [];
    queue.push(event);
    this.pending.set(itemId, queue);
    return null;
  }

  /** Item ids whose queued events are ready to flush. */
  due(now: number): string[] {
    const out: string[] = [];
    for (const [itemId, queue] of this.pending) {
      if (queue.length === 0) continue;
      const last = this.lastPostAt.get(itemId) ?? 0;
      if (now - last >= this.windowMs) out.push(itemId);
    }
    return out;
  }

  /** Take an item's queued events and restart its window. */
  drain(itemId: string, now: number): string[] {
    const queue = this.pending.get(itemId) ?? [];
    this.pending.delete(itemId);
    if (queue.length > 0) this.lastPostAt.set(itemId, now);
    return queue;
  }
}

export interface RollupWriteDeps {
  setColumn: typeof setSimpleColumnValue;
  postUpdate: typeof createUpdate;
}

const DEFAULT_DEPS: RollupWriteDeps = { setColumn: setSimpleColumnValue, postUpdate: createUpdate };

/** Last value written per item, so an unchanged roll-up never re-writes. */
const lastWritten = new Map<string, string>();

/** Test helper: clear the in-memory last-written cache between cases. */
export function __resetWriteState(): void {
  lastWritten.clear();
}

/**
 * Compute and write the roll-up for one item. Returns 'skipped' when the
 * project has roll-up off or no column configured, 'unchanged' when the value
 * matches what was last written, 'written' otherwise.
 *
 * A numeric roll-up column receives the percentage; anything else receives the
 * text form. The column type was resolved when the column was configured.
 */
export async function writeRollup(
  db: Database.Database,
  opts: MondayClientOptions,
  cfg: MondayProjectConfig,
  itemId: string,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<'written' | 'unchanged' | 'skipped'> {
  if (!cfg.rollup.enabled || !cfg.rollup.column_id) return 'skipped';

  const item = getItem(db, itemId);
  if (!item) return 'skipped';

  const counts = computeRollup(listLinkedTaskStatuses(db, itemId));
  const value = cfg.rollup.column_type === 'numeric'
    ? String(formatRollupPercent(counts))
    : formatRollupText(counts);

  const cacheKey = `${itemId}::${cfg.rollup.column_id}`;
  if (lastWritten.get(cacheKey) === value) return 'unchanged';

  await deps.setColumn(opts, item.board_id, itemId, cfg.rollup.column_id, value);
  lastWritten.set(cacheKey, value);
  return 'written';
}

/**
 * Post to an item's updates feed. `provenance` names the Nexus task and thread
 * for agent-authored updates so a human reading Monday never has to guess who
 * wrote it; pass null for Nexus's own automated notes.
 */
export async function postItemUpdate(
  db: Database.Database,
  opts: MondayClientOptions,
  itemId: string,
  body: string,
  provenance: string | null,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<void> {
  const full = provenance ? `${body}\n\n— posted by Nexus on behalf of ${provenance}` : body;
  await deps.postUpdate(opts, itemId, full);
}
