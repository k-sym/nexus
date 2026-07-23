/**
 * The linked-item block injected into a task session's system prompt.
 *
 * This goes through systemPromptOverride rather than the transcript because
 * that hook is re-evaluated whenever a session is created OR resumed from
 * disk — so a thread reopened next week gets current item state instead of a
 * stale line frozen in message history, and the block never becomes something
 * the model re-reads on every turn.
 *
 * It is honest about staleness: the block says it is a snapshot and names the
 * tool that returns live state, rather than pretending to be current.
 */
import type { MondayItem } from '@nexus/shared';

export interface MondayContextInput {
  item: MondayItem;
  /** Pre-formatted roll-up, e.g. "1 of 5 done". */
  rollupText: string;
  /** How many Nexus tasks share this item. */
  siblingCount: number;
  updates: string[];
}

/** Roughly 400 tokens. Updates are dropped first when over budget. */
const DEFAULT_MAX_CHARS = 1600;

/** Non-active states get a prominent warning so the model never mistakes
 *  last-known state for current state. Mirrors monday-tool.ts's formatDetail. */
function stateWarning(item: MondayItem): string | null {
  if (item.state === 'missing') {
    return 'WARNING: this item is no longer present in Monday. The link survives, but the details below are the last known state.';
  }
  if (item.state === 'archived') {
    return 'WARNING: this item is archived in Monday. The details below may not reflect its final state.';
  }
  if (item.state === 'deleted') {
    return 'WARNING: this item was deleted from Monday. The link survives, but the details below are the last known state.';
  }
  return null;
}

function buildHeadText(
  item: MondayItem,
  name: string,
  owners: string,
  rollupText: string,
  siblingCount: number,
): string {
  const head: string[] = ['## Monday.com initiative for this task', ''];
  const warning = stateWarning(item);
  if (warning) {
    head.push(warning, '');
  }
  head.push(`Initiative: ${name} (id ${item.item_id})`);
  head.push(`Board: ${item.board_name}${item.group_title ? ` › ${item.group_title}` : ''}`);
  if (item.status_label) head.push(`Status: ${item.status_label}`);
  if (owners) head.push(`Owners: ${owners}`);
  if (item.url) head.push(`URL: ${item.url}`);
  head.push(`Nexus tasks under this initiative: ${siblingCount} (${rollupText})`);
  return head.join('\n');
}

export function buildMondayContextBlock(
  input: MondayContextInput,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const { item, rollupText, siblingCount, updates } = input;

  // Guard against malformed owners_json: parse defensively and degrade
  // gracefully rather than throwing (mirrors monday-tool.ts's formatDetail).
  // A valid-but-empty array renders as no Owners line at all (existing
  // behavior); malformed/non-array data renders as "unknown" so the model
  // knows the data is suspect rather than silently omitting it.
  let owners = '';
  try {
    const parsed = JSON.parse(item.owners_json || '[]');
    owners = Array.isArray(parsed) ? parsed.join(', ') : 'unknown';
  } catch {
    owners = 'unknown';
  }

  // Kept out of the truncation budget's reach: without it the model has no way
  // to know the block can be refreshed.
  const tail = [
    '',
    'This is a snapshot taken when this session started, not live data. Call monday_get_item for current state.',
  ];
  const tailText = tail.join('\n');

  let headText = buildHeadText(item, item.name, owners, rollupText, siblingCount);

  // MINOR 5: enforce the cap even when head+tail alone (no updates at all)
  // already exceed it. The item name is the only realistically unbounded
  // field, so truncate it — rather than letting the assembled block run
  // over maxChars regardless of how large the caller's data is.
  const fixedOverhead = headText.length + 1 /* separator joining head and tail */ + tailText.length;
  if (fixedOverhead > maxChars) {
    const overflow = fixedOverhead - maxChars;
    const keep = Math.max(0, item.name.length - overflow - 1 /* room for the ellipsis char */);
    const truncatedName = keep < item.name.length ? `${item.name.slice(0, keep)}…` : item.name;
    headText = buildHeadText(item, truncatedName, owners, rollupText, siblingCount);
  }

  // Truncation priority: updates are dropped first, then trimmed one at a
  // time, always measuring the REAL assembled join cost directly rather than
  // reserving a hand-computed budget — a pre-computed reservation drifted out
  // of sync with the actual `.join('\n')` cost by one character (finding 2),
  // silently dropping every update at specific sizes. Measuring the candidate
  // block directly can't drift, because it IS the cost.
  const body: string[] = [];
  if (updates.length > 0) {
    const kept: string[] = [];
    for (const update of updates) {
      const line = `- ${update}`;
      const candidateBlock = [headText, '', 'Recent updates:', ...kept, line, tailText].join('\n');
      if (candidateBlock.length > maxChars) break;
      kept.push(line);
    }
    if (kept.length > 0) body.push('', 'Recent updates:', ...kept);
  }

  // MINOR 6: join with '\n' even in the no-updates fallback, so there's a
  // blank line before the refresh hint (matching the spacing used when
  // updates are present) instead of a single newline.
  return body.length > 0
    ? [headText, ...body, tailText].join('\n')
    : [headText, tailText].join('\n');
}
