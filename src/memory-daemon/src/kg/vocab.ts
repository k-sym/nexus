// Fixed vocabulary for KG triple extraction. Constraining the model to a closed set keeps
// entity/relation labels consistent across memories (so the graph actually joins up).

export const ENTITY_TYPES = [
  "person", "organization", "project", "technology", "tool", "language", "framework",
  "library", "service", "model", "database", "file", "concept", "decision", "task",
  "event", "date", "location", "metric", "config", "endpoint", "other",
] as const;

export const RELATION_TYPES = [
  "uses", "chose", "decided", "prefers", "dislikes", "replaces", "depends_on", "runs_on",
  "located_at", "part_of", "created_by", "owns", "configured_with", "measured_by",
  "scheduled_at", "related_to", "has_value", "integrates_with", "stored_in", "responsible_for",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type RelationType = (typeof RELATION_TYPES)[number];

export const MAX_TRIPLES_PER_MEMORY = 15;
