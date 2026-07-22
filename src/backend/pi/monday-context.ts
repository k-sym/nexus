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

export function buildMondayContextBlock(
  input: MondayContextInput,
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const { item, rollupText, siblingCount, updates } = input;
  const owners = (JSON.parse(item.owners_json || '[]') as string[]).join(', ');

  const head: string[] = ['## Monday.com initiative for this task', ''];
  if (item.state === 'missing') {
    head.push('WARNING: this item is no longer present in Monday. The link survives, but the details below are the last known state.');
    head.push('');
  }
  head.push(`Initiative: ${item.name} (id ${item.item_id})`);
  head.push(`Board: ${item.board_name}${item.group_title ? ` › ${item.group_title}` : ''}`);
  if (item.status_label) head.push(`Status: ${item.status_label}`);
  if (owners) head.push(`Owners: ${owners}`);
  if (item.url) head.push(`URL: ${item.url}`);
  head.push(`Nexus tasks under this initiative: ${siblingCount} (${rollupText})`);

  // Kept out of the truncation budget's reach: without it the model has no way
  // to know the block can be refreshed.
  const tail = [
    '',
    'This is a snapshot taken when this session started, not live data. Call monday_get_item for current state.',
  ];

  const headText = head.join('\n');
  const tailText = tail.join('\n');
  const budget = maxChars - headText.length - tailText.length;

  const body: string[] = [];
  if (updates.length > 0 && budget > 20) {
    let used = 0;
    const kept: string[] = [];
    for (const update of updates) {
      const line = `- ${update}`;
      if (used + line.length + 1 > budget - 'Recent updates:'.length - 2) break;
      kept.push(line);
      used += line.length + 1;
    }
    if (kept.length > 0) body.push('', 'Recent updates:', ...kept);
  }

  const block = [headText, ...body, tailText].join('\n');
  return block.length <= maxChars ? block : `${headText}${tailText}`;
}
