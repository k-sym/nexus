import type { ScopeFilter } from "../retrieval/types.js";

export interface McpEnvDefaults {
  namespace?: string;
  project?: string;
  scope?: "isolated" | "cross";
  readonly: boolean;
}

/**
 * Read MCP scoping + readonly defaults from the environment.
 * NEXUS_MEMORY_PROJECT pins the nexus namespace + isolated scope to that project slug.
 * NEXUS_MEMORY_READONLY (=1/true) hides the write tools.
 */
export function mcpEnvDefaults(env: NodeJS.ProcessEnv): McpEnvDefaults {
  const readonly = env.NEXUS_MEMORY_READONLY === "1" || env.NEXUS_MEMORY_READONLY === "true";
  const project = env.NEXUS_MEMORY_PROJECT?.trim();
  if (!project) return { readonly };
  return { namespace: "nexus", project, scope: "isolated", readonly };
}

/** Merge explicit tool args over env defaults — args always win. */
export function mergeScope(
  args: { namespace?: string; project?: string; scope?: "isolated" | "cross" },
  defaults: McpEnvDefaults,
): ScopeFilter {
  return {
    namespace: args.namespace ?? defaults.namespace,
    project: args.project ?? defaults.project,
    scope: args.scope ?? defaults.scope,
  };
}
