/**
 * Shared shapes for the API helpers (#291).
 *
 * The tool layer (pi/helpers-tool.ts) speaks these normalised types; the raw
 * provider payloads never leave providers.ts. Keeping the model-facing shape
 * here — not per provider — is what lets `web_search` be one tool over Brave
 * and Exa: both normalise to a SearchResponse.
 */
import type { HelperProvider } from '@nexus/shared';

export type { HelperProvider };

/** Result of a Settings "Test" — one cheap authenticated call per provider.
 *  `message` is shown next to the Test button and never contains the key. */
export interface HelperVerifyResult {
  ok: boolean;
  message: string;
}

/** One web-search hit, normalised across Brave and Exa. */
export interface SearchResultItem {
  title: string;
  url: string;
  /** Short excerpt — Brave `description`, or Exa's first highlight/summary. */
  snippet: string;
  /** Cleaned full-page text, when the provider returns it inline (Exa). */
  text?: string;
}

export interface SearchResponse {
  provider: 'brave' | 'exa';
  results: SearchResultItem[];
}

/** A synthesised, cited answer (Perplexity). */
export interface AnswerResponse {
  answer: string;
  /** Source URLs backing the answer, in order. */
  citations: string[];
}

/** Version-current library docs (Context7). */
export interface DocsResponse {
  /** Resolved Context7 library id, e.g. "/vercel/next.js". */
  libraryId: string;
  /** Resolved library title, e.g. "Next.js". */
  library: string;
  /** Formatted doc snippets (code + prose), token-bounded, ready for the model. */
  text: string;
}
