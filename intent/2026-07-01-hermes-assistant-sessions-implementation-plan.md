# Hermes Assistant Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans or equivalent task-by-task execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build multi-session Assistant support backed by Hermes durable session/run IDs, with local persistence and reconnectable run status after Nexus restarts.

**Architecture:** Add Nexus-local Assistant session/message/run tables, a focused Hermes API client, and new Assistant routes that prefer Hermes `/v1/runs` while preserving the existing single-thread Assistant API as wrappers. Update the React Assistant surface from one global log to a compact session list plus selected-session transcript and background-run controls.

**Tech Stack:** Fastify, better-sqlite3, TypeScript, React 19, Vitest, Node test runner.

## Global Constraints

- Documentation and plan artifacts live in `project_docs/`; do not create root `docs/`.
- Use the existing Assistant config (`assistant.url`, `assistant.api_key`) and never store raw API keys in SQLite.
- Keep project chat/Pi session behavior unchanged.
- Use test-first changes for new behavior.
- UI should use existing Nexus surfaces/icons and a dense operational layout, not a marketing page.
- Ship sessions plus detachable runs first; scheduled jobs remain data-model-ready but no full jobs UI in this slice.
- Legacy `/api/assistant/thread`, `/api/assistant/messages/stream`, and `/api/assistant/abort` remain compatible wrappers.

---

## Task 1: Assistant Persistence Schema

**Files:**
- Modify: `src/backend/db.ts`
- Modify: `src/backend/test/db.test.ts`

**Interfaces:**
- Produces tables `assistant_sessions`, `assistant_session_messages`, and `assistant_runs`.
- Produces migration from legacy `assistant_messages` into a single imported session.

- [x] Write failing tests in `src/backend/test/db.test.ts`:
  - New DBs include all three new tables with expected columns.
  - Legacy `assistant_messages` rows are copied into `assistant_session_messages`.
  - Migration is idempotent and does not duplicate imported messages on a second `getDb()` call.
- [x] Run `npm run --workspace=src/backend test -- test/db.test.ts` and verify the new tests fail because the tables/migration do not exist.
- [x] Add `CREATE TABLE IF NOT EXISTS` statements and indexes in `src/backend/db.ts`.
- [x] Add a guarded migration that creates an imported session only when legacy messages exist and no new Assistant session rows exist.
- [x] Re-run the backend DB tests and verify they pass.

## Task 2: Hermes Client

**Files:**
- Create: `src/backend/hermes/client.ts`
- Create: `src/backend/test/hermes-client.test.ts`

**Interfaces:**
- `normalizeHermesBaseUrl(url: string): string`
- `createHermesClient(config: { url: string; key: string; fetchImpl?: typeof fetch }): HermesClient`
- `HermesClient.capabilities(): Promise<HermesCapabilities>`
- `HermesClient.startRun(input: HermesRunInput): Promise<HermesRunStart>`
- `HermesClient.getRun(runId: string): Promise<HermesRunStatus>`
- `HermesClient.stopRun(runId: string): Promise<void>`
- `HermesClient.streamChatCompletions(messages): AsyncIterable<string>` for fallback.

- [x] Write failing tests for URL normalization: root URL, `/v1`, and `/v1/chat/completions`.
- [x] Write failing tests that `startRun` posts to `/v1/runs` with bearer auth and `session_id`.
- [x] Write failing tests that `getRun` maps Hermes statuses and output.
- [x] Write failing tests that fallback chat-completions extracts streamed text deltas.
- [x] Run `npm run --workspace=src/backend test -- test/hermes-client.test.ts` and verify failure.
- [x] Implement the client with injected `fetchImpl`, strict URL composition, bearer auth, and small pure helpers for SSE/OpenAI delta parsing.
- [x] Re-run the Hermes client tests and verify they pass.

## Task 3: Multi-Session Assistant Routes

**Files:**
- Modify: `src/backend/routes/assistant.ts`
- Modify: `src/backend/routes/activity.ts`
- Modify: `src/backend/test/routes-assistant.test.ts`

**Interfaces:**
- `GET /api/assistant/sessions`
- `POST /api/assistant/sessions`
- `GET /api/assistant/sessions/:id`
- `PATCH /api/assistant/sessions/:id`
- `DELETE /api/assistant/sessions/:id`
- `POST /api/assistant/sessions/:id/messages/stream`
- `POST /api/assistant/sessions/:id/runs`
- `GET /api/assistant/runs/:runId`
- `POST /api/assistant/runs/:runId/stop`
- `POST /api/assistant/sync`
- Compatibility wrappers for existing Assistant endpoints.

- [x] Write failing route tests for creating, listing, loading, renaming, and deleting Assistant sessions.
- [x] Write failing route tests for foreground stream using a fake Hermes run/event source, verifying local user/assistant messages and run status are stored.
- [x] Write failing route tests for detached runs and `/api/assistant/sync` polling a completed remote run.
- [x] Write failing route tests for compatibility wrappers over the default/newest session.
- [x] Run `npm run --workspace=src/backend test -- test/routes-assistant.test.ts` and verify expected failures.
- [x] Refactor `assistant.ts` around local session helpers and active remote run tracking keyed by local run ID.
- [ ] Use Hermes runs when available; keep stateless OpenAI-compatible fallback when durable capabilities are unavailable.
- [x] Update Assistant abort handling to stop Assistant runs by run ID where possible.
- [x] Re-run Assistant route tests and verify they pass.

## Task 4: Shared/Frontend API Types

**Files:**
- Modify: `src/frontend/src/api.ts`
- Modify: `src/frontend/src/api.test.ts`
- Modify: `src/frontend/src/hooks/useAssistantStream.ts`
- Modify: `src/frontend/src/hooks/useAssistantStream.test.ts` if needed, or add focused tests through `AssistantView.test.tsx`.

**Interfaces:**
- `AssistantSession`
- `AssistantRun`
- `AssistantMessage`
- API helpers for sessions, selected session, stream, detached run, stop, and sync.

- [x] Write failing frontend API/hook tests showing sessions are loaded, selected by ID, and stream requests target `/api/assistant/sessions/:id/messages/stream`.
- [x] Run `npm run --workspace=src/frontend test -- AssistantView.test.tsx` and verify failures.
- [x] Update `useAssistantStream` to manage sessions, selected session ID, messages, running state, background run submission, stop, and sync.
- [x] Re-run focused frontend tests and verify they pass.

## Task 5: Assistant UI

**Files:**
- Modify: `src/frontend/src/components/AssistantView.tsx`
- Modify: `src/frontend/src/components/AssistantView.test.tsx`
- Modify: `src/frontend/src/index.css` only if existing utility classes are insufficient.

**Interfaces:**
- Left session rail with stable `session.id` keys.
- Main transcript for selected session.
- New session, rename, delete/archive, sync, stop, and background-run controls.

- [x] Write failing UI tests for session list rendering, switching sessions, new session creation, and background run button behavior.
- [x] Run `npm run --workspace=src/frontend test -- AssistantView.test.tsx` and verify failures.
- [x] Implement the two-pane Assistant UI with existing Nexus surfaces and Phosphor icons.
- [x] Ensure empty and running states render without layout shift; failed/unknown statuses are represented by the shared status label path.
- [x] Re-run `AssistantView.test.tsx` and verify it passes.

## Task 6: Docs, Built Notes, and Verification

**Files:**
- Modify: `README.md`
- Modify: `project_docs/specs/2026-07-01-hermes-assistant-sessions.md`

**Verification Commands:**
- `npm run --workspace=src/backend test`
- `npm run --workspace=src/frontend test`
- `npm run typecheck`

- [x] Update README Assistant API reference with the new multi-session routes and compatibility note.
- [x] Update the design spec Built Notes with what was implemented, deviations, and what testing should verify.
- [x] Run backend tests, frontend tests, and typecheck.
- [x] Fix failures test-first if they reveal missing behavior; otherwise fix implementation/type issues directly when tests already cover the behavior.
- [x] Confirm `git status --short` contains only intended changes.
