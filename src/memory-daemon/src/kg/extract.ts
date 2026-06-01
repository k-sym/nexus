// KG triple extraction via the local 9B (4001). Strict JSON, closed vocabulary, capped count.
// Failure (model down / unparseable) THROWS so the job dead-letters — retrieval is unaffected
// because the KG layer is purely additive.
import type { AppContext } from "../context.js";
import { oplog } from "../db/index.js";
import { ENTITY_TYPES, RELATION_TYPES, MAX_TRIPLES_PER_MEMORY } from "./vocab.js";

interface RawTriple {
  subject?: unknown;
  subject_type?: unknown;
  relation?: unknown;
  object?: unknown;
  object_type?: unknown;
}

const SYSTEM =
  "Extract factual subject-relation-object triples from the note. Output ONLY a JSON array " +
  "(no prose, no code fence). Each item: " +
  '{"subject","subject_type","relation","object","object_type"}. ' +
  `subject_type/object_type must be one of: ${ENTITY_TYPES.join(", ")}. ` +
  `relation must be one of: ${RELATION_TYPES.join(", ")}. ` +
  "Use concise canonical entity names. Skip anything you are unsure about. Max " +
  `${MAX_TRIPLES_PER_MEMORY} triples.`;

function parseJsonArray(text: string): RawTriple[] {
  // Tolerate stray prose / code fences: grab the first [...] block.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("no JSON array in extraction output");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("extraction output is not an array");
  return parsed as RawTriple[];
}

const isType = (v: unknown, set: readonly string[]) => typeof v === "string" && set.includes(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function extractTriples(ctx: AppContext, memoryId: string): Promise<number> {
  const mem = ctx.db.prepare("SELECT body FROM memories WHERE id = ? AND deleted_at IS NULL").get(memoryId) as
    | { body: string }
    | undefined;
  if (!mem) return 0; // memory deleted before the job ran — nothing to do

  const out = await ctx.models.complete(mem.body, { system: SYSTEM, temperature: 0, maxTokens: 700, timeoutMs: 60_000 });
  if (out === null) throw new Error("extractor (4001) unreachable");

  const raw = parseJsonArray(out);
  const valid = raw
    .map((t) => ({
      subject: str(t.subject),
      subj_type: isType(t.subject_type, ENTITY_TYPES) ? (t.subject_type as string) : "other",
      relation: isType(t.relation, RELATION_TYPES) ? (t.relation as string) : "related_to",
      object: str(t.object),
      obj_type: isType(t.object_type, ENTITY_TYPES) ? (t.object_type as string) : "other",
    }))
    .filter((t) => t.subject.length > 0 && t.object.length > 0)
    .slice(0, MAX_TRIPLES_PER_MEMORY);

  const now = new Date().toISOString();
  const tx = ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM facts WHERE memory_id = ?").run(memoryId);
    const ins = ctx.db.prepare(
      `INSERT INTO facts (memory_id, subject, subj_type, relation, object, obj_type, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of valid) ins.run(memoryId, t.subject, t.subj_type, t.relation, t.object, t.obj_type, 1.0, now);
  });
  tx();

  oplog(ctx.db, "extract_kg", { memory_id: memoryId, detail: `${valid.length} triples` });
  return valid.length;
}
