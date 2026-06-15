# Tickets three-pane preview + Braindump view — design

Date: 2026-06-15
Status: Approved (pending spec review)

## Context

Nexus has a global **Tickets** view (`src/frontend/src/components/TicketsView.tsx`) that
lists Jira tickets synced by a native in-backend poll and lets the user triage a ticket
into a Nexus project (creating a Kanban task in that project's `triage` column).

Two problems / wants drove this work:

1. **No body, only metadata.** The Jira sync fetches only 6 fields (summary, status,
   priority, assignee, created, updated). The ticket body/description is never fetched,
   stored, or rendered. To read what a ticket actually says, the user must open it in the
   Jira web UI — which they dislike, because forwarded-email tickets bury the real content
   under email cruft (social icons, logos, banner images, forwarded headers, signatures).

2. **No idea-capture surface.** The user wants a second view, **Braindump**, to record
   raw ideas before committing them to a project, then triage them into a project using
   the *same* mechanic the Tickets view already provides.

## Goals

- Add a **content preview** to the Tickets view: fetch the Jira body, clean it, render it.
- Re-arrange Tickets into a three-pane layout: list (left) + detail (right) on top, a
  **full-width cleaned preview strip** underneath both.
- Add a **Braindump** view that clones the Tickets shell, adds quick idea capture, and
  reuses the triage-to-project mechanic.
- Extract the triage control into a shared component used by both views.

## Non-goals

- No change to the existing Jira poll cadence or JQL.
- No rich ADF editor — the preview is read-only rendered markdown.
- No Braindump rich-text editor — title + plain/markdown body only.
- Perfect email cleaning is explicitly *not* a goal (see Known tradeoffs).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Preview placement | Full-width strip underneath both list and detail |
| Cleanup aggressiveness | Text-first + trim boilerplate (strip all images; collapse forwarded headers; fold signature/footer behind "show more") |
| Braindump idea shape | Title + optional body (quick-add line → expand to add body) |
| Triage lifecycle (Braindump) | Triaged ideas removed from the active list (kept as DB rows, not surfaced) |
| Description fetch strategy | Lazy-fetch on first selection, cache in DB, manual refresh available |
| Triage control | Extracted into a shared `TriageToProject` component |

## Part 1 — Tickets: fetch, clean & preview the body

### 1a. Lazy description fetch

Descriptions are fetched **on first selection of a ticket**, not during the poll. This
keeps the 15-minute poll fast and light, gives fresh content when the user actually opens
a ticket, and makes re-opening instant from cache.

- Schema: add `description_adf TEXT` and `description_fetched_at TEXT` columns to the
  `tickets` table (`src/backend/db.ts`, migration).
- New route `GET /api/tickets/:key/description` (`src/backend/routes/tickets.ts`):
  - If cached and not force-refresh → return cached cleaned output.
  - Else fetch the ADF body from Jira (`fields=description`) via the Jira client,
    persist raw ADF + timestamp, return cleaned output.
  - `?refresh=1` forces a re-pull (wired to the preview's refresh icon).
- Jira client (`src/backend/jira/client.ts`): add a `fetchJiraIssueDescription(key)`
  helper that requests the `description` field for a single issue and returns raw ADF.

### 1b. Cleaning pipeline (backend, unit-tested)

A self-contained util `src/backend/tickets/cleanAdf.ts` exporting `cleanAdf(adf)`:

1. **ADF → markdown** via a lightweight in-house walker (no Atlaskit dependency).
   Handles: doc/paragraph/text (+ marks: strong, em, code, link), headings, bullet/ordered
   lists, blockquote, codeBlock, rule, hardBreak, table (basic). Unknown nodes degrade to
   their text content.
2. **Strip all images** — skip every `media`, `mediaSingle`, `mediaGroup`, and
   `mediaInline` node. Removes social icons, logos, and banner images.
3. **Trim boilerplate** — conservative heuristics:
   - Collapse contiguous forwarded-header blocks (lines matching
     `From: / Sent: / To: / Cc: / Subject: / Date:`).
   - Fold a trailing signature/footer block (delimiter `-- `, or runs containing
     unsubscribe / "follow us" / social-link keywords) behind a "show more".
   - Rules favour **under-trimming** over eating real content.

Returns `{ markdown: string, trimmedSections: { kind: 'forwarded'|'footer', markdown: string }[] }`.
Raw ADF is retained in the DB so cleaning rules can be revised later without re-fetching.

The walker and the trim heuristics are isolated, pure functions — easy to unit-test with
fixtures captured from real tickets (e.g. the AWS RDS forwarded-email example).

### 1c. Layout — full-width preview strip

`TicketsView.tsx`: keep the existing list (left) + detail (right, 384px) row on top; add a
**full-width preview strip beneath both** that renders the cleaned markdown for the selected
ticket. States: empty (no selection), loading (fetching), error (fetch failed, with retry),
content (rendered markdown + "show more" for any trimmed sections), and a refresh icon that
forces a re-pull. Markdown rendered with the app's existing markdown renderer (same one used
elsewhere in the frontend; reuse, do not add a new dependency).

## Part 2 — Braindump view

### 2a. Data

New table `braindump_ideas`:

```
id            TEXT PRIMARY KEY
title         TEXT NOT NULL
body          TEXT            -- optional, markdown
status        TEXT NOT NULL   -- 'active' | 'triaged'
project_id    TEXT            -- set when triaged
task_id       TEXT            -- the created task, when triaged
created       TEXT NOT NULL
updated       TEXT NOT NULL
```

Triaged ideas (`status='triaged'`) are filtered out of the view but kept as rows, so nothing
is truly lost / is recoverable if we ever want a "triaged history" later.

### 2b. Routes (`src/backend/routes/braindump.ts`)

- `GET /api/braindump` — list active ideas (`status='active'`), newest first.
- `POST /api/braindump` — create `{ title, body? }` → active idea.
- `PATCH /api/braindump/:id` — edit `{ title?, body? }`.
- `DELETE /api/braindump/:id` — delete an idea.
- Triage reuses the **existing** `POST /api/projects/:id/tasks`; the frontend then
  `PATCH`es the idea to `status='triaged'` with the returned `task_id` + `project_id`.

### 2c. UI (`src/frontend/src/components/BraindumpView.tsx`)

Mirrors the Tickets three-pane shell:

- **Quick-add input** at the top of the list (type idea → Enter to create). This is the one
  element with no Tickets equivalent.
- List of active ideas → select → detail pane with editable title + body and the shared
  triage control.
- Full-width preview strip renders the idea's body markdown (no cleaning — user-authored).

### 2d. Navigation

- `App.tsx`: add `'braindump'` to the `GlobalView` union + a render case in `renderMain()` +
  a command-palette entry.
- `TopBar.tsx`: add a Braindump button alongside Dashboard / Tickets (Phosphor icon, e.g.
  `Lightbulb` or `Brain`).

## Shared component

Extract the inline triage UI currently in `TicketsView` into
`src/frontend/src/components/TriageToProject.tsx`:

- Props: the source item (key/title/summary/url for tickets; title/body for ideas), the
  project list, and an `onCreate(projectId)` callback.
- Renders the project dropdown + "Create task" button + success/error feedback.
- Both `TicketsView` and `BraindumpView` consume it; the per-view differences (what becomes
  the task title/description, and what happens after success) stay in each view's callback.

## Data flow

```
Tickets:   poll → tickets table (metadata)
           select ticket → GET /api/tickets/:key/description
                         → [cache hit] cleaned md  OR  Jira fetch → store ADF → cleanAdf → cleaned md
                         → preview strip renders md
           triage → POST /api/projects/:id/tasks → task in project 'triage' column

Braindump: quick-add → POST /api/braindump → active idea
           select idea → edit title/body (PATCH)
           triage → POST /api/projects/:id/tasks → PATCH idea status='triaged' → drops from list
```

## Known tradeoffs / future revisit

- **Image stripping vs customer screenshots.** Stripping *all* images also removes genuine
  customer screenshots (which the team actively encourages). Accepted for now: the user can
  click through to Jira for the rare ticket where a screenshot matters. Documented escape
  hatch — because raw ADF is retained, a later iteration can keep **attachment-sized** images
  (real customer screenshots, which arrive as proper attachments with real dimensions) while
  still dropping tiny inline/linked icons and banners. Revisit after seeing real volume.
- **Trim heuristics are best-effort.** Forwarded-header / footer detection is pattern-based
  and tuned to under-trim. Real tickets will surface edge cases; rules iterate against
  fixtures.

## Testing

- `cleanAdf.ts`: unit tests with ADF fixtures (forwarded email w/ images + footer; plain
  ticket; nested lists/tables) asserting images removed, headers/footers folded, real body
  preserved.
- Braindump routes: integration tests for create/list/edit/delete and the triage →
  `status='triaged'` → dropped-from-active flow.
- Description route: cache-hit vs fetch-and-store vs force-refresh paths.

## Files touched

Backend:
- `src/backend/db.ts` — `tickets` columns + `braindump_ideas` table (migration)
- `src/backend/jira/client.ts` — `fetchJiraIssueDescription`
- `src/backend/tickets/cleanAdf.ts` — new ADF→markdown + clean util (+ tests)
- `src/backend/routes/tickets.ts` — `GET /api/tickets/:key/description`
- `src/backend/routes/braindump.ts` — new CRUD routes
- `src/backend/index.ts` — register braindump routes

Shared:
- `src/shared/index.ts` — `Ticket.description*` fields; `BraindumpIdea` type; cleaned-body type

Frontend:
- `src/frontend/src/api.ts` — `tickets.description()`, `braindump.*`
- `src/frontend/src/components/TicketsView.tsx` — three-pane layout + preview strip
- `src/frontend/src/components/BraindumpView.tsx` — new view
- `src/frontend/src/components/TriageToProject.tsx` — extracted shared control
- `src/frontend/src/components/TopBar.tsx` — Braindump nav button
- `src/frontend/src/App.tsx` — `GlobalView` + route + command palette
