/**
 * Per-provider request / verify / normalise for the API helpers (#291).
 *
 * Each provider has three concerns kept separate so they can be tested and
 * reasoned about independently:
 *   - a network function (braveSearch, exaSearch, perplexityAnswer, context7Docs)
 *     that builds the request and calls the shared transport;
 *   - a PURE normaliser (normalise*) that turns the raw payload into the
 *     model-facing shape — unit-tested against captured samples, no network;
 *   - a verify() that does one cheap authenticated call for the Settings "Test".
 *
 * Every normaliser is defensive: each field is type-checked and a malformed or
 * renamed field degrades to empty rather than throwing. These are third-party
 * shapes that can drift under us — the same posture the Monday mirror takes.
 *
 * Endpoints/headers/models below were confirmed against each provider's docs on
 * 2026-07-24. The Context7 v2 field names (codeSnippets/codeList/infoSnippets)
 * are the ones most worth reconfirming if docs output ever looks empty; the
 * guards make a mismatch degrade to no text, not a crash.
 */
import { callProvider, providerError, HelperHttpError, type TransportOpts } from './client.js';
import type {
  AnswerResponse,
  DocsResponse,
  HelperProvider,
  HelperVerifyResult,
  SearchResponse,
  SearchResultItem,
} from './types.js';

/** Results returned per search/docs call — bounded so a tool result stays
 *  within a sane token budget regardless of how much the provider sends. */
const SEARCH_LIMIT = 8;
/** Exa returns full page text per result; cap each so eight results can't
 *  blow the context. */
const EXA_TEXT_CAP = 1500;
/** Exa highlight/summary excerpt cap. */
const EXA_SNIPPET_CAP = 400;
/** Total Context7 doc text cap. */
const DOCS_CAP = 6000;
/** Perplexity searches then synthesises, so it needs longer than the default. */
const ANSWER_TIMEOUT_MS = 30_000;
const PERPLEXITY_MODEL = 'sonar';

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ---------------------------------------------------------------------------
// Brave — GET, X-Subscription-Token, web.results[] { title, url, description }
// ---------------------------------------------------------------------------
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export function normaliseBrave(json: unknown, limit = SEARCH_LIMIT): SearchResponse {
  const results = arr((json as any)?.web?.results)
    .slice(0, limit)
    .map((r: any): SearchResultItem => ({
      title: str(r?.title),
      url: str(r?.url),
      snippet: str(r?.description),
    }))
    .filter((r) => r.url !== '');
  return { provider: 'brave', results };
}

export async function braveSearch(
  key: string,
  query: string,
  opts: TransportOpts = {},
): Promise<SearchResponse> {
  // Key rides the header; only the (non-secret) query goes in the URL.
  const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${SEARCH_LIMIT}`;
  const res = await callProvider(url, {
    ...opts,
    method: 'GET',
    headers: { 'X-Subscription-Token': key },
  });
  if (!res.ok) throw providerError('Brave', res);
  return normaliseBrave(res.json);
}

// ---------------------------------------------------------------------------
// Exa — POST, x-api-key, results[] { title, url, text, highlights[], summary }
// ---------------------------------------------------------------------------
const EXA_ENDPOINT = 'https://api.exa.ai/search';

export function normaliseExa(
  json: unknown,
  limit = SEARCH_LIMIT,
  textCap = EXA_TEXT_CAP,
): SearchResponse {
  const results = arr((json as any)?.results)
    .slice(0, limit)
    .map((r: any): SearchResultItem => {
      const highlight = arr(r?.highlights).find((h): h is string => typeof h === 'string');
      const snippet = (highlight ?? str(r?.summary)).slice(0, EXA_SNIPPET_CAP);
      const text = typeof r?.text === 'string' ? r.text.slice(0, textCap) : undefined;
      return { title: str(r?.title), url: str(r?.url), snippet, text };
    })
    .filter((r) => r.url !== '');
  return { provider: 'exa', results };
}

export async function exaSearch(
  key: string,
  query: string,
  opts: TransportOpts = {},
): Promise<SearchResponse> {
  const res = await callProvider(EXA_ENDPOINT, {
    ...opts,
    method: 'POST',
    headers: { 'x-api-key': key },
    body: { query, numResults: SEARCH_LIMIT, contents: { text: true } },
  });
  if (!res.ok) throw providerError('Exa', res);
  return normaliseExa(res.json);
}

// ---------------------------------------------------------------------------
// Perplexity — POST /chat/completions, Bearer, choices[0].message.content +
// search_results[]/citations[]
// ---------------------------------------------------------------------------
const PERPLEXITY_ENDPOINT = 'https://api.perplexity.ai/chat/completions';

export function normalisePerplexity(json: unknown): AnswerResponse {
  const answer = str((json as any)?.choices?.[0]?.message?.content);
  // Prefer search_results (carries titled sources); fall back to the flat
  // citations url list. Either can be present depending on the model/tier.
  let citations: string[] = [];
  const searchResults = arr((json as any)?.search_results);
  if (searchResults.length > 0) {
    citations = searchResults.map((s: any) => str(s?.url)).filter((u) => u !== '');
  } else {
    citations = arr((json as any)?.citations).filter((c): c is string => typeof c === 'string');
  }
  return { answer, citations };
}

export async function perplexityAnswer(
  key: string,
  question: string,
  opts: TransportOpts = {},
): Promise<AnswerResponse> {
  const res = await callProvider(PERPLEXITY_ENDPOINT, {
    timeoutMs: ANSWER_TIMEOUT_MS,
    ...opts,
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: { model: PERPLEXITY_MODEL, messages: [{ role: 'user', content: question }] },
  });
  if (!res.ok) throw providerError('Perplexity', res);
  return normalisePerplexity(res.json);
}

// ---------------------------------------------------------------------------
// Context7 v2 — GET /libs/search then GET /context, Bearer. Two-step: resolve a
// human library name to an id, then fetch that id's docs.
// ---------------------------------------------------------------------------
const CONTEXT7_BASE = 'https://context7.com/api/v2';

export interface Context7Library {
  id: string;
  title: string;
}

export function normaliseContext7Search(json: unknown): Context7Library | null {
  const first = arr((json as any)?.results).find(
    (r: any) => typeof r?.id === 'string' && r.id !== '',
  ) as any;
  if (!first) return null;
  return { id: first.id, title: str(first.title) || first.id };
}

export function normaliseContext7Docs(
  json: unknown,
  library: Context7Library,
  cap = DOCS_CAP,
): DocsResponse {
  const parts: string[] = [];
  for (const c of arr((json as any)?.codeSnippets) as any[]) {
    const title = str(c?.codeTitle);
    const code = arr(c?.codeList).filter((x): x is string => typeof x === 'string');
    if (code.length > 0) {
      parts.push([title, '```', code.join('\n'), '```'].filter((s) => s !== '').join('\n'));
    }
  }
  for (const i of arr((json as any)?.infoSnippets) as any[]) {
    const content = str(i?.content).trim();
    if (content !== '') parts.push(content);
  }
  return { libraryId: library.id, library: library.title, text: parts.join('\n\n').slice(0, cap) };
}

/** Step 1: resolve a human library name (optionally biased by topic) to an id.
 *  Shared by docs lookup and verify. */
export async function context7ResolveLibrary(
  key: string,
  library: string,
  topic: string | undefined,
  opts: TransportOpts = {},
): Promise<Context7Library | null> {
  const q = topic ? `&query=${encodeURIComponent(topic)}` : '';
  const url = `${CONTEXT7_BASE}/libs/search?libraryName=${encodeURIComponent(library)}${q}`;
  const res = await callProvider(url, { ...opts, method: 'GET', headers: bearer(key) });
  if (!res.ok) throw providerError('Context7', res);
  return normaliseContext7Search(res.json);
}

export async function context7Docs(
  key: string,
  library: string,
  topic: string | undefined,
  opts: TransportOpts = {},
): Promise<DocsResponse> {
  const lib = await context7ResolveLibrary(key, library, topic, opts);
  if (!lib) throw new HelperHttpError(`Context7 found no library matching "${library}"`);
  const q = topic ? `&query=${encodeURIComponent(topic)}` : '';
  const url = `${CONTEXT7_BASE}/context?libraryId=${encodeURIComponent(lib.id)}${q}&type=json`;
  const res = await callProvider(url, { ...opts, method: 'GET', headers: bearer(key) });
  if (!res.ok) throw providerError('Context7', res);
  return normaliseContext7Docs(res.json, lib);
}

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------
// Verify — one cheap authenticated call each, mapped to {ok, message}. Used by
// the Settings "Test" button (route wiring lands in Task 6).
// ---------------------------------------------------------------------------
async function verified(
  label: string,
  call: () => Promise<unknown>,
): Promise<HelperVerifyResult> {
  try {
    await call();
    return { ok: true, message: `${label} key verified.` };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Provider registry keyed by id — the settings route validates `:provider`
 *  against these keys and calls verify() with the resolved key. */
export const HELPER_PROVIDERS: Record<
  HelperProvider,
  { verify: (key: string, opts?: TransportOpts) => Promise<HelperVerifyResult> }
> = {
  brave: { verify: (key, opts) => verified('Brave', () => braveSearch(key, 'test', opts)) },
  exa: { verify: (key, opts) => verified('Exa', () => exaSearch(key, 'test', opts)) },
  perplexity: {
    verify: (key, opts) => verified('Perplexity', () => perplexityAnswer(key, 'ping', opts)),
  },
  context7: {
    verify: (key, opts) =>
      verified('Context7', () => context7ResolveLibrary(key, 'react', undefined, opts)),
  },
};
