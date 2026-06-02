# NEXUS

A personal agent orchestration platform. NEXUS lets you define projects, break them into tasks on a Kanban board, and assign specialized AI agents to work those tasks — including spawning Claude Code and Codex as sub-agents. Memory persists across sessions via a local memory store synced to an Obsidian vault.

> NEXUS is not another bloated Agent OS. It's the control layer that makes your existing tools (Claude Code, Codex, OpenRouter, local models) work together the way you want.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Concepts](#concepts)
  - [Projects](#projects)
  - [Tasks & Kanban](#tasks--kanban)
  - [Personas](#personas)
  - [Orchestrator](#orchestrator)
  - [Memory](#memory)
  - [Chat](#chat)
  - [Scheduler](#scheduler)
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
| **Multi-provider agents** | Spawns Claude Code & Codex as CLI subprocesses; calls OpenRouter and any local OpenAI-compatible server (omlx, LM Studio, …) over HTTP. |
| **Personas** | YAML-defined agent personalities. Assign different models to coding, review, deploy, etc. |
| **Memory** | Hybrid-retrieval memory served by a standalone daemon. The Obsidian vault is canonical; a rebuildable SQLite index (sqlite-vec + FTS5) powers recall. Auto-injected into agent context; exposed over HTTP + MCP. |
| **Chat** | Per-project conversational interface with file drag-and-drop and 48-hour archival to Obsidian. |
| **Scheduler** | Built-in cron for recurring tasks (daily digests, weekly reviews, etc.). |
| **Token usage** | Per-run token tracking (exact for API providers, estimated for CLI) with a project-scoped Usage view. |
| **Settings** | In-app editor for `~/.nexus/config.yaml` — API keys, models, memory budget, scheduler toggle. |

---

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                      Electron                          │
│  ┌──────────────────────────────────────────────────┐ │
│  │              React Dashboard (Vite)               │ │
│  │   Kanban | Chat | Scheduler | Personas | Memory   │ │
│  └────────────────────┬─────────────────────────────┘ │
│                       │ HTTP (localhost:4173)          │
│  ┌────────────────────▼─────────────────────────────┐ │
│  │                Node.js Backend (Fastify)          │ │
│  │                                                    │ │
│  │   Routes ── Orchestrator ── Scheduler ── Memory   │ │
│  └──┬──────────┬──────────────┬──────────────┬──────┘ │
│     │          │              │              │         │
│  SQLite     Sub-agent     Memory client  Local models │
│ (nexus.db)  spawner       → daemon       (4001/2/3)    │
│             ├ claude (CLI)   (HTTP :4100)               │
│             ├ codex  (CLI)                              │
│             ├ openrouter (HTTP)                         │
│             └ local (HTTP, OpenAI-compatible)           │
└───────────────────────────────────────────────────────┘
```

The backend runs the Fastify HTTP API, the orchestrator polling loop, and the scheduler loop in a single Node process. **Memory is a separate concern**: a standalone `@nexus/memory-daemon` (its own process, port 4100) owns the canonical Obsidian vault, its file watcher, and the rebuildable SQLite index — the Nexus backend talks to it over HTTP (and OpenClaw's CLI agents reach it over MCP). Nexus's own `nexus.db` holds projects/tasks/chats; memory lives in the daemon's index, not `nexus.db`. The frontend is a React SPA served by Vite in dev and bundled into the Electron app for production.

### Packages

| Path | Package | Role |
|---|---|---|
| `src/shared` | `@nexus/shared` | Shared TypeScript types and constants |
| `src/backend` | `@nexus/backend` | Fastify API, orchestrator, scheduler |
| `src/memory-daemon` | `@nexus/memory-daemon` | Standalone memory daemon (vault + index + retrieval), HTTP :4100 + MCP |
| `src/frontend` | `@nexus/frontend` | React dashboard |
| `electron` | `nexus-electron` | Electron shell that boots the backend + loads the UI |

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 20
- **Claude Code CLI** (`claude`) — for the Developer persona ([install](https://docs.claude.com/claude-code))
- **Codex CLI** (`codex`) — for the Reviewer persona (optional)
- **A local OpenAI-compatible LLM server** — for local/cron tasks (optional). On Apple Silicon, [omlx](https://github.com/jundot/omlx) is recommended (one server for chat, embeddings, and reranking); LM Studio or llama.cpp's server work too.
- **OpenRouter API key** — for the Generalist persona and chat ([get one](https://openrouter.ai/keys))

### Install

```bash
cd nexus
npm install
# install per-package deps
(cd src/backend && npm install)
(cd src/frontend && npm install)
(cd electron && npm install)
```

### Set your API keys

```bash
export OPENROUTER_API_KEY="sk-or-..."   # for OpenRouter agents + chat
export OMLX_API_KEY="..."               # for the local model server (if it requires auth, e.g. omlx)
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
- The daemon runs without file-watch here; if you're editing daemon code and want auto-reload, run
  it separately with `npm --prefix src/memory-daemon run dev`.
- The **Hermes** agent (a remote OpenAI-compatible agent over Tailscale) reads its API key from the
  `HERMES_API_KEY` environment variable — `export HERMES_API_KEY=…` in the backend's environment
  before launching, or it'll report offline / fail to dispatch. The key is never stored in git.

### Run in dev (manual, three terminals)

```bash
# Terminal 1 — memory daemon (vault + index + retrieval, HTTP :4100).
# Required for memory features; the backend degrades gracefully if it's down.
# Better yet, run it as a LaunchD agent — see src/memory-daemon/README.md.
cd src/memory-daemon && npm install --no-workspaces && npm start

# Terminal 2 — backend (Fastify on :4173, orchestrator, scheduler)
cd src/backend && npm run dev

# Terminal 3 — frontend (Vite on :5173)
cd src/frontend && npm run dev
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

On first run, NEXUS creates `~/.nexus/` with default config, four starter personas, an Obsidian vault, and the SQLite database.

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
├── obsidian/            # Obsidian vault (memory + archives)
│   ├── Projects/<slug>/{Tasks,Chats,Memory,Specs}/
│   ├── Memories/
│   └── Templates/
├── nexus.db             # SQLite database
└── logs/                # Application logs
```

### `config.yaml`

```yaml
server:
  port: 4173

models:
  openrouter:
    api_key: "${OPENROUTER_API_KEY}"   # env var interpolation
  local:                               # OpenAI-compatible server(s) for chat / cron personas
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
  vault_path: "~/Obsidian/Nexus"       # canonical markdown vault (visible to Obsidian's vault picker)
  models:                              # local llama stack, loopback only
    gen_url:    "http://127.0.0.1:4001/v1"   # 9B — HyDE + KG triple extraction
    embed_url:  "http://127.0.0.1:4002/v1"   # nomic-embed-text-v1.5 (768-dim)
    rerank_url: "http://127.0.0.1:4003/v1"   # Qwen3-Reranker-0.6B
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
  model: "openrouter/anthropic/claude-sonnet-4"
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

### Personas

Personas are agent personalities defined as YAML files in `~/.nexus/personas/`. Each specifies which provider/model to use, a system prompt, allowed tools, workspace path, and token budget.

```yaml
name: Code Reviewer
slug: reviewer
provider: codex          # claude_code | codex | openrouter | local
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

Four personas ship by default: **Developer** (Claude Code), **Reviewer** (Codex), **Generalist** (OpenRouter), **Cron Runner** (local model server). Edit them via the Personas page or directly as YAML.

**Column-Agent Mapping**: Each project can map a default persona to each Kanban column (e.g. the Review column defaults to "Reviewer"). Configure this from the panel below the Kanban board.

### Orchestrator

The orchestrator is a background loop (polls every 5s) that:

1. Finds tasks in **In Progress** that don't already have a running agent.
2. Resolves the persona (explicit `assigned_agent` → column default → `generalist`).
3. Builds a prompt containing: persona system prompt, project name/description, task details, the `project_docs/` file index, other tasks in the project, and relevant memories.
4. Dispatches to the persona's provider:
   - **claude_code** / **codex** → spawned as CLI subprocesses (5-minute timeout).
   - **openrouter** / **local** → called over HTTP (OpenAI-compatible chat completions).
5. Streams output to `~/.nexus/workspaces/<slug>/outputs/<task-id>.log`.
6. On success → advances the task to the next column and extracts key insights into memory. On failure → moves the task back to Triage.

Every run is recorded in the `agent_runs` table. See live status at `GET /api/agents/status`.

### Memory

Memory is served by the standalone **`@nexus/memory-daemon`** (`src/memory-daemon/`, port 4100) — a separate process shared by Nexus (over HTTP) and OpenClaw's CLI agents (over MCP). The Nexus backend's memory module is a thin client (`MemoryClient`) to that daemon.

- **Markdown is canonical**: every memory is a markdown file with YAML frontmatter (incl. a stable ULID `id`) in the Obsidian vault. The SQLite index (sqlite-vec vectors + FTS5 + a knowledge-graph `facts` table) is **disposable and rebuildable** from the vault at any time — there is no precious index to lose. A `chokidar` watcher picks up external edits (last-writer-wins; loop-suppressed against the daemon's own writes).
- **Hybrid retrieval**: optional HyDE (via the 9B on 4001) → sentence + chunk vector KNN (nomic-embed, 4002) fused with FTS5 prefix search by Reciprocal Rank Fusion → cross-encoder rerank (Qwen3-Reranker, 4003) → surgical sentence trimming + small-to-big parent-chunk expansion, capped to a token budget. Degrades gracefully to FTS-only if the model stack is down.
- **Knowledge graph**: subject-relation-object triples are extracted per memory (9B, strict JSON, fixed vocabulary) and fused into recall as related facts. Additive — extraction failure never breaks retrieval.
- **Auto-injection**: before an agent runs, the top relevance-ranked memories are injected within a configurable token budget (`memory.auto_inject`).
- **Extraction**: after an agent completes, decision/insight sentences plus a run summary are saved as new memories.

Namespaces: `nexus` (per project), `openclaw`, `global`. Categories: `general`, `decision`, `chat`, `agent_run`, `specs`. See `src/memory-daemon/README.md` for the HTTP/MCP surface and ops.

### Chat

Each project has a chat interface:

- Pick which persona/model powers the conversation.
- Drag-and-drop files onto the composer — they land in `project_docs/uploads/` and are referenced in context.
- Relevant memories and the `project_docs/` index are injected into the system prompt.
- Conversations older than **48 hours** are auto-archived as markdown to the Obsidian vault, then purged from the hot SQLite store.

### Scheduler

A built-in cron engine (checks every 60s) for recurring work:

- Standard 5-field cron expressions (`minute hour day-of-month month day-of-week`) with support for `*`, lists, ranges, and steps.
- When a schedule is due, it creates a task directly in **In Progress** so the orchestrator picks it up.
- Defaults new tasks to the **Cron Runner** (local model) persona, configurable per schedule.
- Manage schedules from the Scheduler tab: presets, enable/disable, next/last run times.

Example: *"Every weekday at 9 AM, generate a standup digest for this project."* → `0 9 * * 1-5`.

---

## Model Routing

| Task Type | Provider | Method | Default Persona |
|---|---|---|---|
| Coding | Claude Code | CLI subprocess | Developer |
| Code Review | Codex | CLI subprocess | Reviewer |
| General / Marketing / Media | OpenRouter | HTTP API | Generalist |
| Cron / Menial | Local server (omlx, …) | HTTP API (OpenAI-compatible) | Cron Runner |

Spawning Claude Code and Codex as **CLI subprocesses** (rather than calling their APIs) is deliberate — it lets you use them as standalone tools and sidesteps subscription-in-harness restrictions.

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
| POST | `/api/threads/:threadId/archive` | Archive a thread |

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

### Agents
| Method | Path | Description |
|---|---|---|
| GET | `/api/agents/status` | Running + recent agent runs (with provider, model, tokens, duration) |
| GET | `/api/agents/runs/:taskId` | Run history for a task |
| GET | `/api/agents/usage` | Aggregate token usage (`?projectId=` to scope); totals + breakdown by provider |

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
├── package.json                 # Root workspace
├── electron/
│   ├── main.ts                  # Electron entry: boots backend + window
│   └── preload.js
├── src/
│   ├── shared/
│   │   └── index.ts             # All shared types & constants
│   ├── backend/
│   │   ├── index.ts             # Fastify server bootstrap
│   │   ├── config.ts            # ~/.nexus config + default personas
│   │   ├── db.ts                # SQLite schema + migrations
│   │   ├── routes/              # HTTP route handlers
│   │   │   ├── projects.ts
│   │   │   ├── chat.ts
│   │   │   ├── personas.ts
│   │   │   ├── memory.ts
│   │   │   ├── schedules.ts
│   │   │   └── orchestrator.ts
│   │   ├── orchestrator/
│   │   │   ├── index.ts         # Polling loop + dispatch
│   │   │   ├── providers.ts     # Claude Code / Codex / OpenRouter / local (OpenAI-compatible)
│   │   │   └── context.ts       # Prompt builder + memory injection
│   │   ├── memory/
│   │   │   └── client.ts        # thin HTTP client to @nexus/memory-daemon (:4100)
│   │   └── scheduler/
│   │       ├── index.ts         # Scheduler loop
│   │       └── cron.ts          # Cron parser + next-run calc
│   └── frontend/
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api.ts           # Typed API client
│           └── components/      # Sidebar, KanbanBoard, ChatPanel, etc.
```

---

## Development

### Build everything

```bash
# from nexus/
(cd src/shared && npx tsc)
(cd src/backend && npx tsc)
(cd src/frontend && npx vite build)
(cd electron && npx tsc)
```

### Type-check

```bash
(cd src/backend && npx tsc --noEmit)
(cd src/frontend && npx tsc --noEmit)
```

### Database

SQLite at `~/.nexus/nexus.db`. Schema and migrations live in `src/backend/db.ts`. New columns are added via guarded `ALTER TABLE` checks so existing databases upgrade cleanly. To reset, delete `nexus.db*` and restart the backend.

### Tables

`projects`, `tasks`, `personas`, `schedules`, `chat_threads`, `chat_messages`, `memories`, `agent_runs`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chat replies "Config needed" | Set `OPENROUTER_API_KEY` in your environment and restart the backend. |
| `no such column` SQLite error | An old DB predates a schema change. Migrations handle most cases; if needed, delete `~/.nexus/nexus.db*` and restart. |
| Claude Code task fails instantly | Ensure the `claude` CLI is installed and on your `PATH`. Check `~/.nexus/workspaces/<slug>/outputs/<task-id>.log`. |
| Local model tasks fail | Confirm your local server is running and reachable at `models.local.base_url` (e.g. `http://localhost:8000/v1`), and that the persona's `model` matches a loaded model name (check `GET {base_url}/models`). |
| Agent never picks up a task | The task must be in **In Progress**. Check `GET /api/agents/status` and the backend console logs. |
| Tailwind build warning | The `content option missing` warning under Vite 6 is benign; styles use direct Tailwind palette classes. |

---

## License

Personal project — not licensed for redistribution.
