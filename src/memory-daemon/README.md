# @nexus/memory-daemon

Standalone local memory daemon for **Nexus + OpenClaw**. The Obsidian markdown vault is the
**canonical** source of truth; the SQLite index (`sqlite-vec` + FTS5) is **disposable** and
rebuildable from the vault at any time. Retrieval primitives are the local llama stack on
loopback (embed 4002, rerank 4003, gen 4001).

Full architecture: `~/Projects/baker-internal/project_docs/nexus-memory-architecture.md`.

## Status

Daemon complete: skeleton + schema + health, sync engine, indexing + job queue, hybrid
retrieval + recall API, knowledge-graph extraction/fusion, and the MCP server. The Nexus
Electron backend that consumes it (via `MemoryClient`) is not built yet; the actual OpenClaw
vault migration is pending the vault-root decision.

## Requirements

- Node ≥ 20 (verified on **v26**; needs `better-sqlite3@^12` — v11 won't compile on Node 26).
- The llama stack live on 4001/4002/4003 (see `local-model-stack.md`). The daemon degrades to
  FTS-only if the embedder is down.

## Develop / run

```bash
npm install --no-workspaces      # install deps (native build of better-sqlite3)
npm run probe                    # Task-0 native check: vec0 768-dim + FTS5 load
npm start                        # run via tsx (dev)
npm run build                    # tsc -> dist (also copies schema.sql)
npm run typecheck
```

`/health` is served on `http://127.0.0.1:4100/health` and reports model-stack status, memory
count, and job queue depth.

## Tests

```bash
npx tsx scripts/test-sync.ts       # sync invariants (echo/rename/delete/rebuild)
npx tsx scripts/test-index.ts      # indexing, dedup, ghost recovery, dead-letter
npx tsx scripts/test-retrieval.ts  # hybrid recall, scope, trim, degradation, routes
npx tsx scripts/test-kg.ts         # KG extraction + fusion (needs 4001 + 4002)
npx tsx scripts/test-mcp.ts        # MCP tool round-trip (store/recall/list/prune)
```

Each uses a throwaway vault under `$TMPDIR`. Retrieval/KG/MCP tests need the live model stack
(4001/4002/4003).

## HTTP API (`127.0.0.1:4100`)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | daemon + model-stack status, memory/job counts |
| POST | `/memories` | store a memory (`namespace`, `source`, `body` required) |
| GET | `/memories?q=` | hybrid recall; without `q` lists recent (filters: `namespace`, `project`, `category`, `scope`, `limit`) |
| GET | `/memories/:id` | fetch one |
| PUT | `/memories/:id` | update `title`/`body` → rewrite markdown → reindex |
| DELETE | `/memories/:id` | unlink the markdown file + soft-delete |
| POST | `/recall` | injection-ready recall: returns `context` string + items + KG facts |

## MCP (OpenClaw agents)

`npm run build`, then register the stdio server with Claude Code / Codex (daemon must be running):

```bash
claude mcp add nexus-memory -- node /ABS/PATH/nexus/src/memory-daemon/dist/src/mcp/stdio.js
```

or in `.mcp.json`:

```json
{ "mcpServers": { "nexus-memory": {
  "command": "node",
  "args": ["/ABS/PATH/nexus/src/memory-daemon/dist/src/mcp/stdio.js"],
  "env": { "MEMORY_DAEMON_URL": "http://127.0.0.1:4100" }
} } }
```

Tools: `memory_recall`, `memory_search`, `memory_store`, `memory_get`, `memory_list`, `memory_prune`.
The shim talks to the daemon over HTTP, so the daemon stays the single index writer.

## Nexus integration

Nexus's backend imports `MemoryClient` (`src/client.ts`) and proxies its `/api/memory` routes:

| Nexus route | Daemon call |
|---|---|
| `GET /api/projects/:id/memories?q=` | `client.search(q, { namespace:"nexus", project:slug })` |
| `POST /api/projects/:id/memories` | `client.store({ namespace:"nexus", project:slug, source:"nexus", ... })` |
| `PUT /api/memories/:id` | `client.req("PUT", ...)` (update) |
| `DELETE /api/memories/:id` | `client.remove(id)` |
| orchestrator/chat context build | `client.recall(query, filter)` → inject `.context` |

## Config

Reads `~/.nexus/config.yaml` if present (shared with Nexus), else uses defaults. Relevant keys:

```yaml
memory:
  port: 4100
  vault_path: "~/Obsidian/Nexus"    # visible so it's selectable in Obsidian's vault picker
  models:
    gen_url:    "http://127.0.0.1:4001/v1"
    embed_url:  "http://127.0.0.1:4002/v1"
    rerank_url: "http://127.0.0.1:4003/v1"
```

Override the config home with `NEXUS_HOME`.

## Run as a LaunchD agent (always-on)

`npm run build` first (the plist runs compiled `dist/src/index.js`), then:

```bash
# edit the __REPLACE_*__ placeholders in the plist first
cp launchd/com.k-sym.nexus-memory.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.k-sym.nexus-memory.plist
launchctl kickstart -k gui/$(id -u)/com.k-sym.nexus-memory   # restart
launchctl bootout    gui/$(id -u)/com.k-sym.nexus-memory     # stop
```

Logs: `~/Library/Logs/nexus-memory.log`. Convention matches the `com.k-sym.llama-*` agents.

## Layout

```
src/
  config.ts            ~/.nexus/config.yaml loader (env interpolation)
  context.ts           shared runtime context
  server.ts            Fastify (/health; recall/store land in Phase 4)
  index.ts             entry: config -> db -> ghost recovery -> worker -> reindex -> watch -> listen
  db/                  schema.sql + open/migrate, oplog, vec blob helper
  models/client.ts     embed / rerank / complete / health (fail-soft)
  sync/                identity (ULID), hash (sha256 + FNV-1a), writer, ingest, watcher, reindex
  index/               chunk, embed (+embed_cache dedup), fts, indexer
  jobs/                queue (claim/complete/fail), worker, ghost recovery
```
