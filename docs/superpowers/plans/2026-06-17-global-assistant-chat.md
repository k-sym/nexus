# Global Assistant Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a project-independent Assistant tab backed by configurable remote Assistant URL/key settings and `/api/assistant/*` routes.

**Architecture:** Add an Assistant config block to shared/backend config, expose it through Settings with masked key handling, and create a dedicated Assistant route module with a single persisted global conversation. Add a lightweight frontend Assistant view and stream hook so the UI does not depend on project chat state.

**Tech Stack:** Fastify, better-sqlite3, React, Vite, Vitest, Node test runner, TypeScript.

---

## File Structure

- Modify `src/shared/index.ts`: extend `NexusConfig` with `assistant`.
- Modify `src/backend/config.ts`: add default Assistant URL/key and a resolver for env interpolation.
- Modify `src/backend/db.ts`: add `assistant_messages` table.
- Create `src/backend/routes/assistant.ts`: own Assistant thread load, streaming, abort, and persistence.
- Modify `src/backend/index.ts`: register Assistant routes.
- Modify `src/backend/routes/settings.ts`: mask/preserve Assistant key.
- Modify `src/backend/test/routes-settings.test.ts`: cover Assistant settings round-trip.
- Create `src/backend/test/routes-assistant.test.ts`: cover missing config and thread loading.
- Modify `src/frontend/src/api.ts`: add Assistant client methods and config shape usage.
- Create `src/frontend/src/hooks/useAssistantStream.ts`: stream Assistant NDJSON into UI state.
- Create `src/frontend/src/components/AssistantView.tsx`: global Assistant chat surface.
- Create `src/frontend/src/components/AssistantView.test.tsx`: cover project-independent rendering and config error.
- Modify `src/frontend/src/components/TopBar.tsx`: add Assistant global tab.
- Modify `src/frontend/src/App.tsx`: add `assistant` global view.
- Modify `src/frontend/src/components/SettingsPage.tsx`: add Assistant URL/key fields.
- Modify `src/frontend/src/components/SettingsPage.test.tsx`: assert Assistant settings render.

## Task 1: Config And Settings

**Files:**
- Modify: `src/shared/index.ts`
- Modify: `src/backend/config.ts`
- Modify: `src/backend/routes/settings.ts`
- Modify: `src/backend/test/routes-settings.test.ts`
- Modify: `src/frontend/src/components/SettingsPage.tsx`
- Modify: `src/frontend/src/components/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing backend settings tests**

Add tests asserting `GET /api/settings` includes `assistant.url` and masked/env-safe `assistant.api_key`, and `PUT /api/settings` preserves a masked Assistant key.

Run: `npm test --workspace=src/backend -- routes-settings.test.ts`

Expected: FAIL because `assistant` is not part of `NexusConfig` or settings masking yet.

- [ ] **Step 2: Implement Assistant config and backend settings handling**

Add `assistant: { url: '', api_key: '${ASSISTANT_API_KEY}' }` to defaults, extend `NexusConfig`, mask `assistant.api_key` on GET, and preserve the current key on PUT when the incoming value is blank or masked.

- [ ] **Step 3: Verify backend settings tests pass**

Run: `npm test --workspace=src/backend -- routes-settings.test.ts`

Expected: PASS.

- [ ] **Step 4: Write failing frontend settings test**

Extend `SettingsPage.test.tsx` to assert Assistant URL and Key fields render with loaded config values.

Run: `npm test --workspace=src/frontend -- SettingsPage.test.tsx`

Expected: FAIL because the Assistant section is not rendered yet.

- [ ] **Step 5: Implement Assistant settings UI**

Add an Assistant section to `SettingsPage.tsx` with text inputs bound to `config.assistant.url` and `config.assistant.api_key`.

- [ ] **Step 6: Verify frontend settings test passes**

Run: `npm test --workspace=src/frontend -- SettingsPage.test.tsx`

Expected: PASS.

## Task 2: Backend Assistant Routes

**Files:**
- Modify: `src/backend/db.ts`
- Create: `src/backend/routes/assistant.ts`
- Modify: `src/backend/index.ts`
- Create: `src/backend/test/routes-assistant.test.ts`

- [ ] **Step 1: Write failing route tests**

Create tests for:

- `GET /api/assistant/thread` returns `{ id: "global", messages: [] }` on a fresh DB.
- `POST /api/assistant/messages/stream` returns a clear 400 error when Assistant URL or key is missing.

Run: `npm test --workspace=src/backend -- routes-assistant.test.ts`

Expected: FAIL because routes do not exist.

- [ ] **Step 2: Add persistence table**

Add `assistant_messages` to `db.ts` with `id`, `role`, `content`, `created_at`, and an index on `created_at`.

- [ ] **Step 3: Implement route module**

Implement `registerAssistantRoutes(fastify)` with:

- `GET /api/assistant/thread`
- `POST /api/assistant/messages/stream`
- `POST /api/assistant/abort`

For the first pass, return missing-config errors before any outbound network call. Keep streaming response format compatible with the frontend hook: newline-delimited JSON events with `type: "text_delta" | "complete" | "error"`.

- [ ] **Step 4: Register routes**

Import and register `registerAssistantRoutes` from `src/backend/index.ts`.

- [ ] **Step 5: Verify backend route tests pass**

Run: `npm test --workspace=src/backend -- routes-assistant.test.ts`

Expected: PASS.

## Task 3: Frontend Assistant Tab And Chat Surface

**Files:**
- Modify: `src/frontend/src/api.ts`
- Create: `src/frontend/src/hooks/useAssistantStream.ts`
- Create: `src/frontend/src/components/AssistantView.tsx`
- Create: `src/frontend/src/components/AssistantView.test.tsx`
- Modify: `src/frontend/src/components/TopBar.tsx`
- Modify: `src/frontend/src/App.tsx`

- [ ] **Step 1: Write failing frontend Assistant tests**

Add tests that assert:

- Top-level Assistant navigation can render without an active project.
- A missing-config API error is displayed in the Assistant view.

Run: `npm test --workspace=src/frontend -- AssistantView.test.tsx`

Expected: FAIL because the component/hook do not exist.

- [ ] **Step 2: Add API client methods**

Add `api.assistant.thread()`, `api.assistant.stream(...)` if useful, and use direct `apiFetch` in the stream hook for NDJSON.

- [ ] **Step 3: Implement stream hook**

Create a reducer-based hook that:

- Appends the user message immediately.
- Reads NDJSON response chunks.
- Appends text deltas to a streaming assistant message.
- Supports abort through `/api/assistant/abort`.
- Preserves input text when the send fails.

- [ ] **Step 4: Implement AssistantView**

Create the chat surface with message list, composer, send/stop controls, empty state, loading state, and error banner. Do not require `projectId` or `threadId` props.

- [ ] **Step 5: Wire navigation**

Add `assistant` to `GlobalView`, add the TopBar button labeled `Assistant`, add a command palette entry, and render `AssistantView` for the global Assistant view.

- [ ] **Step 6: Verify frontend Assistant tests pass**

Run: `npm test --workspace=src/frontend -- AssistantView.test.tsx`

Expected: PASS.

## Task 4: Full Verification

**Files:**
- All files above.

- [ ] **Step 1: Run targeted backend tests**

Run: `npm test --workspace=src/backend -- routes-settings.test.ts routes-assistant.test.ts`

Expected: PASS.

- [ ] **Step 2: Run targeted frontend tests**

Run: `npm test --workspace=src/frontend -- SettingsPage.test.tsx AssistantView.test.tsx`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Review git diff**

Run: `git diff --stat` and `git diff --check`

Expected: no whitespace errors and changes limited to Assistant feature plus the already committed spec/plan docs.

## Self-Review

Spec coverage:

- Assistant naming: Task 3.
- `/api/assistant/*` routes: Task 2.
- `ASSISTANT_API_KEY`: Task 1.
- Settings Assistant URL/key: Task 1.
- Project-independent chat: Tasks 2 and 3.

Placeholder scan: no TODO/TBD placeholders are present.

Type consistency: `assistant.url`, `assistant.api_key`, and `/api/assistant/*` names are consistent across tasks.
