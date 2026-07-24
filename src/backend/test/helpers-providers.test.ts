import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseBrave,
  normaliseExa,
  normalisePerplexity,
  normaliseContext7Search,
  normaliseContext7Docs,
  braveSearch,
  exaSearch,
  perplexityAnswer,
  context7Docs,
  HELPER_PROVIDERS,
  type Context7Library,
} from '../helpers/providers';

// --- pure normalisers (captured-sample payloads, no network) ---------------

test('normaliseBrave maps web.results, drops url-less entries, respects limit', () => {
  const raw = {
    web: {
      results: [
        { title: 'A', url: 'https://a.example', description: 'first' },
        { title: 'no url', url: '', description: 'dropped' },
        { title: 'B', url: 'https://b.example', description: 'second' },
      ],
    },
  };
  const out = normaliseBrave(raw, 1);
  assert.equal(out.provider, 'brave');
  assert.equal(out.results.length, 1); // limit honoured
  assert.deepEqual(out.results[0], { title: 'A', url: 'https://a.example', snippet: 'first' });
});

test('normaliseBrave degrades a malformed payload to empty results', () => {
  assert.deepEqual(normaliseBrave({}).results, []);
  assert.deepEqual(normaliseBrave({ web: { results: 'nope' } }).results, []);
  assert.deepEqual(normaliseBrave(null).results, []);
});

test('normaliseExa prefers a highlight for snippet and caps inline text', () => {
  const raw = {
    results: [
      {
        title: 'T',
        url: 'https://x.example',
        highlights: ['the relevant bit', 'more'],
        summary: 'a summary',
        text: 'x'.repeat(5000),
      },
    ],
  };
  const out = normaliseExa(raw, 8, 100);
  assert.equal(out.provider, 'exa');
  assert.equal(out.results[0].snippet, 'the relevant bit');
  assert.equal(out.results[0].text!.length, 100); // capped
});

test('normaliseExa falls back to summary when there are no highlights', () => {
  const out = normaliseExa({ results: [{ title: 'T', url: 'https://x', summary: 'sum' }] });
  assert.equal(out.results[0].snippet, 'sum');
  assert.equal(out.results[0].text, undefined); // no text field ⇒ undefined
});

test('normalisePerplexity pulls the answer and prefers search_results urls', () => {
  const raw = {
    choices: [{ message: { role: 'assistant', content: 'the answer' } }],
    search_results: [
      { title: 'S1', url: 'https://s1' },
      { title: 'S2', url: 'https://s2' },
    ],
    citations: ['https://ignored'],
  };
  const out = normalisePerplexity(raw);
  assert.equal(out.answer, 'the answer');
  assert.deepEqual(out.citations, ['https://s1', 'https://s2']);
});

test('normalisePerplexity falls back to citations when search_results is absent', () => {
  const raw = {
    choices: [{ message: { content: 'ans' } }],
    citations: ['https://c1', 'https://c2'],
  };
  const out = normalisePerplexity(raw);
  assert.equal(out.answer, 'ans');
  assert.deepEqual(out.citations, ['https://c1', 'https://c2']);
});

test('normaliseContext7Search picks the first result with an id, else null', () => {
  assert.equal(normaliseContext7Search({ results: [] }), null);
  assert.equal(normaliseContext7Search({}), null);
  const lib = normaliseContext7Search({
    results: [{ title: 'no id' }, { id: '/facebook/react', title: 'React' }],
  });
  assert.deepEqual(lib, { id: '/facebook/react', title: 'React' });
});

test('normaliseContext7Docs formats code + info snippets and caps length', () => {
  const lib: Context7Library = { id: '/facebook/react', title: 'React' };
  const raw = {
    codeSnippets: [{ codeTitle: 'useState', codeList: ['const [n] = useState(0)'] }],
    infoSnippets: [{ content: '  useState returns a pair.  ' }],
  };
  const out = normaliseContext7Docs(raw, lib, 6000);
  assert.equal(out.libraryId, '/facebook/react');
  assert.equal(out.library, 'React');
  assert.match(out.text, /useState returns a pair\./);
  assert.match(out.text, /const \[n\] = useState\(0\)/);
  // cap is enforced
  assert.ok(normaliseContext7Docs(raw, lib, 5).text.length <= 5);
});

// --- network functions (injected fetch) ------------------------------------

test('braveSearch sends the key in a header, never the URL', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return new Response(
      JSON.stringify({ web: { results: [{ title: 'T', url: 'https://a', description: 'd' }] } }),
      { status: 200 },
    );
  };
  const out = await braveSearch('secret-key', 'hello world', { fetchImpl });
  assert.match(seenUrl, /q=hello%20world/);
  assert.match(seenUrl, /count=8/);
  assert.doesNotMatch(seenUrl, /secret-key/); // key must not be in the URL
  assert.equal((seenInit!.headers as Record<string, string>)['X-Subscription-Token'], 'secret-key');
  assert.equal(out.results[0].url, 'https://a');
});

test('exaSearch posts query + contents and sets x-api-key', async () => {
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seenInit = init;
    return new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://e', text: 'body' }] }), {
      status: 200,
    });
  };
  const out = await exaSearch('exa-key', 'query text', { fetchImpl });
  const body = JSON.parse(seenInit!.body as string);
  assert.equal(body.query, 'query text');
  assert.equal(body.contents.text, true);
  assert.equal((seenInit!.headers as Record<string, string>)['x-api-key'], 'exa-key');
  assert.equal(out.results[0].text, 'body');
});

test('perplexityAnswer posts model + messages with a Bearer token', async () => {
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seenInit = init;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'A' } }], citations: ['https://c'] }),
      { status: 200 },
    );
  };
  const out = await perplexityAnswer('pk', 'why?', { fetchImpl });
  const body = JSON.parse(seenInit!.body as string);
  assert.equal(body.model, 'sonar');
  assert.equal(body.messages[0].content, 'why?');
  assert.equal((seenInit!.headers as Record<string, string>)['Authorization'], 'Bearer pk');
  assert.equal(out.answer, 'A');
});

test('context7Docs resolves the library then fetches its docs', async () => {
  const urls: string[] = [];
  const twoStep: typeof fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/libs/search')) {
      return new Response(JSON.stringify({ results: [{ id: '/facebook/react', title: 'React' }] }), {
        status: 200,
      });
    }
    return new Response(
      JSON.stringify({ infoSnippets: [{ content: 'hooks let you use state' }] }),
      { status: 200 },
    );
  };
  const out = await context7Docs('ck', 'react', 'hooks', { fetchImpl: twoStep });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /libs\/search\?libraryName=react/);
  assert.match(urls[1], /context\?libraryId=%2Ffacebook%2Freact/);
  assert.equal(out.libraryId, '/facebook/react');
  assert.match(out.text, /hooks let you use state/);
});

test('a non-2xx response throws a provider error naming the status', async () => {
  const fetchImpl: typeof fetch = async () => new Response('denied', { status: 401 });
  await assert.rejects(braveSearch('bad', 'q', { fetchImpl }), /HTTP 401/);
});

// --- verify registry --------------------------------------------------------

test('HELPER_PROVIDERS.verify returns ok on 200 and not-ok on 401', async () => {
  const ok: typeof fetch = async () =>
    new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
  const bad: typeof fetch = async () => new Response('nope', { status: 401 });

  const good = await HELPER_PROVIDERS.brave.verify('k', { fetchImpl: ok });
  assert.equal(good.ok, true);
  assert.match(good.message, /verified/);

  const fail = await HELPER_PROVIDERS.brave.verify('k', { fetchImpl: bad });
  assert.equal(fail.ok, false);
  assert.match(fail.message, /HTTP 401/);
});
