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
import type { MondayItem, MondayProjectConfig } from '@nexus/shared';
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
   *
   * A leading-edge fire must also take and clear anything already pending —
   * otherwise an event that lands exactly on the boundary posts alone, out of
   * order, and strands the queue behind a newly-reset window (each such event
   * would defer the stranded batch another full window).
   */
  record(itemId: string, event: string, now: number): string[] | null {
    const last = this.lastPostAt.get(itemId);
    if (last === undefined || now - last >= this.windowMs) {
      this.lastPostAt.set(itemId, now);
      const queued = this.pending.get(itemId);
      this.pending.delete(itemId);
      return queued && queued.length > 0 ? [...queued, event] : [event];
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

/** What Nexus itself last wrote for one item+column, and the mirror snapshot
 *  (its `synced_at`) that was already stale at the moment of that write. */
interface WriteRecord {
  value: string;
  syncedAt: string;
}

/** Last value written per item+column, so an unchanged roll-up never re-writes. */
const lastWritten = new Map<string, WriteRecord>();

/** Test helper: clear the in-memory last-written cache between cases. */
export function __resetWriteState(): void {
  lastWritten.clear();
}

/** The mirror's own stored text for one column, or null if unset/unknown. */
function mirrorColumnText(item: MondayItem, columnId: string): string | null {
  try {
    const cols = JSON.parse(item.column_values_json) as Record<string, { text?: string | null } | undefined>;
    return cols[columnId]?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute and write the roll-up for one item. Returns 'skipped' when the
 * project has roll-up off or no column configured, 'unchanged' when the value
 * matches what was last written, 'written' otherwise.
 *
 * A numeric roll-up column receives the percentage; anything else receives the
 * text form. The column type was resolved when the column was configured.
 *
 * The skip decision is self-healing rather than a pure in-memory diff. Two
 * signals are available: what Nexus itself last wrote for this item+column,
 * and the mirror row's stored column text plus its `synced_at`. The mirror is
 * only refreshed periodically, so immediately after Nexus writes it still
 * holds the OLD value — comparing against it naively would rewrite on every
 * trigger (e.g. every Kanban drag), which is the trap. So: as long as the
 * mirror snapshot in hand is the SAME one that was already stale when Nexus
 * last wrote (same `synced_at`), trust Nexus's own memory of what it wrote.
 * Only once the mirror has actually refreshed to a new snapshot is its stored
 * value trusted as ground truth — which is what lets a human's edit or clear
 * (only visible after that refresh) be detected and restored.
 */
export async function writeRollup(
  db: Database.Database,
  opts: MondayClientOptions,
  cfg: MondayProjectConfig,
  itemId: string,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<'written' | 'unchanged' | 'skipped'> {
  // Optional chain deliberately: `cfg` comes from JSON parsed out of
  // projects.config_json, and there is currently no UI that writes it — a
  // hand-written partial `monday` block with no `rollup` sub-key at all is
  // real, reachable input. `.rollup.enabled` would throw on it instead of
  // degrading to "roll-up not enabled" (mirrors trigger.ts's same guard).
  if (!cfg.rollup?.enabled || !cfg.rollup?.column_id) return 'skipped';

  const item = getItem(db, itemId);
  if (!item) return 'skipped';

  const counts = computeRollup(listLinkedTaskStatuses(db, itemId));
  const value = cfg.rollup.column_type === 'numeric'
    ? String(formatRollupPercent(counts))
    : formatRollupText(counts);

  const cacheKey = `${itemId}::${cfg.rollup.column_id}`;
  const cached = lastWritten.get(cacheKey);
  const mirrorStale = cached !== undefined && cached.syncedAt === item.synced_at;
  const baseline = mirrorStale ? cached.value : mirrorColumnText(item, cfg.rollup.column_id);

  if (baseline === value) {
    lastWritten.set(cacheKey, { value, syncedAt: item.synced_at });
    return 'unchanged';
  }

  await deps.setColumn(opts, item.board_id, itemId, cfg.rollup.column_id, value);
  lastWritten.set(cacheKey, { value, syncedAt: item.synced_at });
  return 'written';
}

/** Monday update bodies are HTML: escape the five characters that could open
 *  markup or an attribute, so agent-authored text can only ever render as
 *  inert text — never as a tag, and never as a forged copy of the provenance
 *  line's own `<br><br>` formatting. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Post to an item's updates feed. `provenance` names the Nexus task and thread
 * for agent-authored updates so a human reading Monday never has to guess who
 * wrote it; pass null for Nexus's own automated notes.
 *
 * `body` is agent-authored and is HTML-escaped before use: Monday renders
 * update bodies as HTML, so raw agent text could otherwise inject markup or
 * forge its own convincing "posted by Nexus on behalf of ..." line using the
 * same formatting as the real one. The real provenance line is appended after
 * escaping, with an actual `<br><br>` line break (not `\n\n`, which does not
 * render as a break in HTML) so it never runs into the body text.
 */
export async function postItemUpdate(
  db: Database.Database,
  opts: MondayClientOptions,
  itemId: string,
  body: string,
  provenance: string | null,
  deps: RollupWriteDeps = DEFAULT_DEPS,
): Promise<void> {
  const escaped = escapeHtml(body);
  // Convert newlines to <br> so multi-line bodies render as written (after escaping,
  // so the <br> markup we insert is not itself escaped into visible text).
  const withLineBreaks = escaped.replace(/\n/g, '<br>');
  const escapedProvenance = provenance ? escapeHtml(provenance) : null;
  const full = escapedProvenance ? `${withLineBreaks}<br><br>— posted by Nexus on behalf of ${escapedProvenance}` : withLineBreaks;
  await deps.postUpdate(opts, itemId, full);
}
