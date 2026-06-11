# Design: Interactive task chats replace headless orchestrator dispatch

**Date:** 2026-06-11
**Status:** Approved (design), pending implementation plan

## Problem

When a Kanban task is dragged to **In Progress**, the user picks a model and the
orchestrator dispatches the task **headlessly**: a poll loop (every 5s) opens an
ephemeral pi session, runs the task prompt to completion, writes output to a log
file, and auto-advances the card. This is invisible — the run does not appear in
the Sessions list, there is no UI to view output, and a failure that bounces the
card back to triage looks identical to "nothing happened."

In practice, essentially every task benefits from user interaction. The headless,
fire-and-forget model is the wrong default.

## Goal

Picking a model for a task should **create a new chat thread seeded with the task,
switch the user to that chat, and start the agent immediately** — so the user can
watch and steer the work. The headless orchestrator dispatch is **removed entirely**.

## Decisions (from brainstorming)

1. **Orchestrator fate:** Replace it entirely. Picking a model always opens a chat;
   the 5s poll-and-dispatch is removed so nothing ever runs headlessly (no
   double-dispatch risk).
2. **Seed behavior:** Auto-send the seeded prompt immediately. The agent starts
   working as soon as the chat opens; the user steers mid-stream.
3. **Task ↔ chat link:** Store the chat's `thread_id` on the task. The card moves to
   In Progress and clicking it later reopens its chat. The user advances the card to
   Review/Deploy manually (no auto-advance).

## Design

### 1. The "Run task" flow

Dragging a card to **In Progress** shows the model picker (unchanged trigger). On
**Run task**, the frontend:

1. Creates a chat thread titled after the task.
2. Sets `tasks.thread_id = <new thread id>` and `tasks.status = 'in_progress'`.
3. Navigates to the chat (`selectThread`, which switches the main view to chat).
4. Auto-sends a seeded prompt as the first user message, using the picked model.

If the task **already** has a `thread_id`, "Run task" / clicking the card **reopens
the existing chat** instead of creating a duplicate thread.

### 2. Task ↔ chat linkage & card interactions

- New nullable `thread_id` column on the `tasks` table (+ `Task.thread_id?: string | null`
  in `src/shared`).
- Card click is conditional:
  - Card **with** a linked thread → click **reopens its chat**.
  - Card **without** a thread → click opens the **Edit** modal (existing behavior).
- Linked cards show a small **pencil icon** on hover (still editable) and a subtle
  **chat glyph** indicating a conversation exists.
- The user advances the card to Review/Deploy manually.

### 3. Seeding mechanism

There is no "create thread + auto-send" today. Add a minimal seed channel:

- App holds a transient `seed = { threadId, prompt, modelKey }`.
- `ChatPanel` gets a `seed` prop. When its `threadId` matches the seed and it has not
  been consumed, it auto-submits the prompt **once** (via the existing
  `submit` → `startStream` path), then clears the seed so it never re-fires on
  remount or thread-switch.
- The seeded prompt is a concise, formatted message built from the task (title,
  description, priority, project working dir), mirroring the old `buildTaskPrompt`
  but as a normal, visible chat message.
- **Concurrency:** the stream endpoint already returns 409 for a second running
  thread in the same (project, model). The seed path reuses `ChatPanel`'s existing
  busy-conflict handling, so a seeded send while another chat runs surfaces the
  normal conflict prompt rather than failing silently.

### 4. Removal scope (replace-entirely)

- Remove the `startOrchestrator(db, pi)` call at backend boot.
- Remove the dead headless dispatch loop in `src/backend/orchestrator/index.ts`
  (headless session creation, `buildTaskPrompt`, auto-advance, and the
  dispatch-tied memory/Obsidian extraction).
- Retire the unused `POST /api/orchestrator/tasks/:id/start` endpoint and the
  `api.agents.startTask` client method.
- **Keep** the `agent_runs` table and `GET /api/agents/status` (Mission Control
  "Recent activity"). Chat usage flows through its own path; headless task rows
  simply stop being created.

### 5. Smaller bits

- **Picker copy** (`OrchestratorModelPicker` → renamed `TaskModelPicker`): replace
  "moves to `in_progress` and the orchestrator dispatches it headlessly on the next
  poll tick" with "A new chat opens with this task and the agent starts working. You
  can guide it as it goes."
- **Types:** add `thread_id?: string | null` to `Task` in `src/shared`.

## Testing

- Seed fires exactly once (not on remount or thread-switch).
- Conditional card click: edit when unlinked, reopen-chat when linked.
- Update/remove orchestrator tests that assume headless dispatch.

## Out of scope (tracked separately)

- **Summarize a completed task chat into memory + Obsidian.** The removed headless
  run used to auto-extract insights (`addMemory`) and write an Obsidian summary
  (`writeTaskSummary`) on completion. The chat flow will not do this automatically.
  Deferred to a follow-up (spawned task chip "Summarize task chats into memory").

## Affected files (anticipated)

- `src/shared/index.ts` — `Task.thread_id`.
- `src/backend/db.ts` — `thread_id` migration on `tasks`.
- `src/backend/index.ts` — drop `startOrchestrator` call.
- `src/backend/orchestrator/index.ts` — delete dispatch loop.
- `src/backend/routes/orchestrator.ts` — retire `/start` (keep `/agents/status`).
- `src/backend/routes/tasks.ts` (or wherever task update lives) — allow `thread_id`.
- `src/frontend/src/App.tsx` — `handleRunTask`, seed state, conditional card click,
  pass `seed` to `ChatPanel`.
- `src/frontend/src/components/ChatPanel.tsx` — `seed` prop, auto-submit-once.
- `src/frontend/src/components/KanbanBoard.tsx` — conditional click, edit/chat glyphs.
- `src/frontend/src/components/OrchestratorModelPicker.tsx` → `TaskModelPicker.tsx` — copy.
- `src/frontend/src/api.ts` — `thread_id` on task update; remove `startTask`.
