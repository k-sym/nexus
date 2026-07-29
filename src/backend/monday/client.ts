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

/** A legacy plain-string error carries no `extensions.code` at all, so a
 *  deleted column reported this way would never match a configuration-error
 *  code and would retry forever instead of self-disabling. Monday's message
 *  for that specific case names the column explicitly. Deliberately narrow:
 *  only a message that says a column wasn't found is reclassified — a plain
 *  auth or rate-limit string in this same legacy shape must keep code
 *  undefined, or a transient failure could disable a working integration. */
const LEGACY_MISSING_COLUMN = /column\b.*(not found|does(?:n't| not) exist)/i;

function errorCode(e: GraphqlErrorEntry): string | undefined {
  if (typeof e === 'string') {
    return LEGACY_MISSING_COLUMN.test(e) ? 'ColumnValueException' : undefined;
  }
  return e.extensions?.code;
}

export interface RawMondayColumnValue {
  id: string;
  type?: string;
  text?: string | null;
  value?: string | null;
}

/** One entry from an item's `updates` connection — Monday's per-item comment
 *  thread. `text_body` is the plain-text rendering; the sibling `body` field
 *  is HTML, which is never what we want to store or show a model. */
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
  /** The most recent entries in the item's update thread — bounded in
   *  ITEM_FIELDS, since this selection runs against every item on a board. */
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

/**
 * Selected for every item of every page of a board sync, so each field added
 * here is multiplied by the board size against Monday's complexity budget
 * (exceeding it is the ComplexityException handled above). The updates
 * connection is capped at 5 and asks only for what the context block and the
 * read tool render — enough to show the thread's recent shape, not a mirror
 * of the whole conversation.
 */
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

export interface MondayBoardSummary {
  id: string;
  name: string;
  workspace: string | null;
}

const BOARDS_QUERY = `
  query Boards($limit: Int!) {
    boards(limit: $limit, order_by: used_at) {
      id
      name
      type
      workspace { name }
    }
  }
`;

/** Board object types that can never be a useful project scope:
 *  `sub_items_board` is Monday's auto-generated shadow board holding another
 *  board's subitems (surfaces as a "Subitems of X" pick that never resolves
 *  to real project items and burns a slot in the 200-board cap below);
 *  `document` is a Monday Doc, not an item board, at all. Anything else —
 *  including a type this list doesn't know about yet — is kept, so a future
 *  addition to BoardObjectType can never silently hide a real board. */
const EXCLUDED_BOARD_TYPES = new Set(['sub_items_board', 'document']);

/**
 * Boards the token can see, for the project-config picker. Requests Monday's
 * `type` field (`BoardObjectType`) and filters out `sub_items_board` and
 * `document` boards — confirmed against Monday's current reference docs
 * (developer.monday.com/api-reference/reference/boards) for the pinned
 * api_version ('2026-07', the "Current" version as of this writing): the
 * `Board` type documents a `type: BoardObjectType` field with enum values
 * `board`, `custom_object`, `document`, `sub_items_board`, undated and with
 * no version-gated notice, distinct from `board_kind` (public/private/share).
 * A missing `type` (e.g. an older API version, or a mocked response) is
 * treated as "keep it" rather than "exclude it" — the earlier claim that no
 * such field existed was simply wrong, but failing open here still avoids
 * hiding a real board if some future response ever omits the field.
 */
export async function fetchBoards(opts: MondayClientOptions): Promise<MondayBoardSummary[]> {
  const data = await mondayGraphql<{
    boards?: Array<{ id: string; name: string; type?: string | null; workspace?: { name?: string } | null }>;
  }>(opts, BOARDS_QUERY, { limit: 200 });
  return (data.boards ?? [])
    .filter((b) => !b.type || !EXCLUDED_BOARD_TYPES.has(b.type))
    .map((b) => ({ id: b.id, name: b.name, workspace: b.workspace?.name ?? null }));
}

export interface MondayStatusLabel {
  /** The label's numeric key in the column settings — its stable id, distinct
   *  from its display position. */
  index: number;
  text: string;
  /** Hex swatch (e.g. "#00c875") when the settings carry one, for the UI. */
  color: string | null;
}

export interface MondayBoardMeta {
  groups: Array<{ id: string; title: string }>;
  /** Status columns additionally carry their selectable `labels`; other column
   *  types omit the field. */
  columns: Array<{ id: string; title: string; type: string; labels?: MondayStatusLabel[] }>;
}

const BOARD_META_QUERY = `
  query BoardMeta($boardId: ID!) {
    boards(ids: [$boardId]) {
      groups { id title }
      columns { id title type settings_str }
    }
  }
`;

/** The fields we read out of a status column's `settings_str` (JSON). */
interface StatusColumnSettings {
  labels?: Record<string, string>;
  labels_colors?: Record<string, { color?: string } | undefined>;
  labels_positions_v2?: Record<string, number>;
  deactivated_labels?: number[];
}

/**
 * A status column's selectable labels, parsed from its `settings_str`. Monday
 * keys labels by a numeric index (a stable id, separate from the display
 * position — both live in the settings). Deactivated labels are dropped so the
 * config UI never offers a value a write would reject, and the result is
 * ordered by display position (falling back to index) to read as it does in
 * Monday. Fails open to [] on anything unparseable: a status column with no
 * readable labels degrades to an empty picker, it never throws the board-meta
 * load (same posture as the defensive parsing in map.ts).
 */
export function parseStatusLabels(settingsStr: string | null | undefined): MondayStatusLabel[] {
  if (!settingsStr) return [];
  let settings: StatusColumnSettings;
  try {
    settings = JSON.parse(settingsStr) as StatusColumnSettings;
  } catch {
    return [];
  }
  const labels = settings.labels;
  if (!labels || typeof labels !== 'object') return [];
  const deactivated = new Set((settings.deactivated_labels ?? []).map(Number));
  const positions = settings.labels_positions_v2 ?? {};
  const colors = settings.labels_colors ?? {};
  return Object.entries(labels)
    .filter(([idx, text]) => typeof text === 'string' && text.trim() !== '' && !deactivated.has(Number(idx)))
    .map(([idx, text]) => ({ index: Number(idx), text, color: colors[idx]?.color ?? null }))
    .sort((a, b) => (positions[String(a.index)] ?? a.index) - (positions[String(b.index)] ?? b.index));
}

/**
 * One board's groups and columns, for the project-config picker. `type` here
 * is Monday's own reported column type (e.g. "numbers", "status", "text") —
 * this is the one place that value is available, which is why column_type in
 * MondayProjectConfig is captured at selection time rather than re-derived
 * later from the (user-renamable) column id.
 *
 * Each status column additionally carries its selectable `labels`, parsed from
 * `settings_str` — the only source of a board's status values, needed by the
 * status-sync mapping UI.
 */
export async function fetchBoardMeta(opts: MondayClientOptions, boardId: string): Promise<MondayBoardMeta> {
  const data = await mondayGraphql<{
    boards?: Array<{
      groups?: Array<{ id: string; title: string }>;
      columns?: Array<{ id: string; title: string; type: string; settings_str?: string | null }>;
    }>;
  }>(opts, BOARD_META_QUERY, { boardId });
  const board = data.boards?.[0];
  if (!board) {
    // Same defensive shape as fetchBoardItems: no boards[] entry means the
    // token can't see this board, or it doesn't exist. Never let that look
    // like "a board with no groups or columns".
    throw new MondayError(`Monday returned no board for id ${boardId} — the board may not exist or the token cannot see it`);
  }
  return {
    groups: board.groups ?? [],
    columns: (board.columns ?? []).map((c) => (
      c.type === 'status'
        ? { id: c.id, title: c.title, type: c.type, labels: parseStatusLabels(c.settings_str) }
        : { id: c.id, title: c.title, type: c.type }
    )),
  };
}

const SET_COLUMN_MUTATION = `
  mutation SetColumn($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
    change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
  }
`;

/**
 * Write one simple column value. Used for the project's configured roll-up
 * column — see the write invariant in the spec. Status writes go through
 * setStatusColumnValue below rather than this, so each write path names the
 * kind of column it touches at its call site.
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

/**
 * Set a status column to one of its labels, by label text. Monday's
 * change_simple_column_value accepts a status label's text as the simple value
 * (an all-numeric string would be read as a label *index* instead — not a
 * concern for real word-based labels). This is the one write path that touches
 * a column a human also owns, so it is opt-in per project and guarded in
 * status-sync.ts (only-writes-mapped-labels, never-overwrite-a-hold,
 * forward-only, no-op-if-unchanged).
 */
export async function setStatusColumnValue(
  opts: MondayClientOptions,
  boardId: string,
  itemId: string,
  columnId: string,
  label: string,
): Promise<void> {
  await mondayGraphql(opts, SET_COLUMN_MUTATION, { boardId, itemId, columnId, value: label });
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
