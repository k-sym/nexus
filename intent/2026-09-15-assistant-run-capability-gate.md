# Intent: Gate Assistant background runs on the adapter's capabilities
Author: Keith. Status: accepted. Source: project_docs/audits/2026-09-15-hermes-openclaw-audit.md section 3 and 2026-09-15 conversation.

## Problem
The Assistant transport is the Partner assistant-api (`assistant.url`, 127.0.0.1:8788).
Its `GET /v1/capabilities` reports `run_submission=false`, `run_stop=false`,
`run_events_sse=false` (verified live 2026-09-15). The backend never reads that
document: `POST /api/assistant/sessions/:id/runs`, `POST /api/assistant/runs/:id/stop`
and `POST /api/assistant/sync` all call `/v1/runs*`, which the Partner does not
implement, so they fail with an opaque adapter error. The web AssistantView no longer
offers Background Handoff (#381), but the iOS `AssistantChatEndpoint` hard-codes
`supportsBackgroundHandoff = true`, so the phone still shows a control that cannot work.

## Proposed outcome
Keep the background-run surface (the `assistant_runs` table also records every
foreground streaming turn, and Keith has not confirmed background runs are gone for
good), but make it honest:
- The backend fetches `/v1/capabilities` once per configured assistant URL, cached
  with a TTL, failing closed to "no background runs" when the document is unreadable.
- The run-submission and stop routes return a clear 400 when the adapter does not
  advertise the feature, before any local run row or attachment is written.
- `/sync` skips its `/v1/runs` polling when run submission is unsupported.
- `GET /api/assistant/sessions/:id` and `/current` carry
  `capabilities.backgroundHandoff` so clients decide from the server's answer.
- iOS reads that flag from the session detail; the endpoint defaults to hidden, so a
  backend without the field (or a Partner without runs) shows no handoff control.

## Affected users and systems
Keith on the phone (chonk/glasses thin clients via baker-pro); `src/backend/routes/assistant.ts`;
`ios/NexusCore` models + `AssistantChatEndpoint`; `ios/App` `ChatViewModel`. No web UI change.

## Constraints
- Small change: no schema migration, no removal of `assistant_runs`, no new routes.
- One capabilities request per URL per TTL window; never on the hot streaming path.
- iOS stays tolerant of older backends (absent field means hidden, not a decode error).
- Tests: backend `routes-assistant.test.ts`; iOS `NexusCore` tests. iOS is not in CI.

## Open questions
- Should the dead run routes, `/sync` polling and the iOS handoff path be deleted
  outright? Deferred until Keith confirms background runs are not coming back; this
  change keeps that deletion small if so.
