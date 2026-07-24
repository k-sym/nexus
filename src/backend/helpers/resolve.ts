/**
 * Config → live helpers → tool deps (#291).
 *
 * The bridge between `config.helpers` and the Pi tool layer. A provider is
 * "live" only when it is `enabled` AND its `api_key` resolves (via ${ENV}
 * interpolation) to a non-empty value — the same two-gate contract Monday uses
 * (`enabled && token`). Keys are resolved here, server-side, and closed over by
 * the deps functions; they never travel further.
 *
 * `buildHelpersToolDeps` returns null when NO capability is live, so the runtime
 * can omit the whole extension — a session never advertises a tool it can't run.
 */
import { resolveEnvVars } from '../config.js';
import type { HelperConfig, NexusConfig } from '@nexus/shared';
import { braveSearch, exaSearch, perplexityAnswer, context7Docs } from './providers.js';
import type { AnswerResponse, DocsResponse, SearchResponse } from './types.js';

export type SearchProvider = 'brave' | 'exa';

/** Which providers are enabled with a resolvable key. Pure — drives both the
 *  orientation line and the tool-deps gating. */
export interface LiveHelpers {
  brave: boolean;
  exa: boolean;
  perplexity: boolean;
  context7: boolean;
}

/** What the Pi helper extension is built from. A method is present iff its
 *  backing capability is live; the extension registers exactly those tools. */
export interface HelpersToolDeps {
  /** Live search providers in config order — lets `web_search` validate and
   *  advertise its optional `provider` argument. Non-empty iff `search` is set. */
  searchProviders: SearchProvider[];
  search?: (query: string, provider?: SearchProvider) => Promise<SearchResponse>;
  answer?: (question: string) => Promise<AnswerResponse>;
  docs?: (library: string, topic?: string) => Promise<DocsResponse>;
}

/** Enabled + a non-empty resolved key ⇒ the usable key; otherwise ''. */
function resolveKey(cfg: HelperConfig | undefined): string {
  if (!cfg?.enabled) return '';
  return resolveEnvVars(cfg.api_key || '').trim();
}

export function liveHelpers(config: NexusConfig): LiveHelpers {
  const h = config.helpers;
  return {
    brave: resolveKey(h?.brave) !== '',
    exa: resolveKey(h?.exa) !== '',
    perplexity: resolveKey(h?.perplexity) !== '',
    context7: resolveKey(h?.context7) !== '',
  };
}

/** Any capability live? Drives the orientation `hasHelpers` line (Task 5). */
export function anyHelperLive(config: NexusConfig): boolean {
  const l = liveHelpers(config);
  return l.brave || l.exa || l.perplexity || l.context7;
}

/** The routing rule for `web_search`: an explicit, live `requested` provider
 *  wins; else `search_default` when live; else the first live provider. Returns
 *  null only when neither search provider is live. */
function pickSearch(
  available: SearchProvider[],
  searchDefault: SearchProvider,
  requested?: SearchProvider,
): SearchProvider | null {
  if (available.length === 0) return null;
  if (requested && available.includes(requested)) return requested;
  return available.includes(searchDefault) ? searchDefault : available[0];
}

/** Pure view of the routing rule for tests/callers that only need the decision. */
export function chooseSearchProvider(
  config: NexusConfig,
  requested?: SearchProvider,
): SearchProvider | null {
  const live = liveHelpers(config);
  const available: SearchProvider[] = [];
  if (live.brave) available.push('brave');
  if (live.exa) available.push('exa');
  return pickSearch(available, config.helpers?.search_default ?? 'exa', requested);
}

export function buildHelpersToolDeps(config: NexusConfig): HelpersToolDeps | null {
  const keys = {
    brave: resolveKey(config.helpers?.brave),
    exa: resolveKey(config.helpers?.exa),
    perplexity: resolveKey(config.helpers?.perplexity),
    context7: resolveKey(config.helpers?.context7),
  };
  const searchDefault = config.helpers?.search_default ?? 'exa';

  const searchProviders: SearchProvider[] = [];
  if (keys.brave) searchProviders.push('brave');
  if (keys.exa) searchProviders.push('exa');

  const deps: HelpersToolDeps = { searchProviders };

  if (searchProviders.length > 0) {
    deps.search = (query, provider) => {
      // Non-null: searchProviders is non-empty here, so pickSearch never returns null.
      const chosen = pickSearch(searchProviders, searchDefault, provider)!;
      return chosen === 'brave' ? braveSearch(keys.brave, query) : exaSearch(keys.exa, query);
    };
  }
  if (keys.perplexity) {
    deps.answer = (question) => perplexityAnswer(keys.perplexity, question);
  }
  if (keys.context7) {
    deps.docs = (library, topic) => context7Docs(keys.context7, library, topic);
  }

  // Nothing live ⇒ null, so the runtime omits the extension entirely.
  if (!deps.search && !deps.answer && !deps.docs) return null;
  return deps;
}
