# Sessions Navigation and Scheduler Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename chat UI to sessions, show active session work in the sidebar, and remove Nexus's built-in Scheduler without touching Jira polling.

**Architecture:** Keep API/database internals stable. Lift per-thread stream activity from `ChatPanel` into `App`, then pass active session IDs into `Sidebar` for a visual spinner. Remove Scheduler entry points from frontend navigation/settings, backend registration/startup, shared config, docs, and tests/imports that only validate the removed scheduler.

**Tech Stack:** React, TypeScript, Fastify, better-sqlite3, node:test.

---

### Task 1: Add Session Activity Plumbing

**Files:**
- Modify: `src/frontend/src/App.tsx`
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/frontend/src/components/Sidebar.tsx`

- [ ] **Step 1: Extend `ChatPanel` props**
  - Add `onSessionActivityChange?: (threadId: string, active: boolean) => void`.
  - Use an effect keyed by `threadId` and `state.isRunning` to report activity only when a concrete thread exists.
  - Cleanup should report `false` for the thread on unmount/thread change.

- [ ] **Step 2: Track active sessions in `App`**
  - Add `activeSessionIds` state as a `Set<string>`.
  - Add `handleSessionActivityChange(threadId, active)` that immutably adds/removes IDs.
  - Pass the callback to `ChatPanel` and pass `activeSessionIds` to `Sidebar`.

- [ ] **Step 3: Render busy spinner in `Sidebar`**
  - Add `activeSessionIds: Set<string>` prop.
  - For each session row, if `activeSessionIds.has(thread.id)`, render a small `animate-spin` rounded ring on the trailing edge.
  - Preserve rename/delete controls on hover.

### Task 2: Rename Visible Chat Labels

**Files:**
- Modify: `src/frontend/src/App.tsx`
- Modify: `src/frontend/src/components/Sidebar.tsx`
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/backend/db.ts` only if default user-facing title is still `New Chat`
- Modify: `src/backend/routes/chat.ts` only if response/default title text is user-facing

- [ ] **Step 1: Replace navigation labels**
  - `Chat` -> `Sessions` in the sidebar section.
  - `New` -> `New Session` or concise `New` under the Sessions section if width requires it.
  - `No conversations` -> `No sessions`.

- [ ] **Step 2: Replace default title text**
  - Use `New Session` for newly-created threads if current backend default or API fallback says `New Chat`.

- [ ] **Step 3: Keep code names stable**
  - Do not rename `ChatPanel`, `ChatThread`, route paths, or database tables in this pass.

### Task 3: Remove Scheduler Surface

**Files:**
- Modify: `src/frontend/src/App.tsx`
- Modify: `src/frontend/src/components/TopBar.tsx`
- Modify: `src/frontend/src/components/SettingsPage.tsx`
- Delete: `src/frontend/src/components/SchedulerPage.tsx`
- Modify: `src/backend/index.ts`
- Delete: `src/backend/routes/schedules.ts`
- Delete: `src/backend/scheduler/index.ts`
- Delete: `src/backend/scheduler/cron.ts`
- Modify: `src/shared/index.ts`
- Modify: `src/backend/routes/status.ts`
- Modify: `src/frontend/src/api.ts`
- Modify/Delete scheduler-only tests.

- [ ] **Step 1: Remove frontend Scheduler navigation**
  - Remove `scheduler` from `GlobalView` unions.
  - Remove TopBar Scheduler button.
  - Remove command palette Scheduler entry.
  - Remove `SchedulerPage` import and render branch.

- [ ] **Step 2: Remove Settings Scheduler section**
  - Delete only the Scheduler section; keep Jira settings and `poll_minutes`.

- [ ] **Step 3: Remove backend scheduler startup/routes**
  - Remove `registerScheduleRoutes` and `startScheduler` imports/usages from `src/backend/index.ts`.
  - Delete Scheduler route and scheduler implementation files.

- [ ] **Step 4: Remove shared scheduler config/status surface**
  - Remove `scheduler` from `NexusConfig`.
  - Remove Scheduler status from mission control route/API types/UI.
  - Ensure `loadConfig` no longer requires scheduler defaults.

- [ ] **Step 5: Keep Jira polling intact**
  - Verify `startJiraSync(db)` still starts unconditionally and uses `jira.enabled` internally.

### Task 4: Validate

**Files:**
- No new files unless tests need snapshots/fixtures.

- [ ] **Step 1: Run focused searches**
  - `rg -n "Scheduler|scheduler|New Chat|No conversations|\bChat\b" src README.md --glob '!node_modules'`
  - Confirm remaining `Chat` occurrences are internal component/API/type names or historical docs that should stay.

- [ ] **Step 2: Run tests/typecheck**
  - `npm run typecheck`
  - `npm run --workspace=src/backend test` if available.
  - If a test script does not exist, report that explicitly.
