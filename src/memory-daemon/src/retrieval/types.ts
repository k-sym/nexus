// Shared retrieval types (also the shape returned over HTTP/MCP).

export interface ScopeFilter {
  namespace?: string;
  project?: string;
  category?: string;
  /** "cross" (default) searches all namespaces; "isolated" restricts to `namespace`. */
  scope?: "isolated" | "cross";
}

export interface MatchedSentence {
  id: number;
  text: string;
  score: number; // rerank relevance_score (or normalized vector score if rerank is down)
  chunkId: number;
}

export interface Triple {
  subject: string;
  relation: string;
  object: string;
}

export interface RecallItem {
  id: string;
  title: string | null;
  namespace: string;
  project: string | null;
  source: string;
  score: number; // best matched-sentence score for the memory
  sentences: MatchedSentence[];
  parentChunks: string[];
  filePath: string;
  facts?: Triple[];
}

export interface RecallResponse {
  query: string;
  hyde?: string | null;
  degraded: boolean; // true if embed/rerank were unavailable
  items: RecallItem[];
}
