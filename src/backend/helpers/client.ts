/**
 * Shared HTTP transport for the API helpers (#291).
 *
 * One entry point so every provider gets the same timeout, the same
 * network-error mapping, and the same guarantee that a request never carries
 * the key anywhere but a header (never a URL query param — see the callers).
 *
 * This layer does the round-trip and the JSON parse only. What a given HTTP
 * status *means* is the provider's call: a 401 is "bad key" to verify() but a
 * hard failure to a tool, so callProvider returns the status rather than
 * throwing on it. It throws only for transport-level failures — an unreachable
 * host or a timeout — where there is no response to inspect.
 */

/** Default per-request timeout. `web_answer` (Perplexity) searches then
 *  synthesises, so its provider passes a longer one explicitly. */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The subset of options a provider function threads through — enough to inject
 *  a fake fetch and a short timeout in tests, nothing else. */
export interface TransportOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpOptions extends TransportOpts {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** JSON-serialised when present; sets Content-Type automatically. */
  body?: unknown;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON, or undefined when the body was empty or not JSON. */
  json: unknown;
  /** Raw response text, capped — for diagnostics/error messages only. */
  text: string;
}

/** A transport-level failure: an unreachable host or a timeout. An HTTP error
 *  status is NOT this — it comes back as an HttpResult for the caller to judge. */
export class HelperHttpError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'HelperHttpError';
  }
}

const SNIPPET_CAP = 500;

export async function callProvider(url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let res: Response;
  try {
    const hasBody = opts.body !== undefined;
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (hasBody) headers['Content-Type'] = 'application/json';
    res = await doFetch(url, {
      method: opts.method ?? (hasBody ? 'POST' : 'GET'),
      headers,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    // A timeout aborts the controller, surfacing as an AbortError here; a real
    // network failure lands here too. Neither carries a response to inspect, so
    // emit a clean, key-free message rather than leaking the request.
    const aborted = (err as Error)?.name === 'AbortError';
    throw new HelperHttpError(
      aborted ? 'request timed out' : `unreachable: ${(err as Error).message}`,
      err,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body (an HTML error page, say) is not fatal here — the caller
    // sees ok/status and a text snippet and decides. json stays undefined.
    json = undefined;
  }
  return { status: res.status, ok: res.ok, json, text: text.slice(0, SNIPPET_CAP) };
}

/** Map a non-2xx provider response to an Error whose message names the provider
 *  and never contains the key. Auth statuses get a pointed hint; anything else
 *  carries the body snippet the transport already captured. */
export function providerError(name: string, res: HttpResult): Error {
  const detail =
    res.status === 401 || res.status === 403
      ? 'check the API key'
      : res.text || `HTTP ${res.status}`;
  return new Error(`${name} request failed (HTTP ${res.status}): ${detail}`);
}
