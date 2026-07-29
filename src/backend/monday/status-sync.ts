/**
 * Opt-in status write-back: reflect where a Monday item's linked Nexus tasks
 * are in their lifecycle onto the item's status column.
 *
 * This is the one write path that touches a column a human also owns, so it is
 * off by default and hemmed in by four guardrails, all enforced in writeStatus:
 *
 *  - only-writes-mapped-labels — Nexus only ever writes a label the project's
 *    mapping assigns to a Kanban column, so the human-owned inbox label is
 *    never a target;
 *  - never-overwrite-a-hold — if a human has set the item to a label Nexus
 *    does NOT manage (e.g. "Wants attention" raised as a blocker), Nexus backs
 *    off; only the link-create handoff may advance off such a label;
 *  - forward-only (opt-out) — never regress to an earlier lifecycle stage;
 *  - no-op-if-unchanged — skip the write, and the shared board's activity-log
 *    entry, when the column already shows the target.
 *
 * The item's stage is the AGGREGATE of all its linked tasks (an item is only
 * "done" when every linked task is), reusing the same buckets as the roll-up —
 * so a 1:1 item behaves exactly as a single card's column would.
 */
import type Database from 'better-sqlite3';
import { KANBAN_COLUMNS, type MondayProjectConfig, type TaskStatus } from '@nexus/shared';
import { setStatusColumnValue, type MondayClientOptions } from './client.js';
import { computeRollup, type RollupCounts } from './rollup.js';
import { listLinkedTaskStatuses, getItem } from './store.js';
import { mirrorColumnText } from './writes.js';

/**
 * The representative Kanban column an item's aggregate progress maps to, or
 * null when it has no linked tasks (nothing to say). Mirrors the roll-up's
 * "Deploy is the only done state" rule: an item is Complete only once every
 * linked task has reached Deploy.
 */
export function deriveItemStage(counts: RollupCounts): TaskStatus | null {
  if (counts.total === 0) return null;
  if (counts.done === counts.total) return 'deploy';
  if (counts.inReview > 0) return 'review';
  if (counts.inProgress > 0) return 'in_progress';
  return 'todo'; // everything left is in the "open" bucket (triage/todo)
}

/** The mapped label for a stage. The open bucket is represented by 'todo'; if
 *  only 'triage' is mapped, use it — the two share the "open" bucket. */
function labelForStage(mapping: Partial<Record<TaskStatus, string>>, stage: TaskStatus): string | undefined {
  const direct = mapping[stage];
  if (direct && direct.trim()) return direct;
  if (stage === 'todo') {
    const triage = mapping.triage;
    if (triage && triage.trim()) return triage;
  }
  return undefined;
}

/** Distinct mapped labels ranked by lifecycle order (KANBAN_COLUMNS order).
 *  A label's rank is its first appearance; this is what forward-only compares. */
function labelRanks(mapping: Partial<Record<TaskStatus, string>>): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const col of KANBAN_COLUMNS) {
    const label = mapping[col];
    if (label && label.trim() && !ranks.has(label)) ranks.set(label, rank++);
  }
  return ranks;
}

export interface StatusWriteDeps {
  setStatus: typeof setStatusColumnValue;
}

const DEFAULT_DEPS: StatusWriteDeps = { setStatus: setStatusColumnValue };

export interface StatusWriteOptions {
  /** Link-create is the one ownership handoff allowed to advance an item off a
   *  label Nexus does not manage (its inbox default). Every other trigger
   *  leaves an unmanaged label untouched. */
  allowAdvanceFromUnmanaged: boolean;
}

const DEFAULT_WRITE_OPTIONS: StatusWriteOptions = { allowAdvanceFromUnmanaged: false };

/** What Nexus itself last wrote for one item+column, and the mirror snapshot
 *  (its `synced_at`) that was already stale at the moment of that write. */
interface StatusWriteRecord {
  label: string;
  syncedAt: string;
}

/** Last status written per item+column, so an unchanged status never re-writes
 *  even before the mirror refreshes. Same self-healing scheme as writeRollup. */
const lastWrittenStatus = new Map<string, StatusWriteRecord>();

/** Test helper: clear the in-memory last-written cache between cases. */
export function __resetStatusSyncState(): void {
  lastWrittenStatus.clear();
}

/**
 * Write one item's status from its linked tasks' aggregate stage. Returns
 * 'skipped' when status sync is off / unconfigured / the stage is unmapped /
 * held / would regress, 'unchanged' when the column already shows the target,
 * 'written' otherwise.
 *
 * The baseline (what the column shows now) uses the same self-healing trick as
 * writeRollup: immediately after a write the mirror still holds the OLD value,
 * so as long as the mirror snapshot in hand is the SAME one that was stale when
 * Nexus last wrote (same `synced_at`), trust Nexus's own memory; only once the
 * mirror has actually refreshed is its stored value trusted as ground truth —
 * which is what lets a human's edit be seen and respected.
 */
export async function writeStatus(
  db: Database.Database,
  opts: MondayClientOptions,
  cfg: MondayProjectConfig,
  itemId: string,
  deps: StatusWriteDeps = DEFAULT_DEPS,
  writeOpts: StatusWriteOptions = DEFAULT_WRITE_OPTIONS,
): Promise<'written' | 'unchanged' | 'skipped'> {
  // Optional chain deliberately: `cfg` is parsed out of projects.config_json,
  // and a hand-written `monday` block with no `status_sync` sub-key at all is
  // real, reachable input (mirrors writeRollup's guard on `rollup`).
  const sync = cfg.status_sync;
  if (!sync?.enabled || !sync.column_id) return 'skipped';

  const item = getItem(db, itemId);
  if (!item) return 'skipped';

  const stage = deriveItemStage(computeRollup(listLinkedTaskStatuses(db, itemId)));
  if (!stage) return 'skipped'; // no linked tasks → nothing to drive the status

  const targetLabel = labelForStage(sync.mapping, stage);
  if (!targetLabel) return 'skipped'; // this stage has no mapped label

  const columnId = sync.column_id;
  const cacheKey = `${itemId}::${columnId}`;
  const cached = lastWrittenStatus.get(cacheKey);
  const mirrorStale = cached !== undefined && cached.syncedAt === item.synced_at;
  const baseline = mirrorStale ? cached.label : mirrorColumnText(item, columnId);

  // No-op: the column already shows the target.
  if (baseline === targetLabel) {
    lastWrittenStatus.set(cacheKey, { label: targetLabel, syncedAt: item.synced_at });
    return 'unchanged';
  }

  const managed = new Set(
    Object.values(sync.mapping).filter((l): l is string => Boolean(l && l.trim())),
  );

  // Hold: never stomp a non-empty label Nexus does not manage — a human set it
  // (e.g. "Wants attention" as a blocker). Only the link-create handoff may
  // advance off such a label. A blank baseline is not a hold.
  const heldByHuman = Boolean(baseline && baseline.trim()) && !managed.has(baseline!);
  if (heldByHuman && !writeOpts.allowAdvanceFromUnmanaged) return 'skipped';

  // Forward-only: never regress to an earlier lifecycle stage. An unmanaged or
  // blank baseline ranks below every managed label, so advancing off it is
  // always allowed. (Equal rank means the same label, already returned above.)
  if (sync.forward_only) {
    const ranks = labelRanks(sync.mapping);
    const currentRank = baseline && ranks.has(baseline) ? ranks.get(baseline)! : -1;
    const targetRank = ranks.get(targetLabel) ?? -1;
    if (targetRank <= currentRank) return 'skipped';
  }

  await deps.setStatus(opts, item.board_id, itemId, columnId, targetLabel);
  lastWrittenStatus.set(cacheKey, { label: targetLabel, syncedAt: item.synced_at });
  return 'written';
}
