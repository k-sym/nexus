/**
 * The agent's window onto Monday.
 *
 * Read-biased on purpose. An agent can read the initiative a task serves and
 * look wider when it needs to, but it cannot create items, set status, or edit
 * columns — it narrates to your portfolio, it does not restructure it.
 *
 * `monday_post_update` is registered only when the project has opted in, which
 * follows the memory_recall precedent: a session never advertises a tool that
 * cannot run.
 */
import type { AgentToolResult, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { MondayItem, TaskStatus } from '@nexus/shared';

export interface MondayItemDetail {
  item: MondayItem;
  updates: string[];
  linked_tasks: { id: string; title: string; status: TaskStatus }[];
}

export interface MondayToolDeps {
  search(query: string, boardId?: string): Promise<MondayItem[]>;
  getItem(itemId: string): Promise<MondayItemDetail | null>;
  /** Present only when the project has opted in to agent-authored updates. */
  postUpdate?(itemId: string, body: string): Promise<void>;
}

const SearchSchema = Type.Object({
  query: Type.String({ description: 'Text to match against item names' }),
  board_id: Type.Optional(Type.String({
    description: "Board to search. Defaults to the project's configured board; pass this only to look outside it.",
  })),
});

const GetItemSchema = Type.Object({
  item_id: Type.String({ description: 'The Monday item id' }),
});

const PostUpdateSchema = Type.Object({
  item_id: Type.String({ description: 'The Monday item to post on' }),
  body: Type.String({ description: 'The update text, in your own words' }),
});

function formatItemLine(item: MondayItem): string {
  const status = item.status_label ? ` [${item.status_label}]` : '';
  const missing = item.state === 'missing' ? ' (no longer in Monday)' : '';
  return `- ${item.name}${status}${missing} — id ${item.item_id}${item.url ? ` — ${item.url}` : ''}`;
}

function formatDetail(detail: MondayItemDetail): string {
  const { item, updates, linked_tasks: linkedTasks } = detail;

  // Guard against malformed owners_json: parse defensively and degrade gracefully
  let owners = 'none';
  try {
    const parsed = JSON.parse(item.owners_json || '[]');
    if (Array.isArray(parsed)) {
      owners = parsed.join(', ') || 'none';
    }
  } catch {
    // Malformed JSON; render as unknown rather than throwing
    owners = 'unknown (malformed data)';
  }

  const lines: string[] = [];

  // Surface non-active state prominently at the top
  if (item.state === 'missing') {
    lines.push(
      '⚠️  This item is no longer present in Monday.com',
      'The details below are the last known state:',
      ''
    );
  } else if (item.state === 'archived') {
    lines.push(
      '⚠️  This item is archived in Monday.com',
      ''
    );
  } else if (item.state === 'deleted') {
    lines.push(
      '⚠️  This item was deleted from Monday.com',
      'The details below are the last known state:',
      ''
    );
  }

  lines.push(
    `${item.name} (id ${item.item_id})`,
    `Board: ${item.board_name}${item.group_title ? ` › ${item.group_title}` : ''}`,
    `Status: ${item.status_label ?? 'none'}`,
    `Owners: ${owners}`,
  );
  if (item.url) lines.push(`URL: ${item.url}`);
  if (linkedTasks.length > 0) {
    lines.push('', 'Linked Nexus tasks:');
    for (const task of linkedTasks) lines.push(`- ${task.title} (${task.status})`);
  }
  if (updates.length > 0) {
    lines.push('', 'Recent updates:');
    for (const update of updates) lines.push(`- ${update}`);
  }
  return lines.join('\n');
}

/** Which tools this dep set would register. Exposed for tests and diagnostics. */
export function mondayToolNames(deps: MondayToolDeps): string[] {
  const names = ['monday_search', 'monday_get_item'];
  if (deps.postUpdate) names.push('monday_post_update');
  return names;
}

export function createMondayExtension(deps: MondayToolDeps): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: 'monday_search',
      label: 'Search Monday',
      description:
        'Search Monday.com items by name. Scoped to this project\'s board by default. Use it to find the '
        + 'initiative a piece of work belongs to, or related initiatives. Skip it for searches the board '
        + 'context already answers.',
      promptSnippet: 'monday_search: find Monday.com initiatives by name',
      parameters: SearchSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string; count: number }>> {
        const query = params.query?.trim() ?? '';
        // Pi's agent loop turns a throw into an error tool result and continues
        // the turn, so throw rather than returning a pseudo-error to parse.
        if (!query) throw new Error('monday_search needs a non-empty query.');
        const items = await deps.search(query, params.board_id);
        if (items.length === 0) {
          return {
            content: [{ type: 'text', text: `No Monday items matched: ${query}` }],
            details: { status: 'empty', count: 0 },
          };
        }
        return {
          content: [{ type: 'text', text: items.map(formatItemLine).join('\n') }],
          details: { status: 'ok', count: items.length },
        };
      },
    });

    pi.registerTool({
      name: 'monday_get_item',
      label: 'Read Monday item',
      description:
        'Read a Monday.com item in full: status, owners, recent updates, and the Nexus tasks linked to it. '
        + 'Use it when the snapshot in your context may be stale, or to read an item you found via monday_search. '
        + 'Skip it for items already in context — their details are already available to you.',
      promptSnippet: 'monday_get_item: read a Monday.com initiative in full, including current status',
      parameters: GetItemSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string }>> {
        const itemId = params.item_id?.trim() ?? '';
        if (!itemId) throw new Error('monday_get_item needs a non-empty item_id.');
        const detail = await deps.getItem(itemId);
        if (!detail) {
          return {
            content: [{ type: 'text', text: `No Monday item with id ${itemId}` }],
            details: { status: 'missing' },
          };
        }
        return {
          content: [{ type: 'text', text: formatDetail(detail) }],
          details: { status: 'ok' },
        };
      },
    });

    if (!deps.postUpdate) return;

    const postUpdate = deps.postUpdate;
    pi.registerTool({
      name: 'monday_post_update',
      label: 'Post Monday update',
      description:
        'Post an update to a Monday.com item\'s update thread, reporting progress in your own words. '
        + 'Use it for meaningful milestones, not routine steps. It cannot change the item\'s status or any column.',
      promptSnippet: 'monday_post_update: report progress on a Monday.com initiative',
      parameters: PostUpdateSchema,
      async execute(_toolCallId, params): Promise<AgentToolResult<{ status: string }>> {
        const body = params.body?.trim() ?? '';
        if (!body) throw new Error('monday_post_update needs a non-empty body.');
        await postUpdate(params.item_id, body);
        return {
          content: [{ type: 'text', text: `Posted an update to Monday item ${params.item_id}.` }],
          details: { status: 'ok' },
        };
      },
    });
  };
}
