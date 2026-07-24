/**
 * Resolve the `tool_policy` config block for one repo into the getters the
 * policy resolver consumes (#281).
 *
 * Global category defaults and rules apply everywhere; a per-project entry
 * (keyed by repo path, the same convention as `signal_filters.projects`)
 * overrides them for that repo. Read fresh on each tool call so a config edit
 * lands without a session rebuild — the resolver already re-reads its getters.
 */
import os from 'node:os';
import path from 'node:path';
import type { NexusConfig, ToolPolicyOverride, ToolPolicyRule } from '@nexus/shared';
import type { CategoryPolicy } from './tool-policy.js';

export interface ResolvedToolPolicy {
  /** Category overrides, applied over the built-in defaults in the resolver. */
  categories: CategoryPolicy;
  /** Input-aware rules, project ones first (more specific → first-match wins). */
  rules: ToolPolicyRule[];
}

export const EMPTY_TOOL_POLICY: ResolvedToolPolicy = { categories: {}, rules: [] };

/** Normalize a repo path for matching (home-expand, absolutize, de-trail).
 *  Mirrors signal-filters' path handling so both blocks key projects alike. */
function normalizeRepoPath(value: string): string {
  const expanded = value === '~'
    ? os.homedir()
    : value.startsWith('~/')
      ? path.join(os.homedir(), value.slice(2))
      : value;
  const absolute = path.normalize(path.resolve(expanded));
  return absolute.replace(/[\\/]+$/, '') || path.parse(absolute).root;
}

/** A rule is usable only with a string tool and a string decision; the resolver
 *  validates the decision value itself, so keep this shape-only and lenient. */
function isRuleShaped(rule: unknown): rule is ToolPolicyRule {
  const r = rule as ToolPolicyRule | null;
  return !!r && typeof r.tool === 'string' && typeof r.decision === 'string';
}

export function resolveToolPolicy(config: NexusConfig, repoPath: string): ResolvedToolPolicy {
  const block = config.tool_policy;
  if (!block) return { categories: {}, rules: [] };

  const normalizedRepo = repoPath ? normalizeRepoPath(repoPath) : '';
  const project: ToolPolicyOverride | undefined = normalizedRepo
    ? Object.entries(block.projects ?? {}).find(([key]) => {
        try { return normalizeRepoPath(key) === normalizedRepo; } catch { return false; }
      })?.[1]
    : undefined;

  return {
    // Project categories win over global; both applied over the built-in
    // defaults inside the resolver.
    categories: { ...(block.categories ?? {}), ...(project?.categories ?? {}) },
    // Project rules first so they take precedence (first-match wins), then
    // global. Malformed rules are dropped here; the resolver also skips them.
    rules: [...(project?.rules ?? []), ...(block.rules ?? [])].filter(isRuleShaped),
  };
}
