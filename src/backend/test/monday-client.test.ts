import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mondayGraphql,
  fetchItemsByIds,
  fetchBoardItems,
  fetchBoards,
  fetchBoardMeta,
  setSimpleColumnValue,
  createUpdate,
  MondayError,
} from '../monday/client';
import { mapItem } from '../monday/map';

const OPTS = { token: 'tok', apiVersion: '2026-07' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('mondayGraphql sends the token and pinned API version', async () => {
  let seen: RequestInit | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    seen = init;
    return jsonResponse({ data: { ok: true } });
  };
  await mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {});
  const headers = seen!.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'tok');
  assert.equal(headers['API-Version'], '2026-07');
});

test('200 with an errors array is a failure, not an empty result', async () => {
  const fakeFetch = async () => jsonResponse({
    errors: [{ message: 'Not Authenticated', extensions: { code: 'UserUnauthorizedException' } }],
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'UserUnauthorizedException');
      assert.match(err.message, /Not Authenticated/);
      return true;
    },
  );
});

test('an empty result is NOT reported as an error', async () => {
  const fakeFetch = async () => jsonResponse({ data: { items: [] } });
  const items = await fetchItemsByIds({ ...OPTS, fetchImpl: fakeFetch as any }, ['1']);
  assert.deepEqual(items, []);
});

test('429 carries the reset hint', async () => {
  const fakeFetch = async () => new Response('rate limited', {
    status: 429,
    headers: { 'retry-after': '17' },
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 17);
      return true;
    },
  );
});

test('429 with no Retry-After header leaves retryAfterSeconds undefined, not 0', async () => {
  const fakeFetch = async () => new Response('rate limited', { status: 429 });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.status, 429);
      // A caller doing `retryAfterSeconds ?? DEFAULT_BACKOFF` must still get
      // the default here — `0` would hot-loop against the rate limit.
      assert.equal(err.retryAfterSeconds, undefined);
      return true;
    },
  );
});

test('a legacy string-array errors shape preserves the real message', async () => {
  const fakeFetch = async () => jsonResponse({ errors: ['Not Authenticated'] });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.message, 'Not Authenticated');
      assert.equal(err.code, undefined);
      return true;
    },
  );
});

test('a legacy string-array error naming a missing column is classified as a configuration error', async () => {
  const fakeFetch = async () => jsonResponse({ errors: ['Column "text_1" not found on board'] });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'ColumnValueException');
      assert.match(err.message, /not found/);
      return true;
    },
  );
});

test('a legacy string-array error unrelated to a missing column stays unclassified (must not disable a working integration)', async () => {
  const fakeFetch = async () => jsonResponse({ errors: ['Rate limit exceeded, try again later'] });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, undefined);
      return true;
    },
  );
});

test('complexity exhaustion is surfaced as a retryable error', async () => {
  const fakeFetch = async () => jsonResponse({
    errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'ComplexityException' } }],
    extensions: { complexity: { after: 0, reset_in_x_seconds: 42 } },
  });
  await assert.rejects(
    () => mondayGraphql({ ...OPTS, fetchImpl: fakeFetch as any }, 'query { ok }', {}),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'ComplexityException');
      assert.equal(err.retryAfterSeconds, 42);
      return true;
    },
  );
});

test('fetchItemsByIds returns the raw items', async () => {
  const fakeFetch = async () => jsonResponse({
    data: { items: [{ id: '1', name: 'Initiative A', state: 'active' }] },
  });
  const items = await fetchItemsByIds({ ...OPTS, fetchImpl: fakeFetch as any }, ['1']);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Initiative A');
});

test('fetchBoardItems accumulates items across a paginated cursor', async () => {
  let call = 0;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    call += 1;
    const parsed = JSON.parse(init!.body as string);
    if (call === 1) {
      assert.equal(parsed.variables.cursor, null);
      return jsonResponse({
        data: { boards: [{ items_page: { cursor: 'page-2', items: [{ id: '1' }] } }] },
      });
    }
    assert.equal(call, 2);
    assert.equal(parsed.variables.cursor, 'page-2');
    return jsonResponse({
      data: { boards: [{ items_page: { cursor: null, items: [{ id: '2' }] } }] },
    });
  };
  const items = await fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1', null);
  assert.deepEqual(items.map((i) => i.id), ['1', '2']);
  assert.equal(call, 2);
});

test('fetchBoardItems terminates normally in one fetch when the cursor is exhausted', async () => {
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    return jsonResponse({
      data: { boards: [{ items_page: { cursor: null, items: [{ id: 'only' }] } }] },
    });
  };
  const items = await fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1', null);
  assert.deepEqual(items.map((i) => i.id), ['only']);
  assert.equal(call, 1);
});

test('fetchBoardItems reads boards[0].items_page when no groupId is given', async () => {
  // Response deliberately carries both shapes so the test fails if the
  // implementation reads the wrong one for a board-scoped call.
  const fakeFetch = async () => jsonResponse({
    data: {
      boards: [{
        items_page: { cursor: null, items: [{ id: 'board-path' }] },
        groups: [{ items_page: { cursor: null, items: [{ id: 'group-path' }] } }],
      }],
    },
  });
  const items = await fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1', null);
  assert.deepEqual(items.map((i) => i.id), ['board-path']);
});

test('fetchBoardItems reads boards[0].groups[0].items_page when groupId is given', async () => {
  const fakeFetch = async () => jsonResponse({
    data: {
      boards: [{
        items_page: { cursor: null, items: [{ id: 'board-path' }] },
        groups: [{ items_page: { cursor: null, items: [{ id: 'group-path' }] } }],
      }],
    },
  });
  const items = await fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1', 'group-1');
  assert.deepEqual(items.map((i) => i.id), ['group-path']);
});

test('fetchBoardItems propagates a mid-pagination error instead of returning a partial array', async () => {
  let call = 0;
  const fakeFetch = async () => {
    call += 1;
    if (call === 1) {
      return jsonResponse({
        data: { boards: [{ items_page: { cursor: 'page-2', items: [{ id: '1' }] } }] },
      });
    }
    return jsonResponse({ errors: [{ message: 'boom' }] });
  };
  await assert.rejects(
    () => fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1', null),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.match(err.message, /boom/);
      return true;
    },
  );
  assert.equal(call, 2);
});

test('fetchBoardItems throws instead of returning [] when boards[] comes back empty', async () => {
  const fakeFetch = async () => jsonResponse({ data: { boards: [] } });
  await assert.rejects(
    () => fetchBoardItems({ ...OPTS, fetchImpl: fakeFetch as any }, 'ghost-board', null),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.match(err.message, /ghost-board/);
      return true;
    },
  );
});

test('setSimpleColumnValue sends the exact GraphQL variables', async () => {
  let seenVariables: unknown;
  let seenQuery: string | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(init!.body as string);
    seenVariables = parsed.variables;
    seenQuery = parsed.query;
    return jsonResponse({ data: { change_simple_column_value: { id: '900' } } });
  };
  await setSimpleColumnValue(
    { ...OPTS, fetchImpl: fakeFetch as any },
    'board-1',
    'item-900',
    'status',
    'Done',
  );
  assert.deepEqual(seenVariables, {
    boardId: 'board-1',
    itemId: 'item-900',
    columnId: 'status',
    value: 'Done',
  });
  assert.match(seenQuery!, /change_simple_column_value/);
});

test('createUpdate sends the exact GraphQL variables', async () => {
  let seenVariables: unknown;
  let seenQuery: string | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(init!.body as string);
    seenVariables = parsed.variables;
    seenQuery = parsed.query;
    return jsonResponse({ data: { create_update: { id: '1' } } });
  };
  await createUpdate({ ...OPTS, fetchImpl: fakeFetch as any }, 'item-900', 'Synced from Nexus');
  assert.deepEqual(seenVariables, { itemId: 'item-900', body: 'Synced from Nexus' });
  assert.match(seenQuery!, /create_update/);
});

test('fetchBoards returns id, name, and workspace name where available', async () => {
  let seenQuery: string | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(init!.body as string);
    seenQuery = parsed.query;
    return jsonResponse({
      data: {
        boards: [
          { id: '1', name: 'Portfolio', workspace: { name: 'Product' } },
          { id: '2', name: 'Ops', workspace: null },
        ],
      },
    });
  };
  const boards = await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.deepEqual(boards, [
    { id: '1', name: 'Portfolio', workspace: 'Product' },
    { id: '2', name: 'Ops', workspace: null },
  ]);
  assert.match(seenQuery!, /boards/);
});

test('fetchBoards tolerates a missing boards array instead of throwing', async () => {
  const fakeFetch = async () => jsonResponse({ data: {} });
  const boards = await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.deepEqual(boards, []);
});

test('fetchBoards requests the type field so subitem/document boards can be filtered', async () => {
  let seenQuery: string | undefined;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    seenQuery = JSON.parse(init!.body as string).query;
    return jsonResponse({ data: { boards: [] } });
  };
  await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.match(seenQuery!, /\btype\b/);
});

test('fetchBoards excludes a sub_items_board entry and keeps a normal board', async () => {
  const fakeFetch = async () => jsonResponse({
    data: {
      boards: [
        { id: '1', name: 'Portfolio', type: 'board', workspace: { name: 'Product' } },
        { id: '2', name: 'Subitems of Portfolio', type: 'sub_items_board', workspace: { name: 'Product' } },
      ],
    },
  });
  const boards = await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.deepEqual(boards, [{ id: '1', name: 'Portfolio', workspace: 'Product' }]);
});

test('fetchBoards also excludes a document board', async () => {
  const fakeFetch = async () => jsonResponse({
    data: {
      boards: [
        { id: '1', name: 'Portfolio', type: 'board', workspace: null },
        { id: '3', name: 'Some Doc', type: 'document', workspace: null },
      ],
    },
  });
  const boards = await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.deepEqual(boards, [{ id: '1', name: 'Portfolio', workspace: null }]);
});

test('fetchBoards keeps a board when the type field is absent (fail open, not closed)', async () => {
  const fakeFetch = async () => jsonResponse({
    data: { boards: [{ id: '1', name: 'Legacy', workspace: null }] },
  });
  const boards = await fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any });
  assert.deepEqual(boards, [{ id: '1', name: 'Legacy', workspace: null }]);
});

test('fetchBoards propagates a Monday failure (never silently empty)', async () => {
  const fakeFetch = async () => jsonResponse({
    errors: [{ message: 'Not Authenticated', extensions: { code: 'UserUnauthorizedException' } }],
  });
  await assert.rejects(
    () => fetchBoards({ ...OPTS, fetchImpl: fakeFetch as any }),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.equal(err.code, 'UserUnauthorizedException');
      return true;
    },
  );
});

test('fetchBoardMeta returns groups and columns for one board', async () => {
  let seenVariables: unknown;
  const fakeFetch = async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(init!.body as string);
    seenVariables = parsed.variables;
    return jsonResponse({
      data: {
        boards: [{
          groups: [{ id: 'g1', title: 'Q3' }],
          columns: [
            { id: 'text_1', title: 'Points', type: 'numbers' },
            { id: 'status', title: 'Status', type: 'status' },
          ],
        }],
      },
    });
  };
  const meta = await fetchBoardMeta({ ...OPTS, fetchImpl: fakeFetch as any }, 'board-1');
  assert.deepEqual(seenVariables, { boardId: 'board-1' });
  assert.deepEqual(meta.groups, [{ id: 'g1', title: 'Q3' }]);
  assert.deepEqual(meta.columns, [
    { id: 'text_1', title: 'Points', type: 'numbers' },
    { id: 'status', title: 'Status', type: 'status' },
  ]);
});

test('fetchBoardMeta throws instead of returning empty when boards[] comes back empty', async () => {
  const fakeFetch = async () => jsonResponse({ data: { boards: [] } });
  await assert.rejects(
    () => fetchBoardMeta({ ...OPTS, fetchImpl: fakeFetch as any }, 'ghost-board'),
    (err: unknown) => {
      assert.ok(err instanceof MondayError);
      assert.match(err.message, /ghost-board/);
      return true;
    },
  );
});

const RAW = {
  id: '900',
  name: 'Ship the thing',
  state: 'active',
  updated_at: '2026-07-20T09:00:00Z',
  url: 'https://x.monday.com/boards/1/pulses/900',
  board: { id: '1', name: 'Portfolio' },
  group: { id: 'topics', title: 'Q3' },
  column_values: [
    { id: 'status', type: 'status', text: 'Working on it', value: '{"index":0}' },
    { id: 'person', type: 'people', text: 'Keith Symmonds', value: null },
    { id: 'text_mkxyz', type: 'text', text: '', value: null },
  ],
};

test('mapItem flattens status, owners, and keeps raw column values', () => {
  const row = mapItem(RAW as any, '2026-07-22T10:00:00.000Z');
  assert.equal(row.item_id, '900');
  assert.equal(row.board_id, '1');
  assert.equal(row.board_name, 'Portfolio');
  assert.equal(row.group_id, 'topics');
  assert.equal(row.group_title, 'Q3');
  assert.equal(row.name, 'Ship the thing');
  assert.equal(row.state, 'active');
  assert.equal(row.status_label, 'Working on it');
  assert.deepEqual(JSON.parse(row.owners_json), ['Keith Symmonds']);
  assert.equal(row.monday_updated_at, '2026-07-20T09:00:00Z');
  assert.equal(row.synced_at, '2026-07-22T10:00:00.000Z');
  const cols = JSON.parse(row.column_values_json);
  assert.equal(cols.text_mkxyz.type, 'text');
});

test('mapItem does not split a display name containing a comma into two owners', () => {
  // "Symmonds, Keith" is ONE person's display name (surname-first). Naively
  // splitting the people column's comma-joined `text` on "," reads this as
  // two separate owners. With no structured `value` to fall back on, the
  // whole text must survive as a single unsplit owner string.
  const raw = {
    ...RAW,
    column_values: [
      { id: 'person', type: 'people', text: 'Symmonds, Keith', value: null },
    ],
  };
  const row = mapItem(raw as any, '2026-07-22T10:00:00.000Z');
  assert.deepEqual(JSON.parse(row.owners_json), ['Symmonds, Keith']);
});

test('mapItem prefers structured names from the people column\'s JSON value when present', () => {
  const raw = {
    ...RAW,
    column_values: [
      {
        id: 'person', type: 'people', text: 'Symmonds, Keith, Jane Doe',
        value: JSON.stringify({ personsAndTeams: [{ id: 1, kind: 'person', name: 'Symmonds, Keith' }, { id: 2, kind: 'person', name: 'Jane Doe' }] }),
      },
    ],
  };
  const row = mapItem(raw as any, '2026-07-22T10:00:00.000Z');
  // Two real, individually-scoped names — including one that itself
  // contains a comma — recovered correctly because they came from the
  // structured value, never from splitting the joined text.
  assert.deepEqual(JSON.parse(row.owners_json), ['Symmonds, Keith', 'Jane Doe']);
});

test('mapItem falls back to the unsplit text when the people column value is malformed JSON', () => {
  const raw = {
    ...RAW,
    column_values: [
      { id: 'person', type: 'people', text: 'Symmonds, Keith', value: '{not json' },
    ],
  };
  const row = mapItem(raw as any, '2026-07-22T10:00:00.000Z');
  assert.deepEqual(JSON.parse(row.owners_json), ['Symmonds, Keith']);
});

test('mapItem tolerates an item with no group, status, or owners', () => {
  const row = mapItem({ id: '5', name: 'Bare', state: 'active', column_values: [] } as any, 'now');
  assert.equal(row.group_id, null);
  assert.equal(row.status_label, null);
  assert.deepEqual(JSON.parse(row.owners_json), []);
  assert.equal(row.board_id, '');
});
