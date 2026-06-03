# Native Jira sync — design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)
**Issue:** UAT item #3 follow-up — "run jira-sync as a scheduled task in Nexus *while it's running*"

## Problem

The user wants Jira tickets (open `SUP` tickets assigned to them) to sync into
Nexus's **Tickets** view on an interval, but **only while Nexus is open** — not a
24/7 system cron, and not handed to the Hermes agent. The principle: things the
user acts on *when in front of Nexus* (ticket sync, notifications) belong inside
Nexus and tick on its lifecycle; 24/7 unattended work goes to cron/Hermes.

Today this is done by an external bash script
(`~/Projects/baker-internal/scripts/jira-sync.sh`, "Nigel") that `curl`s the Jira
REST API and POSTs tickets to Nexus's existing `POST /api/jira/sync`. The
scheduler in Nexus can only create agent-dispatched tasks — it cannot run a
plain job on the heartbeat.

## Decision: pull it inside Nexus (native), not a shell-out

Rather than teach the scheduler to shell out to the external script, Nexus
**fetches Jira itself** and upserts via the same code path the push endpoint
already uses. This removes the external file dependency, the `python3`/`curl`
runtime, the `MC_URL` repointing, and the Electron-launched-from-Finder env
problem. It also means we do **not** touch the project-scoped `schedules` table —
this is a background poll, so it lives as its own backend interval (alongside the
existing scheduler and orchestrator loops).

The generic "shell-command scheduler action" explored earlier is **dropped**
(YAGNI — no second consumer yet).

## Secret / config split

- **`JIRA_TOKEN`** — stays in the **environment** only. Never in config.yaml or the
  DB. Consistent with the OpenRouter key hygiene just applied. (Already set by the
  user.)
- **Non-secret config** — editable in **Settings** under a new `jira` block:
  - `enabled` (boolean, default `false`)
  - `user` (email, e.g. `ksymmonds@safetyservices.co.uk`)
  - `instance` (host, e.g. `safety-services.atlassian.net`)
  - `project` (key, e.g. `SUP`)
  - `poll_minutes` (number, default `15`)

The sync only runs when `config.jira.enabled === true` **and** `process.env.JIRA_TOKEN`
is present; otherwise it stays dormant and logs a one-line reason at startup.

## Components

### 1. Config (`src/backend/config.ts`, `@nexus/shared` `NexusConfig`)
Add a `jira` block to `NexusConfig` and `DEFAULT_CONFIG`:
```ts
jira: { enabled: false, user: '', instance: '', project: 'SUP', poll_minutes: 15 }
```
No secret lives here, so no masking needed (unlike the openrouter key).

### 2. Jira client (`src/backend/jira/client.ts`)
A thin, dependency-free client mirroring what the script's `curl` did:
- `POST https://{instance}/rest/api/3/search/jql`
- Auth: `Authorization: Basic base64(user:JIRA_TOKEN)`
- Body: `{ jql, maxResults: 100, fields: [summary,status,priority,assignee,created,updated] }`
  with `jql = "project={project} AND statusCategory != Done AND assignee = currentUser() ORDER BY created DESC"`
- Maps each issue → ticket row: `{ key, summary, status.name, priority?.name ?? 'Medium',
  assignee?.displayName ?? null, created[:10], updated[:10], url=https://{instance}/browse/{key} }`
- **Errors throw** with status + body snippet (same spirit as the daemon's `ModelError`)
  so the poll loop can surface a real message, not a generic failure.

### 3. Shared upsert (`src/backend/tickets/sync.ts`)
Extract the upsert transaction currently inline in `routes/tickets.ts` into a
reusable `syncTickets(db, tickets, { source, replaceAll }): { inserted, updated, removed }`.
Both the existing `POST /api/jira/sync` route (legacy Nigel/OpenClaw push path,
kept) **and** the native poll call this. No behaviour change to the endpoint.

### 4. Poll loop (`src/backend/jira/poll.ts`, started in `index.ts`)
`startJiraSync(db)`:
- Guard: return early (with a logged reason) unless `config.jira.enabled && process.env.JIRA_TOKEN`.
- `setInterval` every `poll_minutes * 60_000`; also run once on startup.
- Each tick: fetch → `syncTickets(db, tickets, { source: 'nexus', replaceAll: true })`
  → emit a notification (see below).
- Errors are caught per-tick (a Jira blip never crashes the backend) and produce an
  error notification.

### 5. Notifications (new — mirrors the existing polling pattern)
- New `notifications` table: `id TEXT PK, level TEXT ('info'|'error'), title TEXT,
  message TEXT, created_at TEXT, seen_at TEXT`.
- The poll inserts:
  - **change** (`inserted+updated+removed > 0`) → `info`, e.g. `Jira: 3 new, 1 updated`
  - **error** → `error` with the failure message
  - **no-op** (0 changes) → nothing (silent)
- `GET /api/notifications` → rows where `seen_at IS NULL` (most recent first, capped).
- `POST /api/notifications/seen` (ids) → set `seen_at = now`.
- Frontend polls `GET /api/notifications` on the same cadence DaemonToasts already
  polls mission-control; each returned row is rendered as a toast in the existing
  bottom-right stack, then its id is POSTed to `/seen` so it isn't shown again.
  Single mechanism (unseen → show → mark seen); no `since` cursor. Reuses the toast
  UI, now fed by a real event source rather than only derived health alerts.

### 6. Settings UI (`src/frontend/src/components/SettingsPage.tsx`)
A small "Jira" section: `enabled` toggle, `user`, `instance`, `project`,
`poll_minutes`, plus a hint that the token comes from the `JIRA_TOKEN` env var.
Saves through the existing `PUT /api/settings` (extended to merge the `jira` block).

## Data flow

```
[poll_minutes tick | startup]
        │  (only if jira.enabled && JIRA_TOKEN)
        ▼
 jira/client.ts ── POST /rest/api/3/search/jql (Basic auth) ──► Jira Cloud
        │  issues[]
        ▼
 tickets/sync.ts  syncTickets(replaceAll) ──► tickets table
        │  { inserted, updated, removed }
        ▼
 notifications table  (info on change / error on failure / silent on no-op)
        ▲
        │  GET /api/notifications (frontend poll)
        ▼
 DaemonToasts (+ notifications source) ──► toast in running UI
```

The existing `POST /api/jira/sync` push path and the `tickets` table/`TicketsView`
are unchanged; Jira stays canonical, Nexus never writes back to Jira.

## Lifecycle / "while it's running"

The poll is a backend `setInterval`, started in `index.ts` and torn down with the
process — so it ticks only while the Nexus backend is up, exactly matching the
user's "while I'm in front of it" intent. No system cron, no Hermes.

## Error handling

- Jira client errors (auth/HTTP/network) throw with status + body snippet; the poll
  catches per-tick → error notification, backend stays up.
- Missing `JIRA_TOKEN` or `enabled=false` → dormant, single startup log line, no
  notifications.
- Sync upsert runs in a single transaction (already the case in the route).
- Poll interval is independent of the Jira request timeout (bounded fetch) so a slow
  Jira call can't stack ticks.

## Testing

- **Unit (`tickets/sync.ts`)**: insert/update/remove counts; `replaceAll` removes
  stale keys; missing `key` skipped.
- **Unit (`jira/client.ts`)**: issue → ticket mapping (priority/assignee fallbacks,
  date truncation, url); error throws carry status + snippet (mock fetch).
- **Unit (notifications)**: change → info row; error → error row; no-op → no row;
  `since` query filters; `seen` marks rows.
- **Manual**: enable in Settings with `JIRA_TOKEN` set, confirm tickets land in the
  Tickets view and a toast fires only on change; disable → poll goes dormant.

## Out of scope / follow-ups

- Generic shell-command scheduler action (dropped for now).
- Writing back to Jira (Jira stays canonical).
- `~/.nexus/env` loader for Finder-launched packaged Electron (only needed if the
  backend is started without the shell env; dev/`web` launches inherit it).
- Per-project ticket scoping (single global `SUP` view for now).
```
