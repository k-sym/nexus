# Intent: Sane fallback titles for memories without a heading
Author: Keith. Status: accepted. Source: 2026-09-15 conversation, seen after the PR #479 rebuild.

## Problem
`deriveTitle` in `src/memory-daemon/src/sync/ingest.ts:19-25` runs when a note has no
frontmatter `title:`. It takes the first `# ` line anywhere in the body (the regex is
`/^\s*#\s+(.+)$/m`, unanchored to the top and blind to code fences), else the first
non-blank line cut at 120 characters, else the filename. Since PR #479 that title is the
first breadcrumb entry on every chunk, so the fallback is now embedded and shown at recall.
Live index, 2026-09-15: 31 of 389 memories have no frontmatter title and depend on this fallback; the worst are legacy
session archives (July 2026, before the archive writer passed a title) whose first line is
`**Project:** Nexus` or `**Session Summary: …**`, and an agent-run note whose title is a
markdown table row. Two July archives share the identical title `**Project:** Nexus`, so
their chunks are indistinguishable by breadcrumb.

## Proposed outcome
A memory with no explicit title gets a title that names it: markdown syntax stripped
(bold, list markers, table pipes, backticks), a `Key: value` first line reduced to its
value or skipped for the next line, and the H1 match limited to headings outside fences.
Legacy archives resolve to something like `Nexus — Change Active Project Status Badge Color`
from their `**Session:**` line, matching what the archive writer emits today. Titles are
re-derived on a forced rebuild, so the fix reaches existing notes without touching their
markdown.

## Affected users and systems
Keith via `memory_recall` breadcrumbs and the memory list in Settings; `src/memory-daemon`
only (`sync/ingest.ts`, a unit test beside `chunk.test.ts`). Deploy target baker-pro, then
one forced rebuild.

## Constraints
- Frontmatter `title:` still wins outright; no vault file is rewritten.
- Filename fallback stays last; ULID filenames are never a "good" title but never wrong.
- Titles are FTS-indexed and shown in the UI: keep them one line, ≤120 chars, no markdown.
- No schema, config or route change. Any title change alters chunk `seg_hash`, so this
  ships with a forced rebuild like PR #479.

## Open questions
None. Generic markdown stripping plus key-value skipping, no dedicated legacy-archive rule
and no UI flag for fallback titles (Keith, 2026-09-15).
