// Memory identity + scope derivation.
// Markdown is canonical; every managed memory carries a ULID `id` in frontmatter so
// identity survives renames/moves. Scope (namespace/project/category) derives from the
// path under the vault, with frontmatter taking precedence.
import matter from "gray-matter";
import { relative, sep } from "node:path";

export interface ParsedMemory {
  id?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(raw: string): ParsedMemory {
  const parsed = matter(raw);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const id = typeof fm.id === "string" ? fm.id : undefined;
  return { id, frontmatter: fm, body: parsed.content };
}

/** Serialize frontmatter + body back to a canonical markdown string. */
export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  // gray-matter appends a trailing newline; normalize to exactly one.
  return matter.stringify(body, frontmatter).replace(/\n*$/, "\n");
}

export interface Scope {
  namespace: string;
  project: string | null;
  category: string | null;
  source: string;
}

const NAMESPACE_BY_TOP: Record<string, string> = {
  Nexus: "nexus",
  OpenClaw: "openclaw",
  Memories: "global",
};

/** Derive scope from the vault-relative path, letting frontmatter override each field. */
export function deriveScope(filePath: string, vaultPath: string, fm: Record<string, unknown>): Scope {
  const rel = relative(vaultPath, filePath);
  const parts = rel.split(sep);
  const top = parts[0] ?? "";

  let namespace = NAMESPACE_BY_TOP[top] ?? "global";
  let project: string | null = null;
  let category: string | null = null;

  // Nexus/Projects/<slug>/<Category>/file.md
  if (top === "Nexus" && parts[1] === "Projects" && parts.length >= 4) {
    project = parts[2] ?? null;
    category = (parts[3] ?? null)?.toLowerCase() ?? null;
  } else if (parts.length >= 2) {
    category = (parts[parts.length - 2] ?? null)?.toLowerCase() ?? null;
  }

  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    namespace: str(fm.namespace) ?? namespace,
    project: str(fm.project) ?? project,
    category: str(fm.category) ?? category,
    source: str(fm.source) ?? "human",
  };
}
