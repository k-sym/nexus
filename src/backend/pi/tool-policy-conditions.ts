/**
 * Named, code-defined conditions an input-aware policy rule can reference.
 *
 * This is what keeps input-aware rules bounded (#281): config selects a decision
 * for a *named* condition, it never authors a predicate. The predicates live
 * here, in code, where they can be reviewed and tested. A rule that names a
 * condition not in this registry is ignored by the resolver — an unknown
 * condition never silently matches.
 *
 * The canonical use is the browser: "allow loopback navigation, confirm remote."
 * Expressed safely as `network: confirm` (category) + a `loopback_host` allow
 * rule, so a typo in the condition name falls back to the confirming default
 * rather than opening remote navigation.
 */
import { isLoopbackHost } from '../browser/policy.js';
import type { ToolPolicyRequest } from './tool-policy.js';

export type ToolCondition = (request: ToolPolicyRequest) => boolean;

/** Pull a URL string out of a tool call's input, if it carries one. */
function urlOf(input: unknown): string | undefined {
  const url = (input as { url?: unknown } | null | undefined)?.url;
  return typeof url === 'string' && url.trim() ? url.trim() : undefined;
}

/** True when the request targets a non-loopback host (a remote URL). */
function targetsRemoteHost(request: ToolPolicyRequest): boolean {
  const url = urlOf(request.input);
  if (!url) return false;
  try {
    return !isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export const TOOL_CONDITIONS: Readonly<Record<string, ToolCondition>> = {
  /** The call targets a remote (non-loopback) host — e.g. `browser_navigate`
   *  to anything but localhost. */
  remote_host: (request) => targetsRemoteHost(request),
  /** The call targets loopback. The inverse of `remote_host`, for the
   *  fail-closed allowlist pattern (`network: confirm` + `loopback_host: allow`). */
  loopback_host: (request) => {
    const url = urlOf(request.input);
    if (!url) return false;
    try {
      return isLoopbackHost(new URL(url).hostname);
    } catch {
      return false;
    }
  },
};

/**
 * Evaluate a named condition. Returns the boolean outcome, or `undefined` when
 * the name is unknown — the resolver treats `undefined` as "rule does not
 * apply", so an unknown condition never matches. A predicate that throws is
 * also treated as not-matched rather than propagated.
 */
export function evaluateCondition(name: string, request: ToolPolicyRequest): boolean | undefined {
  const condition = TOOL_CONDITIONS[name];
  if (!condition) return undefined;
  try {
    return condition(request);
  } catch {
    return false;
  }
}
