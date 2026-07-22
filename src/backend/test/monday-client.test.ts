import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mondayGraphql, fetchItemsByIds, MondayError } from '../monday/client';
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

test('mapItem tolerates an item with no group, status, or owners', () => {
  const row = mapItem({ id: '5', name: 'Bare', state: 'active', column_values: [] } as any, 'now');
  assert.equal(row.group_id, null);
  assert.equal(row.status_label, null);
  assert.deepEqual(JSON.parse(row.owners_json), []);
  assert.equal(row.board_id, '');
});
