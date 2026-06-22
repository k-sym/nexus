# NEXUS

A personal agent orchestration platform. NEXUS lets you define projects, break them into tasks on a Kanban board, and assign specialized AI agents to work those tasks — including spawning Claude Code, Codex, and OpenCode as sub-agents. Memory persists across sessions via a local memory daemon synced to an Obsidian vault.

> NEXUS is not another bloated Agent OS. It's the control layer that makes your existing tools (Claude Code, Codex, OpenCode, OpenRouter, local models) work together the way you want.

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture](#architecture)
- [Trust and Privacy](#trust-and-privacy)
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
  - [Sessions](#sessions)
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
| **Sessions** | Per-project conversational interface with live token streaming, file drag-and-drop, structured question cards, Claude session capture (resume in-app or in a terminal), and manual archival into memory. |
| **Tickets** | A disposable mirror of Jira tickets assigned to you (Jira stays canonical). Nexus pulls them natively on a poll loop while the app is running (configured in Settings; token via `JIRA_TOKEN`), and a push endpoint stays for external sync agents. |
| **Notifications** | In-app toasts for events that happen while you're using Nexus — e.g. a Jira sync that changed tickets, or a sync failure. Backed by a `notifications` table the frontend polls. |
| **Mission Control** | A single dashboard aggregating daemon health, the agent roster with per-provider health, and an activity feed. |
| **Token usage** | Per-run token tracking (exact for API providers, estimated for CLI) with a project-scoped Usage view. |
| **Settings** | In-app editor for `~/.nexus/config.yaml` — API keys, models, memory budget, and Jira sync. |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Electron                           │
│  ┌────────────────────────────────────────────────────┐ │
│  │               React Dashboard (Vite)                │ │
│  │  Mission Control | Kanban | Sessions | Tickets |    │ │
│  │  Personas | Providers | Memory | Tickets | Usage    │ │
│  └─────────────────────┬──────────────────────────────┘ │
│                        │ HTTP (localhost:4173)           │
│  ┌─────────────────────▼──────────────────────────────┐ │
│  │               Node.js Backend (Fastify)             │ │
│  │                                                      │ │
│  │   Routes ── Orchestrator ── Jira Poll ── MemClient  │ │
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

The backend runs the Fastify HTTP API, the orchestrator polling loop, and the Jira polling loop in a single Node process. **Memory is a separate concern**: a standalone `@nexus/memory-daemon` (its own process, port 4100) owns the canonical Obsidian vault, its file watcher, and the rebuildable SQLite index — the Nexus backend talks to it over HTTP (and external CLI agents reach it over MCP). The daemon in turn calls a **local model stack of three independent llama-server processes** (generation 4001, embeddings 4002, reranking 4003). Nexus's own `nexus.db` holds projects/tasks/sessions/providers/tickets; memory lives in the daemon's index, not `nexus.db`. The frontend is a React SPA served by Vite in dev and bundled into the Electron app for production.

### Packages

| Path | Package | Role |
|---|---|---|
| `src/shared` | `@nexus/shared` | Shared TypeScript types and constants |
| `src/backend` | `@nexus/backend` | Fastify API, orchestrator, Jira polling |
| `src/memory-daemon` | `@nexus/memory-daemon` | Standalone memory daemon (vault + index + retrieval), HTTP :4100 + MCP |
| `src/frontend` | `@nexus/frontend` | React dashboard |
| `electron` | `nexus-electron` | Electron shell that boots the services + loads the UI |

---

## Trust and Privacy

Nexus has no application analytics or telemetry integration. Its backend and memory daemon listen on loopback by default, and the packaged app bundles the frontend rather than exposing a frontend server. In development, Vite also listens on port `5173`. Configured model, assistant, Jira, and GitHub providers still receive the requests required to perform their service; their own privacy and telemetry policies apply.

### Local services and storage

| Component or data | Default location | Boundary |
|---|---|---|
| Backend API | `127.0.0.1:4173` | Local Fastify service; owns application workflows and `nexus.db` |
| Memory daemon | `127.0.0.1:4100` | Local vault/index owner; backend and MCP clients call it over HTTP |
| Frontend dev server | `127.0.0.1:5173` | Development only; production assets are bundled into Electron |
| Local generation / embedding / reranking | `127.0.0.1:4001` / `:4002` / `:4003` | Optional local model services used by memory retrieval/indexing |
| Projects, tasks, hot sessions, mirrored tickets | `~/.nexus/nexus.db` | Local application state |
| Memories and archived-session summaries | configured Obsidian vault (default `~/Obsidian/Nexus/`) | Canonical Markdown |
| Memory search, vectors, and knowledge graph | `<vault>/.index/nexus-memory.db` | Disposable index, rebuildable from canonical Markdown |
| Nexus configuration | `~/.nexus/config.yaml` | Non-secret settings, environment references, and any literal model/assistant keys entered in Settings |
| Pi provider API keys and OAuth credentials | `~/.nexus/auth.json` | Local credential file managed by the Pi runtime |

Ports and paths can be changed in configuration. **Settings → Trust & Privacy** shows the effective trust-relevant values and credential sources without returning raw secrets to the browser.

### Secrets

- Pi provider API keys and OAuth credentials are stored in `~/.nexus/auth.json`.
- OpenRouter, local-model, and assistant keys support `${ENV_VAR}` interpolation in `config.yaml`. If a literal key is entered in Settings, it is stored in `config.yaml` and masked when Settings reads it back.
- `JIRA_TOKEN` is read from the process environment. Nexus also loads the nearest local `.env` file at startup without overwriting variables already exported by the shell.
- GitHub issue sync prefers `GITHUB_TOKEN`, then falls back to `gh auth token`; the GitHub CLI owns the fallback credential storage.

### What leaves the machine

| Destination | Data sent when enabled or used |
|---|---|
| Configured model providers | Prompts, conversation context, selected attachments/images, tool results, and any recalled memory injected into the prompt |
| Configured assistant endpoint | Assistant conversation messages and the configured bearer credential |
| Jira Cloud | The configured account email, API token, project/search query, and issue requests |
| GitHub | Repository owner/name, issue API requests, and a token when one is available |

Model and memory-model calls remain on the machine only when their configured endpoints are loopback addresses; remote configured endpoints receive the request data listed above. Nexus does not send the Obsidian vault or `nexus.db` wholesale; only content needed for the specific provider request is included.

### Memory boundaries and controls

Memory uses namespaces: `nexus` for Nexus project memory, `global` for shared memory, and separate namespaces for external agents. Auto-injection can be disabled or limited in Settings; when enabled, relevant memories are added to provider prompts up to the configured count and token budget.

Session archival is manual. A successful archive summarizes the session into canonical `nexus` memory and only then removes the hot thread from `nexus.db`; a failed memory write leaves the thread intact.

Settings provides two maintenance controls:

- **Rebuild index** re-scans canonical Markdown and regenerates disposable retrieval state without deleting vault files.
- **Clear Nexus memory** permanently deletes canonical files in the `nexus` namespace after the exact confirmation phrase `CLEAR NEXUS MEMORY`. It preserves `global`, external-agent namespaces, and unrelated vault files.

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

For local development, copy `.env.example` to `.env` and fill in the values you use:

```bash
cp .env.example .env
```

The backend loads `.env` on startup. Already-exported shell variables take precedence.

```bash
export OPENROUTER_API_KEY="sk-or-..."   # OpenRouter agents + chat
export OMLX_API_KEY="..."               # local model server, if it requires auth
export HERMES_API_KEY="..."             # remote Hermes agent (if used)
```

GitHub issue sync: run `gh auth login` before starting, or set `GITHUB_TOKEN`.

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

# Terminal 2 — backend (Fastify on :4173, orchestrator, Jira polling)
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

The Electron main process is TypeScript — it's compiled to `electron/dist/main.js` with `tsc`
(`electron/package.json` → `build`) before Electron can load it. The two run modes differ in what
they compile and where they load the UI from.

**1. Compile everything (required for production mode):**

```bash
# Builds, in order: shared → backend → frontend → electron (tsc) → memory daemon.
# Production mode loads the frontend from src/frontend/dist and runs the compiled
# backend/daemon, so a full build must run first.
npm run build
```

**2. Run as a production Electron app:**

```bash
# Recompiles the Electron main (tsc) and launches `electron .`. With the PROD flag it
# spawns the compiled backend + daemon (under system Node — see note) and loads the
# built frontend from disk. No Vite/dev servers involved.
NEXUS_ELECTRON_PROD=1 npm run --workspace=electron dev
```

**Run in dev mode instead** (hot reload) — drop the flag:

```bash
# Spawns the Vite dev server, backend, and daemon as dev processes (or reuses any
# already up) and loads localhost:5173 in the Electron window.
npm run --workspace=electron dev
```

> The compiled backend/daemon are launched with `spawn('node', …)` (system Node), **not** Electron's
> `fork()` — Electron's bundled Node has a different ABI and would break the `better-sqlite3` native
> module. Ensure a system `node` (≥ 20) is on your `PATH`.
>
> **Native ABI guard.** Because the backend and daemon always run under system Node, `better-sqlite3`
> must be compiled for system Node's ABI — never Electron's. If something rebuilds it for Electron
> (a stray `electron-rebuild`, an Electron packaging step), the service dies at boot with
> `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION mismatch`. To self-heal, `scripts/ensure-sqlite-abi.cjs`
> runs as a `predev`/`prestart` hook for both the backend and the daemon: it verifies the module loads
> under the current Node and, if not, rebuilds the owning install before the process starts. The
> backend (root `node_modules`) and the daemon (its own `node_modules`, outside the workspaces) are
> two separate installs, so both are guarded independently. Note: the hooks fire for `npm run …` start
> paths (dev/web); a future *packaged* Electron build that spawns `node dist/…` directly would need the
> guard wired into `electron/main.ts` as well.

> **Packaging:** there's no `.app`/`.dmg`/installer build wired up yet (no electron-builder/forge) —
> the app launches **unpackaged** via the `electron` binary as above. Packaging into a distributable
> is a future step.

On first run, NEXUS creates `~/.nexus/` with default config, starter personas, a set of default
providers, an Obsidian vault, and the SQLite database.

---

## The Local Model Stack

Memory retrieval (and local/cron personas) rely on **three independent OpenAI-compatible servers** on
loopback. The reference setup runs three `llama-server` (llama.cpp) processes — **and the launch flags
are not optional**. A server can be listening on its port but still reject every request if it wasn't
started in the right mode. (Nexus currently reports such failures as "unreachable" even when the
server is up — see Troubleshooting.)

| Port | Role | Recommended model | Required mode flags |
|---|---|---|---|
| 4001 | generation (HyDE + KG extraction) | a small instruct model, e.g. `Qwen3-*-Instruct` (Q4_K_M) | `--reasoning off` **if the model is a reasoning/"thinking" model** — otherwise it spends its whole token budget thinking and returns empty content |
| 4002 | embeddings | `nomic-embed-text-v1.5` (f16, 768-dim) | `--embedding --pooling mean` |
| 4003 | reranking | `qwen3-reranker-0.6b` (q8_0) | `--reranking` |

`--reasoning off` (alias `-rea off`) requires a recent llama.cpp build; on older builds use
`--reasoning-budget 0`. It only fully suppresses thinking on *hybrid* models (Qwen3, etc.); for
always-on reasoning models (e.g. DeepSeek-R1) pick a non-reasoning gen model instead.

Full launch commands (shared flags: `--host 127.0.0.1 --n-gpu-layers 99 --flash-attn on`):

```bash
# 4001 — generation (HyDE + knowledge-graph extraction)
llama-server --model ~/Models/Qwen3-Instruct-Q4_K_M.gguf \
  --port 4001 --host 127.0.0.1 --n-gpu-layers 99 --ctx-size 8192 --flash-attn on \
  --reasoning off

# 4002 — embeddings (768-dim vectors for vector recall)
llama-server --model ~/Models/nomic-embed-text-v1.5.f16.gguf \
  --port 4002 --host 127.0.0.1 --n-gpu-layers 99 --ctx-size 8192 --flash-attn on \
  --embedding --pooling mean

# 4003 — reranking (cross-encoder reorder of recall candidates)
llama-server --model ~/Models/qwen3-reranker-0.6b-q8_0.gguf \
  --port 4003 --host 127.0.0.1 --n-gpu-layers 99 --ctx-size 8192 --flash-attn on \
  --reranking
```

The gen model's context window only needs to cover one memory + a short prompt, so `8192` is ample —
no need for 32k (a larger KV cache just competes for VRAM with the other two servers). Sanity-check
each server after launch:

```bash
curl -s -X POST http://127.0.0.1:4002/v1/embeddings \
  -d '{"model":"nomic-embed-text-v1.5","input":"hello"}' | head -c 80   # expect a 768-float vector
curl -s -X POST http://127.0.0.1:4003/v1/rerank \
  -d '{"model":"qwen3-reranker-0.6b","query":"q","documents":["a","b"]}' | head -c 80   # expect results[]
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
├── auth.json            # Pi provider API keys and OAuth credentials
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

jira:                            # native Jira ticket poll (Settings -> Jira). Token via JIRA_TOKEN env.
  enabled: false                 # off by default; poll runs only while the backend is up
  user: ""                       # Atlassian account email that owns the token
  instance: ""                   # e.g. your-company.atlassian.net (https:// optional)
  project: "SUP"                 # project key to sync
  poll_minutes: 15               # cadence while Nexus is running

claude_code:
  command: "claude"
  args: []                       # extra CLI flags; the prompt is passed via -p
  idle_timeout_seconds: 600      # kill a turn only after this long with NO streamed activity

codex:
  command: "codex"
  args: []

```

Environment variables are interpolated with `${VAR}` syntax, and Nexus loads the nearest local `.env` file without replacing already-exported values. Environment references are preferred for OpenRouter, local-model, and assistant keys; literal values entered in Settings are stored in `config.yaml` and masked on read. Pi provider API keys and OAuth credentials live in `~/.nexus/auth.json`. Jira uses `JIRA_TOKEN`; GitHub uses `GITHUB_TOKEN` or `gh auth token`.

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

> **In the UI these are labelled "Agents"** (the persona is what an agent *is* once created). The
> underlying type, table, and `/api/personas` routes keep the `persona` name.

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

### Sessions

Each project has a sessions interface:

- Pick which persona/provider powers the conversation.
- Drag-and-drop files onto the composer — they land in `project_docs/uploads/` and are referenced in context.
- Relevant memories are recalled and injected into the prompt; each Q&A is archived to memory (best-effort).
- **Question cards**: when an agent emits an ` ```ask ``` ` block, it renders as a structured question card (single/multi/custom answers); your reply is fed back as the next turn (`POST /api/threads/:threadId/answer`).
- **Live streaming**: replies stream in token-by-token (`POST /api/threads/:threadId/messages/stream`, NDJSON). This is provider-agnostic — Claude (`stream-json`), Codex (`--json`), OpenCode (`--format json`), and HTTP providers (OpenAI SSE) each go through a normalizing adapter, so you see the agent working rather than a blank wait. The non-streaming `POST .../messages` remains for non-UI callers. Claude Code turns are bounded by an **idle** timeout (no streamed activity), not a wall-clock cap — see `claude_code.idle_timeout_seconds`.
- **Claude session capture & resume**: Claude Code turns run with `--output-format stream-json` under a self-assigned `--session-id`, so Nexus captures the resumable session id per thread (surfaced live the moment a turn starts). A chip under the chat header lets you **copy** `claude --resume <id>` or **open a macOS Terminal** already resumed into that session — useful if a turn stalls. In-app turns also continue the same session (`--resume`), so the thread is one continuous conversation shared with the terminal. (One writer at a time — hand off, don't drive both at once.)
- Archival is user-triggered. Nexus summarizes the conversation into canonical `nexus` memory, then removes the hot SQLite thread only after memory storage succeeds.

### Tickets (Jira mirror)

Nexus keeps a **disposable, read-only mirror** of Jira tickets assigned to you — Jira stays the source
of truth. The mirror lives in the `tickets` table and can be rebuilt at any time. There are two ways
it gets populated:

- **Native poll (in-app).** When enabled in **Settings → Jira**, the backend fetches your open project
  tickets directly from the Jira REST API on an interval (`poll_minutes`, default 15) — but only while
  Nexus is running. This is for things you act on *when you're in front of the app*; it deliberately
  isn't a 24/7 cron. The poll is gated on `jira.enabled` **and** the `JIRA_TOKEN` env var; the
  non-secret config (account email, instance host, project key, interval) lives in `config.yaml`. On a
  sync that changes tickets it raises an in-app notification (silent on a no-op, error toast on
  failure). Config is read once at startup, so **changes apply on the next backend restart**.
- **Push endpoint.** `POST /api/jira/sync` (`{ tickets, source, replaceAll }` → `{ inserted, updated, removed }`)
  remains for an external sync agent (e.g. an OpenClaw cron) to push the current set in. Both paths share
  the same upsert.

> **`JIRA_TOKEN`** is your Jira API token; it is read from the environment and is not stored in
> `config.yaml`. The **account email** must be the one that owns the token — with the wrong email the
> Jira search endpoint returns an empty result (HTTP 200) rather than an auth error, so it just looks like
> "no tickets." The instance host accepts either `your-company.atlassian.net` or a full `https://…` URL.

### Mission Control

The landing dashboard. A single `GET /api/mission-control` call aggregates:

- **Memory daemon health** (reachability + the local model stack's status),
- **Agent roster** — every persona with a per-provider health probe,
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

### Sessions
| Method | Path | Description |
|---|---|---|
| GET | `/api/projects/:projectId/threads` | List active threads |
| POST | `/api/projects/:projectId/threads` | Create a thread |
| GET | `/api/threads/:threadId/messages` | List messages |
| POST | `/api/threads/:threadId/messages` | Send a message (gets AI reply with memory context) |
| POST | `/api/threads/:threadId/messages/stream` | Send a message; streams the turn as NDJSON (`delta`/`session`/`done`/`error`) |
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

### Tickets (Jira mirror)
| Method | Path | Description |
|---|---|---|
| GET | `/api/tickets` | List mirrored Jira tickets |
| POST | `/api/jira/sync` | Upsert the mirror (`{ tickets, source, replaceAll }`) — used by external push agents; the native poll shares the same upsert |

### Notifications
| Method | Path | Description |
|---|---|---|
| GET | `/api/notifications` | Unseen in-app notifications (most recent first) |
| POST | `/api/notifications/seen` | Mark notifications seen (`{ ids }`) |

### Agents
| Method | Path | Description |
|---|---|---|
| GET | `/api/agents/status` | Running + recent agent runs (with provider, model, tokens, duration) |
| GET | `/api/agents/runs/:taskId` | Run history for a task |
| GET | `/api/agents/usage` | Aggregate token usage (`?projectId=` to scope); totals + breakdown by provider |

### Mission Control
| Method | Path | Description |
|---|---|---|
| GET | `/api/mission-control` | Aggregated dashboard: daemon health, agent roster + provider health, activity |

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
│   │   │   ├── tickets.ts       # Jira mirror + /jira/sync
│   │   │   ├── notifications.ts # in-app notifications API
│   │   │   ├── status.ts        # /mission-control
│   │   │   └── orchestrator.ts  # /agents/*
│   │   ├── orchestrator/
│   │   │   ├── index.ts         # Polling loop + dispatch
│   │   │   ├── providers.ts     # Claude Code / Codex / OpenCode / OpenAI-compatible
│   │   │   └── context.ts       # Prompt builder + memory injection
│   │   ├── memory/
│   │   │   └── client.ts        # thin HTTP client to @nexus/memory-daemon (:4100)
│   │   ├── jira/
│   │   │   ├── client.ts        # Jira REST client (fetch + map)
│   │   │   └── poll.ts          # native ticket poll (runs while the app is up)
│   │   ├── notifications/
│   │   │   └── index.ts         # notifications insert / list-unseen / mark-seen
│   │   └── tickets/
│   │       └── sync.ts          # shared ticket upsert (poll + push endpoint)
│   ├── memory-daemon/           # Standalone memory daemon (own README)
│   └── frontend/
│       ├── index.html
│       ├── vite.config.ts
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── api.ts           # Typed API client
│           └── components/      # MissionControl, KanbanBoard, ChatPanel,
│                                # ProvidersSettings, PersonasPage,
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

`projects`, `tasks`, `personas`, `providers`, `chat_threads`, `chat_messages`, `agent_runs`, `tickets`.

(There is no `memories` table — memory lives in the daemon's own index, not `nexus.db`.)

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Session replies "Config needed" | Set `OPENROUTER_API_KEY` in your environment and restart the backend. |
| `no such column` SQLite error | An old DB predates a schema change. Migrations handle most cases; if needed, delete `~/.nexus/nexus.db*` and restart. |
| `ERR_DLOPEN_FAILED` / `better_sqlite3.node was compiled against a different Node.js version (NODE_MODULE_VERSION)` at backend/daemon boot | `better-sqlite3` was rebuilt for the wrong ABI (usually Electron's instead of system Node's). The `predev`/`prestart` guard (`scripts/ensure-sqlite-abi.cjs`) auto-rebuilds it on the next `npm run web`/`dev`. To fix by hand: `npm rebuild better-sqlite3` (backend) and `npm rebuild better-sqlite3 --prefix src/memory-daemon` (daemon). |
| Claude Code task fails instantly | Ensure the `claude` CLI is installed and on your `PATH`. Check `~/.nexus/workspaces/<slug>/outputs/<task-id>.log`. |
| `N memory job(s) failed (dead-lettered)` / `embedder unreachable` | Almost always the local model stack is misconfigured, **not** down. A `llama-server` can be listening but return `501` for `/v1/embeddings` or `/v1/rerank` if it wasn't started with the right flags. Launch embeddings with `--embedding --pooling mean` (:4002) and rerank with `--reranking` (:4003). Confirm with `curl -s -X POST http://127.0.0.1:4002/v1/embeddings -d '{"input":"hi","model":"..."}'` returns 200. Dead jobs do **not** auto-retry — requeue them once the stack is fixed. |
| KG extraction dead-letters / gen returns empty content | Your generation model (:4001) is a reasoning/"thinking" model burning its whole token budget on hidden reasoning. Relaunch it with `--reasoning off`, or use a non-reasoning model. |
| A model server shows green but recall is empty | A port ping isn't a capability check — verify `/v1/embeddings` and `/v1/rerank` actually return 200 (see above). |
| Local model tasks fail | Confirm your local server is running and reachable at `models.local.base_url`, and that the persona's `model` matches a loaded model name (check `GET {base_url}/models`). |
| Agent never picks up a task | The task must be in **In Progress**. Check `GET /api/agents/status` and the backend console logs. |
| Hermes agent offline | Export `HERMES_API_KEY` in the backend's environment before launching; the key is never stored in git. |
| Jira tickets don't appear | Check, in order: (1) **Settings → Jira** is *Enabled* and you **restarted the backend** afterwards (config is read once at startup); (2) `JIRA_TOKEN` is exported in the shell that launched the backend; (3) the **account email** is the one that owns the token — a wrong email returns an empty result, not an error, so it looks like "no tickets". The instance host accepts a bare host or a full `https://…` URL. |

---

## License

Personal project — not licensed for redistribution.
