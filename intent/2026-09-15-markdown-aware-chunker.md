# Intent: Markdown-aware chunker for the memory index
Author: Keith. Status: accepted. Source: 2026-09-15 conversation (Chonkie evaluation, docs.chonkie.ai).

## Problem
Every memory enters the daemon through one door (`ingestFile`) and is chunked by
`src/memory-daemon/src/index/chunk.ts` as a structure-blind sliding window: 180 words,
50-word overlap, split on whitespace. Headings, paragraphs, lists and tables are
ignored, and the note title reaches FTS but never the chunk text, so chunk vectors
carry no context about which note or section they came from. Session roll-ups have
Summary / Decisions / Constraints / Discoveries / Follow-ups sections and the window
cuts across them, so a recalled chunk can start mid-decision and end mid-follow-up.
The 180-word figure was chosen as a guard against the embedder's `--ubatch-size`,
not for retrieval quality. No per-source chunking rule exists.

## Proposed outcome
Chunks follow the document's own structure: a markdown-aware recursive split
(headings, then paragraphs, sentences, words) sized under the same embedder limit,
with the note title and full heading path (`Note › H1 › H2`) prepended to each chunk's
text so a chunk stands on its own at recall time. No overlap: heading alignment
replaces it. Vault notes, session roll-ups and `memory_store` writes all
benefit without per-source rules. The sentence layer and its dedup stay as they are.
A forced rebuild (`rebuild` operation → `reindexAll(force)`) runs on baker-pro straight
after deploy, so the whole vault is on the new chunker at once; new writes pick it up
immediately.

## Affected users and systems
Keith, via `memory_recall` from every harness. `src/memory-daemon` only: `index/chunk.ts`,
`index/indexer.ts`, `test/chunk.test.ts`, daemon `package.json`. Deploy target
baker-pro (daemon from `dist/`, launchd), then one forced rebuild of `<vault>/.index`.
No backend, frontend, iOS or schema change.

## Constraints
- No new dependency. Chonkie's TypeScript core was evaluated during the spec (D1 in
  `project_docs/design/2026-09-15-markdown-aware-chunker.md`): it has no markdown recipe,
  its rules cannot express heading splits, and it pulls in an async WASM module. The
  heading walk and section sizing are ~100 lines of plain TypeScript in `chunk.ts`.
  Any later change to chunk boundaries needs a forced rebuild, because they feed `seg_hash`.
- Keep the 180-word hard cap as the ubatch guard: any chunk still over it after the
  recursive split is windowed as today. The existing test stays green.
- Sentence splitting, FNV dedup, `seg_hash` embedding cache and `deep_index` jobs are
  untouched; only chunk boundaries and chunk text change.
- No semantic chunking in this change (doubles embed calls at ingest); a later intent
  can add it via the existing `ModelClient.embed`.
- Meeting-notes ingestion is out of scope; nothing ingests them today and that is a
  separate intent.
- The index is disposable: the change must work from a clean `.index` and from a
  forced rebuild over the live vault.

## Open questions
None. Title plus heading path, no overlap, and rebuild straight after deploy were
decided 2026-09-15.
