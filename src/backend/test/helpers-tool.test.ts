import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHelpersExtension, helpersToolNames } from '../pi/helpers-tool';
import type { HelpersToolDeps } from '../helpers/resolve';

/** Minimal Pi stub capturing registerTool calls (matches monday-tool.test). */
function fakePi() {
  const tools: { name: string; description: string; promptSnippet?: string; parameters: any; execute: Function }[] = [];
  return { tools, registerTool: (t: any) => tools.push(t) };
}

function build(deps: Partial<HelpersToolDeps>) {
  const pi = fakePi();
  createHelpersExtension({ searchProviders: [], ...deps } as HelpersToolDeps)(pi as any);
  return pi;
}

const searchDeps: Partial<HelpersToolDeps> = {
  searchProviders: ['exa'],
  search: async () => ({
    provider: 'exa',
    results: [{ title: 'Result', url: 'https://r.example', snippet: 'a snippet', text: 'page body' }],
  }),
};

test('only the live capabilities register their tools', () => {
  assert.deepEqual(build({}).tools.map((t) => t.name), []);
  assert.deepEqual(build(searchDeps).tools.map((t) => t.name), ['web_search']);
  assert.deepEqual(
    build({ answer: async () => ({ answer: 'a', citations: [] }) }).tools.map((t) => t.name),
    ['web_answer'],
  );
  assert.deepEqual(
    build({ docs: async () => ({ library: 'X', libraryId: '/x', text: 't' }) }).tools.map((t) => t.name),
    ['docs_lookup'],
  );
});

test('helpersToolNames mirrors what registers, in a stable order', () => {
  const all: HelpersToolDeps = {
    searchProviders: ['brave', 'exa'],
    search: searchDeps.search!,
    answer: async () => ({ answer: 'a', citations: [] }),
    docs: async () => ({ library: 'X', libraryId: '/x', text: 't' }),
  };
  assert.deepEqual(helpersToolNames(all), ['web_search', 'web_answer', 'docs_lookup']);
  const pi = fakePi();
  createHelpersExtension(all)(pi as any);
  assert.deepEqual(pi.tools.map((t) => t.name), helpersToolNames(all));
});

test('every registered tool carries a promptSnippet', () => {
  const pi = build({
    ...searchDeps,
    answer: async () => ({ answer: 'a', citations: [] }),
    docs: async () => ({ library: 'X', libraryId: '/x', text: 't' }),
  });
  for (const tool of pi.tools) {
    assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0, `${tool.name} needs a promptSnippet`);
  }
});

test('web_search offers a provider arg only when more than one is live', () => {
  const one = build(searchDeps).tools.find((t) => t.name === 'web_search')!;
  assert.equal('provider' in one.parameters.properties, false);
  const two = build({
    searchProviders: ['brave', 'exa'],
    search: searchDeps.search!,
  }).tools.find((t) => t.name === 'web_search')!;
  assert.equal('provider' in two.parameters.properties, true);
});

test('web_search formats results with url, snippet, and inline text', async () => {
  const tool = build(searchDeps).tools.find((t) => t.name === 'web_search')!;
  const res = await tool.execute('c1', { query: 'anything' });
  const text = res.content[0].text as string;
  assert.match(text, /https:\/\/r\.example/);
  assert.match(text, /a snippet/);
  assert.match(text, /page body/);
  assert.equal(res.details.count, 1);
  assert.equal(res.details.provider, 'exa');
});

test('web_search reports empty results without throwing', async () => {
  const tool = build({
    searchProviders: ['brave'],
    search: async () => ({ provider: 'brave', results: [] }),
  }).tools.find((t) => t.name === 'web_search')!;
  const res = await tool.execute('c1', { query: 'nothing' });
  assert.match(res.content[0].text, /No web results/);
  assert.equal(res.details.status, 'empty');
});

test('web_search rejects an empty query', async () => {
  const tool = build(searchDeps).tools.find((t) => t.name === 'web_search')!;
  await assert.rejects(() => tool.execute('c1', { query: '   ' }), /non-empty/);
});

test('web_answer renders the answer and a numbered sources list', async () => {
  const tool = build({
    answer: async () => ({ answer: 'The answer.', citations: ['https://a', 'https://b'] }),
  }).tools.find((t) => t.name === 'web_answer')!;
  const res = await tool.execute('c1', { question: 'why?' });
  const text = res.content[0].text as string;
  assert.match(text, /The answer\./);
  assert.match(text, /Sources:/);
  assert.match(text, /\[1\] https:\/\/a/);
  assert.match(text, /\[2\] https:\/\/b/);
  assert.equal(res.details.citations, 2);
});

test('web_answer reports an empty answer without throwing', async () => {
  const tool = build({
    answer: async () => ({ answer: '  ', citations: [] }),
  }).tools.find((t) => t.name === 'web_answer')!;
  const res = await tool.execute('c1', { question: 'q' });
  assert.equal(res.details.status, 'empty');
});

test('docs_lookup passes the topic through and renders the library header', async () => {
  let seen: { library: string; topic?: string } | undefined;
  const tool = build({
    docs: async (library, topic) => {
      seen = { library, topic };
      return { library: 'Next.js', libraryId: '/vercel/next.js', text: 'App Router docs...' };
    },
  }).tools.find((t) => t.name === 'docs_lookup')!;
  const res = await tool.execute('c1', { library: 'next.js', topic: 'routing' });
  assert.deepEqual(seen, { library: 'next.js', topic: 'routing' });
  assert.match(res.content[0].text, /# Next\.js \(\/vercel\/next\.js\)/);
  assert.match(res.content[0].text, /App Router docs/);
});

test('docs_lookup reports no snippets without throwing', async () => {
  const tool = build({
    docs: async () => ({ library: 'X', libraryId: '/x', text: '' }),
  }).tools.find((t) => t.name === 'docs_lookup')!;
  const res = await tool.execute('c1', { library: 'x' });
  assert.match(res.content[0].text, /No documentation snippets/);
  assert.equal(res.details.status, 'empty');
});

test('a provider error propagates as a throw for Pi to turn into a tool error', async () => {
  const tool = build({
    searchProviders: ['exa'],
    search: async () => {
      throw new Error('Exa request failed (HTTP 401): check the API key');
    },
  }).tools.find((t) => t.name === 'web_search')!;
  await assert.rejects(() => tool.execute('c1', { query: 'x' }), /HTTP 401/);
});
