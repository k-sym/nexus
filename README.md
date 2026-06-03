# NEXUS

A personal agent orchestration platform. NEXUS lets you define projects, break them into tasks on a Kanban board, and assign specialized AI agents to work those tasks — including spawning Claude Code, Codex, and OpenCode as sub-agents. Memory persists across sessions via a local memory daemon synced to an Obsidian vault.

> NEXUS is not another bloated Agent OS. It's the control layer that makes your existing tools (Claude Code, Codex, OpenCode, OpenRouter, local models) work together the way you want.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [The Local Model Stack](#the-local-model-stack)
- [Configuration](#configuration)
- [Concepts](#concepts)
  - [Projects](#projects)
  - [Tasks & Kanban](#tasks--kanban)
  - [Providers](#providers)
  - [Personas](#personas)
  - [Orchestrator](#orchestrator)
  - [Memory](#memory)
  - [Chat](#chat)
  - [Scheduler](#scheduler)
  - [Tickets (Jira mirror)](#tickets-jira-mirror)
  - [Mission Control](#mission-control)
- [Model Routing](#model-routing)
- [API Reference](#api-reference)
- [Project Layout](#project-layout)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## What It Does

| Capability | Description |
|---|---|
| **Projects** | Link existing local git repos. NEXUS adds a `project_docs/` structure for specs, plans, and uploads. |
| **Kanban** | 5-column board (Triage → To Do → In Progress → Review → Deploy) with drag-and-drop. |
| **Orchestrator** | Watches for tasks entering "In Progress" and dispatches them to the right agent automatically. |
| **Providers** | First-class registry of agent backends: Claude Code / Codex / OpenCode (CLI), any OpenAI-compatible HTTP endpoint (OpenRouter, local servers), and remote Hermes agents. CRUD + connectivity test in the UI. |
| **Personas** | YAML-defined agent personalities that bind a provider + model + system prompt + tools. Assign different ones to coding, review, deploy, etc. |
| **Multi-provider agents** | Spawns Claude Code / Codex / OpenCode as CLI subprocesses; calls OpenRouter and any local OpenAI-compatible server (omlx, LM Studio, llama.cpp, …) over HTTP. |
| **Memory** | Hybrid-retrieval memory served by a standalone daemon. The Obsidian vault is canonical; a rebuildable SQLite index (sqlite-vec + FTS5 + knowledge-graph) powers recall. Auto-injected into agent context; exposed over HTTP + MCP. |
| **Chat** | Per-project conversational interface with file drag-and-drop, structured question cards, Claude session capture (resume in-app or in a terminal), and 48-hour archival to Obsidian. |
| **Scheduler** | Built-in cron for recurring tasks (daily digests, weekly reviews, etc.). |
| **Tickets** | A disposable mirror of Jira tickets assigned to you (Jira stays canonical), pushed in via a sync endpoint. |
| **Mission Control** | A single dashboard aggregating daemon health, the agent roster with per-provider health, scheduler status, and an activity feed. |
| **Token usage** | Per-run token tracking (exact for API providers, estimated for CLI) with a project-scoped Usage view. |
| **Settings** | In-app editor for `~/.nexus/config.yaml` — API keys, models, memory budget, scheduler toggle. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Electron                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │               React Dashboard (Vite)                │ │
│  │  Mission Control | Kanban | Chat | Scheduler |      │ │
│  │  Personas | Providers | Memory | Tickets | Usage    │ │
│  └─────────────────────┬──────────────────────────────┘ │
│                        │ HTTP (localhost:4173)           │
│  ┌─────────────────────▼──────────────────────────────┐ │
│  │               Node.js Backend (Fastify)             │ │
│  │                                                      │ │
│  │   Routes ── Orchestrator ── Scheduler ── MemClient  │ │
│  └──┬───────────┬──────────────┬──────────────┬───────┘ │
│     │           │              │              │          │
│  SQLite      Sub-agent     Memory client   HTTP models   │
│ (nexus.db)   spawner       → daemon        (OpenAI-compat)│
│              ├ claude (CLI)   (HTTP :4100)                │
│              ├ codex  (CLI)        │                      │
│              └ opencode (CLI)      ▼                      │
│                          ┌──────────────────────────┐    │
│                          │  @nexus/memory-daemon     │    │
│                          │  Obsidian vault + index   │    │
│                          │  + 3 local llama servers  │    │
│                          │  gen 4001/embed 4002/     │    │
│                          │  rerank 4003              │    │
│                          └──────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

The backend runs the Fastify HTTP API, the orchestrator polling loop, and the scheduler loop in a single Node process. **Memory is a separate concern**: a standalone `@nexus/memory-daemon` (its own process, port 4100) owns the canonical Obsidian vault, its file watcher, and the rebuildable SQLite index — the Nexus backend talks to it over HTTP (and external CLI agents reach it over MCP). The daemon in turn calls a **local model stack of three independent llama-server processes** (generation 4001, embeddings 4002, reranking 4003). Nexus's own `nexus.db` holds projects/tasks/chats/providers/tickets; memory lives in the daemon's index, not `nexus.db`. The frontend is a React SPA served by Vite in dev and bundled into the Electron app for production.

### Packages

| Path | Package | Role |
|---|---|---|
| `src/shared` | `@nexus/shared` | Shared TypeScript types and constants |
| `src/backend` | `@nexus/backend` | Fastify API, orchestrator, scheduler |
| `src/memory-daemon` | `@nexus/memory-daemon` | Standalone memory daemon (vault + index + retrieval), HTTP :4100 + MCP |
| `src/frontend` | `@nexus/frontend` | React dashboard |
| `electron` | `nexus-electron` | Electron shell that boots the services + loads the UI |

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **Claude Code CLI** (`claude`) — for the Developer persona ([install](https://docs.claude.com/claude-code))
- **Codex CLI** (`codex`) — for the Reviewer persona (optional)
- **OpenCode CLI** (`opencode`) — for the OpenCode provider (optional)
- **OpenRouter API key** — for the Generalist persona and chat ([get one](https://openrouter.ai/keys))
- **A local model stack** (optional, for memory + local/cron personas) — three OpenAI-compatible endpoints for generation, embeddings, and reranking. See [The Local Model Stack](#the-local-model-stack) — the launch flags matter.

### Install

```bash
cd nexus
npm install
# install per-package deps
(cd src/backend && npm install)
(cd src/frontend && npm install)
(cd src/memory-daemon && npm install --no-workspaces)
(cd electron && npm install)
```

### Set your API keys

```bash
export OPENROUTER_API_KEY="sk-or-..."   # OpenRouter agents + chat
export OMLX_API_KEY="..."               # local model server, if it requires auth
export HERMES_API_KEY="..."             # remote Hermes agent (if used)
```

### Run in dev (one command)

```bash
npm run web
```

Boots all three services — memory daemon (`:4100`), backend (`:4173`), frontend (`:5173`) —
concurrently (color-prefixed per service), waits until the frontend **and** backend health are up,
then opens your browser to http://localhost:5173.

- **Stop:** `Ctrl-C` in the terminal stops all three cleanly (ports freed, no orphaned processes).
- **Closing the browser does _not_ stop the services** — the script isn't tied to the browser tab,
  so the servers keep running until you `Ctrl-C`. (This differs from the Electron app, where closing
  the window tears the services down.)
- The local llama stack (4001/4002/4003) is **not** managed by this script — start it separately (see below).

### Run in dev (manual, three terminals)

```bash
# Terminal 1 — memory daemon (vault + index + retrieval, HTTP :4100).
# Required for memory features; the backend degrades gracefully if it's down.
npm run dev:daemon          # or: cd src/memory-daemon && npm start

# Terminal 2 — backend (Fastify on :4173, orchestrator, scheduler)
npm run dev:backend         # or: cd src/backend && npm run dev   (tsx watch, live reload)

# Terminal 3 — frontend (Vite on :5173)
npm run dev:frontend        # or: cd src/frontend && npm run dev
```

Open http://localhost:5173

### Run as Electron app

The Electron app is **self-contained**: it brings up the required services itself behind a startup
splash that shows each service's status, then opens the main UI. It probes each port first and
**reuses** anything already running (e.g. a daemon under LaunchD), so it won't double-spawn. If the
local model stack (`4001/4002/4003`) isn't reachable, it shows a non-blocking warning and continues
in degraded (FTS-only) mode. Closing the window stops the services it started.

```bash
# Build everything (shared, backend, frontend, electron, memory daemon)
npm run build

# Production mode: spawns the compiled backend + daemon (under system Node) and
# loads the built frontend from disk — no separate dev servers needed.
NEXUS_ELECTRON_PROD=1 npm run --workspace=electron dev
```

Without `NEXUS_ELECTRON_PROD=1`, an unpackaged Electron launch runs in **dev mode**: it spawns the
Vite dev server, backend, and daemon as dev processes (or reuses them if already up) and loads
`localhost:5173`.

On first run, NEXUS creates `~/.nexus/` with default config, starter personas, a set of default
providers, an Obsidian vault, and the SQLite database.

---

## The Local Model Stack

Memory retrieval (and local/cron personas) rely on **three independent OpenAI-compatible servers** on
loopback. The reference setup runs three `llama-server` (llama.cpp) processes — **and the launch flags
are not optional**. A server can be listening on its port but still reject every request if it wasn't
started in the right mode. (Nexus currently reports such failures as "unreachable" even when the
server is up — see Troubleshooting.)

| Port | Role | Model (example) | Required launch flags |
|---|---|---|---|
| 4001 | generation (HyDE + KG extraction) | a small instruct model (e.g. Qwen3) | `--reasoning off` **if the model is a reasoning/"thinking" model** — otherwise it spends its whole token budget thinking and returns empty content |
| 4002 | embeddings | `nomic-embed-text-v1.5` (768-dim) | `--embedding --pooling mean` |
| 4003 | reranking | `qwen3-reranker-0.6b` | `--reranking` |

Example (embeddings server):

```bash
llama-server --model ~/Models/nomic-embed-text-v1.5.f16.gguf \
  --port 4002 --host 127.0.0.1 --n-gpu-layers 99 --ctx-size 8192 \
  --embedding --pooling mean
```

If you'd rather run a single OpenAI-compatible server (omlx, LM Studio, …) for everything, point the
`memory.models.*_url` values at it — but it must genuinely implement `/v1/embeddings` and `/v1/rerank`,
not just `/v1/chat/completions`. Without a working embeddings + rerank endpoint, recall falls back to
FTS-only and `deep_index` jobs dead-letter.

---

## Configuration

All config lives under `~/.nexus/`:

```
~/.nexus/
├── config.yaml          # Global settings
├── personas/            # Agent YAML configs (one file per persona)
│   ├── developer.yaml
│   ├── reviewer.yaml
│   ├── generalist.yaml
│   └── cron-runner.yaml
├── workspaces/          # Per-project agent output logs
│   └── <project-slug>/outputs/<task-id>.log
├── nexus.db             # SQLite database (projects/tasks/chats/providers/tickets)
└── logs/                # Application logs
```

The Obsidian vault (canonical memory + chat archives) defaults to `~/Obsidian/Nexus/` so it's visible
to Obsidian's vault picker. The daemon's rebuildable memory index lives **inside the vault** at
`<vault>/.index/nexus-memory.db` (default `~/Obsidian/Nexus/.index/`), not under `~/.nexus/`.

### `config.yaml`

```yaml
server:
  port: 4173

models:
  openrouter:
    api_key: "${OPENROUTER_API_KEY}"   # env var interpolation
  local:                               # OpenAI-compatible server for chat / cron personas
    base_url: "http://127.0.0.1:4001/v1"
    api_key: "${OMLX_API_KEY}"         # if your server requires auth; env interpolation supported

# Memory is served by the standalone @nexus/memory-daemon (separate process, see
# src/memory-daemon/). The Obsidian vault is canonical; the SQLite index is rebuildable.
# This `memory:` block is shared: the Nexus backend reads `daemon_url` + `auto_inject`;
# the daemon reads `port`/`vault_path`/`models`/`retrieval` (all optional — it defaults
# them, so a minimal config only needs daemon_url + auto_inject).
memory:
  daemon_url: "http://127.0.0.1:4100"  # Nexus backend -> daemon (HTTP)
  auto_inject:
    enabled: true
    max_memories: 5            # top N memories injected into agent context
    token_budget: 1000         # hard cap on injected memory tokens
  # --- daemon's own settings (optional; defaults shown) ---
  port: 4100
  vault_path: "~/Obsidian/Nexus"       # canonical markdown vault
  models:                              # local llama stack, loopback only (see "The Local Model Stack")
    gen_url:    "http://127.0.0.1:4001/v1"   # HyDE + KG triple extraction
    embed_url:  "http://127.0.0.1:4002/v1"   # nomic-embed-text-v1.5 (768-dim)
    rerank_url: "http://127.0.0.1:4003/v1"   # qwen3-reranker-0.6b
  retrieval:
    hyde: true
    sentence_threshold: 0.05   # cross-encoder noise floor for sentence trimming
    token_budget: 1500         # cap on assembled recall context

scheduler:
  enabled: true
  check_interval_seconds: 60

claude_code:
  command: "claude"
  args: []                       # extra CLI flags; the prompt is passed via -p

codex:
  command: "codex"
  args: []

chat:
  hot_storage_hours: 48          # archive chats older than this to Obsidian
  archive_path: "Projects/{project_slug}/Chats"
```

Environment variables are interpolated with `${VAR}` syntax. The OpenRouter key is read from `OPENROUTER_API_KEY` (or `OPENROUTING_API_KEY`).

---

## Concepts

### Projects

A project links to an **existing local directory** (typically under `~/Projects/`). NEXUS does not clone repos — you point it at a repo you already have. On registration it creates:

```
<your-repo>/project_docs/
├── specs/      # specifications, tech specs
├── plans/      # project plans, roadmaps
└── uploads/    # files dragged into chat for agent review
```

### Tasks & Kanban

Tasks flow through five columns:

```
Triage → To Do → In Progress → Review → Deploy
```

There is no "Done" column — once a task reaches **Deploy** it's considered complete. Each task has a title, description, priority (low/medium/high/urgent), optional assigned agent, and tags.

Moving a task into **In Progress** triggers the orchestrator.

### Providers

A **Provider** is a reusable agent backend, stored in the `providers` table and managed from the
Providers settings page (CRUD + a connectivity **Test** button). Each provider has a `kind`:

| Kind | Transport | Examples |
|---|---|---|
| `claude_code` | CLI subprocess | the `claude` binary |
| `codex` | CLI subprocess | the `codex` binary |
| `opencode` | CLI subprocess | the `opencode` binary |
| `openai_compat` | HTTP (OpenAI-compatible) | OpenRouter, omlx, LM Studio, llama.cpp |
| `hermes` | HTTP (remote OpenAI-compatible) | a remote Hermes agent over Tailscale |

A fresh database seeds a default set of providers (OpenRouter, a local server, Claude Code, Codex,
OpenCode, and Hermes). Personas bind to a provider via `provider_id`; a legacy `provider:` enum
(`claude_code | codex | openrouter | local | ollama`) is still honored as a fallback.

### Personas

Personas are agent personalities defined as YAML files in `~/.nexus/personas/`. Each binds a
provider + model, a system prompt, allowed tools, a workspace path, and a token budget.

```yaml
name: Code Reviewer
slug: reviewer
provider_id: <provider-uuid>   # preferred: references a Provider record
provider: codex                # legacy fallback: claude_code | codex | openrouter | local
model: codex-default
system_prompt: |
  You are a senior code reviewer. Focus on correctness,
  security, and maintainability.
tools: [read_file, list_files, run_command]
workspace: "~/Projects/{project}"
startup_scripts:
  - git fetch origin
token_budget: 3000
```

Four starter personas ship by default: **Developer** (Claude Code), **Reviewer** (Codex),
**Generalist** (OpenRouter), **Cron Runner** (local model). A **Hermes** persona/provider is also
seeded for remote agents. Edit them via the Personas page or directly as YAML.

**Column-Agent Mapping**: Each project can map a default persona to each Kanban column (e.g. the Review column defaults to "Reviewer"). Configure this from the panel below the Kanban board.

### Orchestrator

The orchestrator is a background loop (polls every 5s) that:

1. Finds tasks in **In Progress** that don't already have a running agent.
2. Resolves the persona (explicit `assigned_agent` → column default → `generalist`).
3. Builds a prompt containing: persona system prompt, project name/description, task details, the `project_docs/` file index, other tasks in the project, and relevant memories.
4. Dispatches to the persona's provider:
   - **claude_code** / **codex** / **opencode** → spawned as CLI subprocesses (5-minute timeout).
   - **openai_compat** / **hermes** (and legacy **openrouter** / **local**) → called over HTTP (OpenAI-compatible chat completions).
5. Streams output to `~/.nexus/workspaces/<slug>/outputs/<task-id>.log`.
6. On success → advances the task to the next column and extracts key insights into memory. On failure → moves the task back to Triage.

Every run is recorded in the `agent_runs` table. See live status at `GET /api/agents/status`.

### Memory

Memory is served by the standalone **`@nexus/memory-daemon`** (`src/memory-daemon/`, port 4100) — a separate process shared by Nexus (over HTTP) and external CLI agents (over MCP). The Nexus backend's memory module is a thin client (`MemoryClient`) to that daemon.

- **Markdown is canonical**: every memory is a markdown file with YAML frontmatter (incl. a stable ULID `id`) in the Obsidian vault. The SQLite index (sqlite-vec vectors + FTS5 + a knowledge-graph `facts` table) is **disposable and rebuildable** from the vault at any time. A `chokidar` watcher picks up external edits (last-writer-wins; loop-suppressed against the daemon's own writes).
- **Hybrid retrieval**: optional HyDE (gen model on 4001) → sentence + chunk vector KNN (nomic-embed, 4002) fused with FTS5 prefix search by Reciprocal Rank Fusion → cross-encoder rerank (qwen3-reranker, 4003) → surgical sentence trimming + small-to-big parent-chunk expansion, capped to a token budget. Degrades gracefully to FTS-only if the model stack is down.
- **Knowledge graph**: subject-relation-object triples are extracted per memory (gen model, strict JSON) and fused into recall as related facts. Additive — extraction failure never breaks retrieval.
- **Background jobs**: ingestion enqueues `deep_index` (embeddings) and `extract_kg` (knowledge graph) jobs. Jobs retry with backoff and **dead-letter after 5 attempts**; dead jobs do not auto-retry (see Troubleshooting).
- **Auto-injection**: before an agent runs, the top relevance-ranked memories are injected within a configurable token budget (`memory.auto_inject`).

Namespaces: `nexus` (per project), `global`, plus external agent namespaces. See `src/memory-daemon/README.md` for the HTTP/MCP surface and ops.

### Chat

Each project has a chat interface:

- Pick which persona/provider powers the conversation.
- Drag-and-drop files onto the composer — they land in `project_docs/uploads/` and are referenced in context.
- Relevant memories are recalled and injected into the prompt; each Q&A is archived to memory (best-effort).
- **Question cards**: when an agent emits an ` ```ask ``` ` block, it renders as a structured question card (single/multi/custom answers); your reply is fed back as the next turn (`POST /api/threads/:threadId/answer`).
- **Claude session capture & resume**: Claude Code turns run with `--output-format json`, so Nexus captures the resumable `session_id` per thread. A chip under the chat header lets you **copy** `claude --resume <id>` or **open a macOS Terminal** already resumed into that session — useful if a turn stalls. In-app turns also continue the same session (`--resume`), so the thread is one continuous conversation shared with the terminal. (One writer at a time — hand off, don't drive both at once.)
- Conversations older than **48 hours** are auto-archived as markdown to the Obsidian vault, then purged from the hot SQLite store.

### Scheduler

A built-in cron engine (checks every 60s) for recurring work:

- Standard 5-field cron expressions (`minute hour day-of-month month day-of-week`) with support for `*`, lists, ranges, and steps.
- When a schedule is due, it creates a task directly in **In Progress** so the orchestrator picks it up.
- Defaults new tasks to the **Cron Runner** (local model) persona, configurable per schedule.
- Manage schedules from the Scheduler tab: presets, enable/disable, next/last run times.

Example: *"Every weekday at 9 AM, generate a standup digest for this project."* → `0 9 * * 1-5`.

### Tickets (Jira mirror)

Nexus keeps a **disposable, read-only mirror** of Jira tickets assigned to you — Jira stays the source
of truth. An external sync agent pushes the current set in via `POST /api/jira/sync`
(`{ tickets, source, replaceAll }` → `{ inserted, updated, removed }`), and the Tickets view lists
them. The mirror lives in the `tickets` table and can be rebuilt at any time by re-syncing.

### Mission Control

The landing dashboard. A single `GET /api/mission-control` call aggregates:

- **Memory daemon health** (reachability + the local model stack's status),
- **Agent roster** — every persona with a per-provider health probe,
- **Scheduler status** — enabled, schedule count, last/next run,
- **Activity feed** — running and recent agent runs.

---

## Model Routing

| Task Type | Provider kind | Method | Default Persona |
|---|---|---|---|
| Coding | Claude Code | CLI subprocess | Developer |
| Code Review | Codex | CLI subprocess | Reviewer |
| Coding (alt) | OpenCode | CLI subprocess | — |
| General / Marketing / Media | OpenRouter (`openai_compat`) | HTTP API | Generalist |
| Cron / Menial | Local server (`openai_compat`) | HTTP API | Cron Runner |
| Remote automation | Hermes | HTTP API | Hermes |

Spawning Claude Code, Codex, and OpenCode as **CLI subprocesses** (rather than calling their APIs) is deliberate — it lets you use them as standalone tools and sidesteps subscription-in-harness restrictions.

---

## API Reference

Base URL: `http://127.0.0.1:4173`

### Projects
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects` | List projects |
| GET | `/api/projects/:id` | Get a project |
| POST | `/api/projects` | Create (body: `name`, `description`, `repo_path`) |
| PUT | `/api/projects/:id` | Update (incl. `config_json` for column mapping) |
| DELETE | `/api/projects/:id` | Delete |

### Tasks
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:id/tasks` | List tasks in a project |
| POST | `/api/projects/:id/tasks` | Create a task |
| PUT | `/api/tasks/:id` | Update (status change triggers orchestrator) |
| DELETE | `/api/tasks/:id` | Delete |

### Providers
| Method | Path | Description |
|---|---|---|
| GET | `/api/providers` | List providers |
| POST | `/api/providers` | Create a provider |
| PUT | `/api/providers/:id` | Update |
| DELETE | `/api/providers/:id` | Delete |
| POST | `/api/providers/:id/test` | Connectivity / health check |

### Personas
| Method | Path | Description |
|---|---|---|
| GET | `/api/personas` | List personas |
| GET | `/api/personas/:slug` | Get full persona config |
| POST | `/api/personas` | Create/update (writes YAML) |
| DELETE | `/api/personas/:slug` | Delete |

### Chat
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:projectId/threads` | List active threads |
| POST | `/api/projects/:projectId/threads` | Create a thread |
| GET | `/api/threads/:threadId/messages` | List messages |
| POST | `/api/threads/:threadId/messages` | Send a message (gets AI reply with memory context) |
| POST | `/api/threads/:threadId/answer` | Submit a reply to a question card |
| PATCH | `/api/threads/:threadId` | Rename a thread |
| POST | `/api/threads/:threadId/archive` | Archive a thread |
| DELETE | `/api/threads/:threadId` | Delete a thread |
| POST | `/api/threads/:threadId/open-terminal` | Open a macOS Terminal resuming the thread's Claude session |

### Memory
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:projectId/memories` | List, or search with `?q=` |
| POST | `/api/projects/:projectId/memories` | Add a memory |
| PUT | `/api/memories/:id` | Update content |
| DELETE | `/api/memories/:id` | Delete |

### Scheduler
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:projectId/schedules` | List schedules |
| POST | `/api/projects/:projectId/schedules` | Create (validates cron) |
| PUT | `/api/schedules/:id` | Update / enable / disable |
| DELETE | `/api/schedules/:id` | Delete |

### Tickets (Jira mirror)
| Method | Path | Description |
|---|---|---|
| GET | `/api/tickets` | List mirrored Jira tickets |
| POST | `/api/jira/sync` | Upsert the mirror (`{ tickets, source, replaceAll }`) |

### Agents
| Method | Path | Description |
|---|---|---|
| GET | `/api/agents/status` | Running + recent agent runs (with provider, model, tokens, duration) |
| GET | `/api/agents/runs/:taskId` | Run history for a task |
| GET | `/api/agents/usage` | Aggregate token usage (`?projectId=` to scope); totals + breakdown by provider |

### Mission Control
| Method | Path | Description |
|---|---|---|
| GET | `/api/mission-control` | Aggregated dashboard: daemon health, agent roster + provider health, scheduler, activity |

### Settings
| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Current config (API key masked) |
| PUT | `/api/settings` | Update config; writes `~/.nexus/config.yaml`. Omit/mask the API key to keep it unchanged |

### Health
| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | `{ status: "ok" }` |

---

## Project Layout

```
nexus/
├── package.json                 # Root workspace (dev / web / build / typecheck scripts)
├── electron/
│   ├── main.ts                  # Electron entry: boots services + window
│   ├── splash.html              # Startup splash (per-service status)
│   └── preload.js
├── src/
│   ├── shared/
│   │   └── index.ts             # All shared types & constants
│   ├── backend/
│   │   ├── index.ts             # Fastify server bootstrap
│   │   ├── config.ts            # ~/.nexus config + default personas/providers
│   │   ├── db.ts                # SQLite schema + migrations
│   │   ├── routes/              # HTTP route handlers
│   │   │   ├── projects.ts
│   │   │   ├── chat.ts
│   │   │   ├── personas.ts
│   │   │   ├── providers.ts
│   │   │   ├── memory.ts
│   │   │   ├── schedules.ts
│   │   │   ├── tickets.ts       # Jira mirror + /jira/sync
│   │   │   ├── status.ts        # /mission-control
│   │   │   └── orchestrator.ts  # /agents/*
│   │   ├── orchestrator/
│   │   │   ├── index.ts         # Polling loop + dispatch
│   │   │   ├── providers.ts     # Claude Code / Codex / OpenCode / OpenAI-compatible
│   │   │   └── context.ts       # Prompt builder + memory injection
│   │   ├── memory/
│   │   │   └── client.ts        # thin HTTP client to @nexus/memory-daemon (:4100)
│   │   └── scheduler/
│   │       ├── index.ts         # Scheduler loop
│   │       └── cron.ts          # Cron parser + next-run calc
│   ├── memory-daemon/           # Standalone memory daemon (own README)
│   └── frontend/
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api.ts           # Typed API client
│           └── components/      # MissionControl, KanbanBoard, ChatPanel,
│                                # ProvidersSettings, PersonasPage, SchedulerPage,
│                                # MemoryView, TicketsView, UsagePage, QuestionCard, …
```

---

## Development

### Build everything

```bash
# from nexus/
npm run build      # shared → backend → frontend → electron + memory daemon
```

### Type-check

```bash
npm run typecheck  # shared + backend + frontend

# Note: the root typecheck does NOT cover the memory daemon or build shared's dist.
# After changing shared types, rebuild its dist so backend/frontend pick them up:
npm --prefix src/shared run build
# And typecheck the daemon separately:
npm --prefix src/memory-daemon run typecheck
```

### Database

SQLite at `~/.nexus/nexus.db`. Schema and migrations live in `src/backend/db.ts`. New columns are added via guarded `ALTER TABLE` checks so existing databases upgrade cleanly. To reset, delete `nexus.db*` and restart the backend. (The memory index is a separate DB at `<vault>/.index/nexus-memory.db` — default `~/Obsidian/Nexus/.index/` — owned by the daemon and rebuildable from the vault.)

### Tables

`projects`, `tasks`, `personas`, `providers`, `schedules`, `chat_threads`, `chat_messages`, `agent_runs`, `tickets`.

(There is no `memories` table — memory lives in the daemon's own index, not `nexus.db`.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat replies "Config needed" | Set `OPENROUTER_API_KEY` in your environment and restart the backend. |
| `no such column` SQLite error | An old DB predates a schema change. Migrations handle most cases; if needed, delete `~/.nexus/nexus.db*` and restart. |
| Claude Code task fails instantly | Ensure the `claude` CLI is installed and on your `PATH`. Check `~/.nexus/workspaces/<slug>/outputs/<task-id>.log`. |
| `N memory job(s) failed (dead-lettered)` / `embedder unreachable` | Almost always the local model stack is misconfigured, **not** down. A `llama-server` can be listening but return `501` for `/v1/embeddings` or `/v1/rerank` if it wasn't started with the right flags. Launch embeddings with `--embedding --pooling mean` (:4002) and rerank with `--reranking` (:4003). Confirm with `curl -s -X POST http://127.0.0.1:4002/v1/embeddings -d '{"input":"hi","model":"..."}'` returns 200. Dead jobs do **not** auto-retry — requeue them once the stack is fixed. |
| KG extraction dead-letters / gen returns empty content | Your generation model (:4001) is a reasoning/"thinking" model burning its whole token budget on hidden reasoning. Relaunch it with `--reasoning off`, or use a non-reasoning model. |
| A model server shows green but recall is empty | A port ping isn't a capability check — verify `/v1/embeddings` and `/v1/rerank` actually return 200 (see above). |
| Local model tasks fail | Confirm your local server is running and reachable at `models.local.base_url`, and that the persona's `model` matches a loaded model name (check `GET {base_url}/models`). |
| Agent never picks up a task | The task must be in **In Progress**. Check `GET /api/agents/status` and the backend console logs. |
| Hermes agent offline | Export `HERMES_API_KEY` in the backend's environment before launching; the key is never stored in git. |

---

## License

Personal project — not licensed for redistribution.
