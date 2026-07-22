/**
 * Monday.com GraphQL client.
 *
 * The trap this file exists to avoid: Monday returns HTTP 200 with an
 * `errors` array for most failures — bad token, bad board id, malformed
 * query. A client that checks res.ok reads that as success and quietly
 * mirrors nothing. That is the same shape as the Jira bug where a wrong
 * `jira.user` gave 200-and-empty instead of 401. So every response is
 * checked for `errors` before its data is trusted, and "empty result" is
 * never allowed to look like "auth rejected".
 *
 * This module reads no environment, config, or DB state — the caller
 * supplies the token via MondayClientOptions. (The poll layer is what
 * sources it from MONDAY_TOKEN.)
 */

const ENDPOINT = 'https://api.monday.com/v2';

export class MondayError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = 'MondayError';
  }

  /** Rate limit and complexity exhaustion are worth retrying; auth is not. */
  get retryable(): boolean {
    return this.status === 429 || this.code === 'ComplexityException' || (this.status ?? 0) >= 500;
  }
}

export interface MondayClientOptions {
  token: string;
  apiVersion: string;
  fetchImpl?: typeof fetch;
}

interface GraphqlErrorShape {
  message?: string;
  extensions?: { code?: string };
}

/** Monday's legacy error shape is a plain string ("Not Authenticated") rather
 *  than an object; a modern GraphQL error is an object with a `message`. */
type GraphqlErrorEntry = GraphqlErrorShape | string;

interface GraphqlEnvelope<T> {
  data?: T;
  errors?: GraphqlErrorEntry[];
  error_message?: string;
  extensions?: { complexity?: { after?: number; reset_in_x_seconds?: number } };
}

function errorMessage(e: GraphqlErrorEntry): string {
  if (typeof e === 'string') return e || 'unknown error';
  return e.message ?? 'unknown error';
}

function errorCode(e: GraphqlErrorEntry): string | undefined {
  return typeof e === 'string' ? undefined : e.extensions?.code;
}

export interface RawMondayColumnValue {
  id: string;
  type?: string;
  text?: string | null;
  value?: string | null;
}

/** One entry from an item's `updates` connection — Monday's per-item comment
 *  thread. `text_body` is the plain-text rendering (as opposed to `body`,
 *  which is HTML); we only ever want the former. */
export interface RawMondayUpdate {
  text_body?: string | null;
  created_at?: string | null;
}

export interface RawMondayItem {
  id: string;
  name?: string;
  state?: string;
  updated_at?: string | null;
  url?: string | null;
  board?: { id?: string; name?: string } | null;
  group?: { id?: string; title?: string } | null;
  column_values?: RawMondayColumnValue[];
  /** Most recent entries in the item's update thread, newest-first per
   *  Monday's own default ordering — bounded to a handful (see ITEM_FIELDS)
   *  since this query runs against every item on a board. */
  updates?: RawMondayUpdate[] | null;
}

/** Single transport entry point. Every query and mutation goes through here. */
export async function mondayGraphql<T>(
  opts: MondayClientOptions,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: opts.token,
        'API-Version': opts.apiVersion,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new MondayError(`Monday unreachable: ${(err as Error).message}`);
  }

  if (res.status === 429) {
    const raw = res.headers.get('retry-after');
    const hint = raw !== null && raw !== '' ? Number(raw) : undefined;
    throw new MondayError(
      'Monday rate limit exceeded',
      'RateLimit',
      429,
      hint !== undefined && Number.isFinite(hint) ? hint : undefined,
    );
  }

  const text = await res.text();
  let body: GraphqlEnvelope<T>;
  try {
    body = JSON.parse(text) as GraphqlEnvelope<T>;
  } catch {
    throw new MondayError(`Monday returned non-JSON (${res.status})`, undefined, res.status, undefined, text.slice(0, 300));
  }

  // The load-bearing check. Do this BEFORE looking at res.ok or body.data.
  const errors = body.errors ?? (body.error_message ? [{ message: body.error_message }] : []);
  if (errors.length > 0) {
    const code = errorCode(errors[0]!);
    const reset = body.extensions?.complexity?.reset_in_x_seconds;
    throw new MondayError(
      errors.map(errorMessage).join('; '),
      code,
      res.status,
      code === 'ComplexityException' ? reset : undefined,
      text.slice(0, 300),
    );
  }

  if (!res.ok) {
    throw new MondayError(`Monday HTTP ${res.status}`, undefined, res.status, undefined, text.slice(0, 300));
  }
  if (body.data === undefined) {
    throw new MondayError('Monday response had no data field', undefined, res.status, undefined, text.slice(0, 300));
  }
  return body.data;
}

const ITEM_FIELDS = `
  id
  name
  state
  updated_at
  url
  board { id name }
  group { id title }
  column_values { id type text value }
  updates(limit: 5) { text_body created_at }
`;

const BOARD_ITEMS_QUERY = `
  query BoardItems($boardId: ID!, $cursor: String) {
    boards(ids: [$boardId]) {
      items_page(limit: 100, cursor: $cursor) {
        cursor
        items { ${ITEM_FIELDS} }
      }
    }
  }
`;

const GROUP_ITEMS_QUERY = `
  query GroupItems($boardId: ID!, $groupId: String!, $cursor: String) {
    boards(ids: [$boardId]) {
      groups(ids: [$groupId]) {
        items_page(limit: 100, cursor: $cursor) {
          cursor
          items { ${ITEM_FIELDS} }
        }
      }
    }
  }
`;

interface ItemsPage { cursor: string | null; items: RawMondayItem[] }

/**
 * All items on a board, or on one group of it when groupId is set. Follows
 * the cursor to completion — initiative-level boards are small, and a partial
 * mirror would make the prune step delete live rows.
 */
export async function fetchBoardItems(
  opts: MondayClientOptions,
  boardId: string,
  groupId: string | null,
): Promise<RawMondayItem[]> {
  const out: RawMondayItem[] = [];
  let cursor: string | null = null;
  do {
    const page: ItemsPage | undefined = groupId
      ? (await mondayGraphql<{ boards?: { groups?: { items_page: ItemsPage }[] }[] }>(
          opts, GROUP_ITEMS_QUERY, { boardId, groupId, cursor },
        )).boards?.[0]?.groups?.[0]?.items_page
      : (await mondayGraphql<{ boards?: { items_page: ItemsPage }[] }>(
          opts, BOARD_ITEMS_QUERY, { boardId, cursor },
        )).boards?.[0]?.items_page;

    if (!page) {
      // No boards[] entry (or no matching group) means the token can't see
      // this board/group — Monday still answers 200 with no `errors`. Never
      // let that look like "the board is genuinely empty": the prune step
      // would delete every mirrored row for it.
      throw new MondayError(
        `Monday returned no items_page for board ${boardId}` +
          (groupId ? ` (group ${groupId})` : '') +
          ' — the board/group may not exist or the token cannot see it',
      );
    }
    out.push(...(page.items ?? []));
    cursor = page.cursor ?? null;
  } while (cursor);
  return out;
}

const ITEMS_BY_IDS_QUERY = `
  query ItemsByIds($ids: [ID!]!) {
    items(ids: $ids) { ${ITEM_FIELDS} }
  }
`;

/** Exactly the given items. Used by the linked-item refresh; flat in board size. */
export async function fetchItemsByIds(
  opts: MondayClientOptions,
  ids: string[],
): Promise<RawMondayItem[]> {
  if (ids.length === 0) return [];
  const data = await mondayGraphql<{ items?: RawMondayItem[] }>(opts, ITEMS_BY_IDS_QUERY, { ids });
  return data.items ?? [];
}

const SET_COLUMN_MUTATION = `
  mutation SetColumn($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
    change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
  }
`;

/**
 * Write one column. The ONLY column any caller may pass is the project's
 * configured roll-up column — see the write invariant in the spec. There is
 * deliberately no status-column helper here.
 */
export async function setSimpleColumnValue(
  opts: MondayClientOptions,
  boardId: string,
  itemId: string,
  columnId: string,
  value: string,
): Promise<void> {
  await mondayGraphql(opts, SET_COLUMN_MUTATION, { boardId, itemId, columnId, value });
}

const CREATE_UPDATE_MUTATION = `
  mutation PostUpdate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) { id }
  }
`;

/** Post to an item's updates feed. */
export async function createUpdate(
  opts: MondayClientOptions,
  itemId: string,
  body: string,
): Promise<void> {
  await mondayGraphql(opts, CREATE_UPDATE_MUTATION, { itemId, body });
}
