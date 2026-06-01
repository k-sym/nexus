// KG fusion at recall time: match query terms against fact subjects/objects, return the
// related triples grouped per memory (attached to results, and used for a small rank boost).
import type { AppContext } from "../context.js";
import type { ScopeFilter, Triple } from "../retrieval/types.js";

const STOP = new Set(["what", "which", "where", "when", "does", "with", "from", "this", "that", "have", "about", "into"]);

export interface QueryFacts {
  byMemory: Map<string, Triple[]>;
}

export function factsForQuery(ctx: AppContext, query: string, filter: ScopeFilter): QueryFacts {
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 8);
  const byMemory = new Map<string, Triple[]>();
  if (terms.length === 0) return { byMemory };

  const scope: string[] = [];
  const scopeParams: unknown[] = [];
  if (filter.namespace) {
    scope.push("m.namespace = ?");
    scopeParams.push(filter.namespace);
  }
  if (filter.project) {
    scope.push("m.project = ?");
    scopeParams.push(filter.project);
  }

  const likeClause = terms.map(() => "(lower(f.subject) LIKE ? OR lower(f.object) LIKE ?)").join(" OR ");
  const likeParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const sql = `
    SELECT f.memory_id AS memoryId, f.subject, f.relation, f.object
    FROM facts f JOIN memories m ON m.id = f.memory_id
    WHERE m.deleted_at IS NULL${scope.length ? " AND " + scope.join(" AND ") : ""}
      AND (${likeClause})
    LIMIT 200`;

  const rows = ctx.db.prepare(sql).all(...scopeParams, ...likeParams) as Array<{
    memoryId: string;
    subject: string;
    relation: string;
    object: string;
  }>;
  for (const r of rows) {
    const arr = byMemory.get(r.memoryId) ?? [];
    arr.push({ subject: r.subject, relation: r.relation, object: r.object });
    byMemory.set(r.memoryId, arr);
  }
  return { byMemory };
}
