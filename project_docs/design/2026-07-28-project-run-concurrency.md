# Project run concurrency

## Problem

The chat UI reported that a selected model was busy, or that an autonomous
mission was running, when another run held the same project's concurrency slot.
Those explanations conflated two different concerns:

- Pi conversation context is isolated by `threadId + cwd`; the selected model is
  not a shared chat context.
- Chat turns and autonomous missions share the project's working tree and may
  both mutate files.

The model-specific lock was therefore redundant, while the project-wide status
could mislabel an ordinary chat run as an autonomous mission. In particular, a
chat using a different model still held the project-wide slot, so the status
endpoint fell through to `projectBusy: true` and produced the incorrect mission
banner.

## Decision

Concurrency is keyed only by project.

Each project run claim records its source (`chat` or `mission`) and, for
diagnostics only, the chat's selected model. The model never determines whether
a run may start.

One run per project remains the safe default because every chat session can use
tools that edit the shared checkout. Allowing concurrent runs safely would
require a stronger boundary, such as a worktree per session or an enforceable
read-only run mode.

## User experience

- A chat holder is described as another session using the project. The banner
  explains that runs are serialized to prevent conflicting file changes.
- Sending from another session remains possible and enters the existing
  confirm-before-cancelling flow.
- A mission holder is identified explicitly as an autonomous mission. The
  composer remains available for drafting, while Send is disabled until the
  mission releases the project.
- The status banner is an accessible live status and its pulse respects reduced
  motion preferences.
- `GET /api/projects/:projectId/model-status` keeps its existing path for client
  compatibility, but now returns `source`, diagnostic `modelKey`/`sameModel`,
  and a compatibility `projectBusy` flag that is true only for missions.

## Implementation notes

- Removed the per-project/model map and waiter from `ConcurrencyTracker`.
- Chat and mission callers now make source-aware project claims.
- Chat conflicts return `chat_busy` and remain cancellable. Legacy
  `model_busy` responses are still accepted by the frontend during upgrades.
- Mission conflicts return `project_busy` with a clear, non-cancellable error.
- Thread-local re-entry protection remains unchanged, so the same session
  cannot receive two overlapping turns.

## Verification

Testing should verify:

- the runtime continues to bind and resume context by `threadId + cwd`;
- same-model runs in different projects remain independent;
- same-project runs are serialized even when they select different models;
- chat and mission holders produce different status payloads and banner copy;
- chat conflicts enter the cancellation confirmation path;
- mission conflicts keep draft input but prevent Send;
- claims are released on completion, abort, setup failure, and client
  disconnect behavior remains unchanged.

## Built result

Implemented as specified. No per-model concurrency gate remains. The
project-wide working-tree guard is retained, now with source-aware responses and
accurate UI messaging. Focused backend route/tracker/mission tests, frontend
hook/component tests, and backend/frontend type checks cover the change.
