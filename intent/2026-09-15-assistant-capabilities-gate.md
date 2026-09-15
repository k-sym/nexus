# Gate Assistant background runs on the endpoint's capabilities
Status: accepted — Keith requested 2026-09-15 (audit `project_docs/audits/2026-09-15-hermes-openclaw-audit.md` §3, §5 step 2).

## Problem
The Assistant background-run routes (`POST /api/assistant/sessions/:id/runs`, `POST /api/assistant/runs/:id/stop`, `POST /api/assistant/sync`) call `/v1/runs*` on the configured endpoint. The Partner assistant-api that replaced Hermes reports `run_submission`, `run_stop` and `run_events_sse` = false on `/v1/capabilities` and has no `/v1/runs`, but the backend never reads capabilities. The web view stopped exposing handoff (#381); the iOS composer still shows "hand off" on every assistant session and the call fails against a missing endpoint.

## Proposed outcome
The backend reads `/v1/capabilities` once a minute per configured endpoint and gates the run routes on it: a handoff or stop against an endpoint without the feature is refused with 501 and a plain message, an unreadable endpoint with 503, and sync settles leftover running rows as `unknown` once instead of polling an endpoint that cannot finish them. Session detail carries the capabilities so clients hide handoff where it cannot run; iOS shows the control only when the loaded detail says the endpoint can honour it.

## Affected users and systems
Keith on iOS (the handoff button disappears against the Partner); the backend Assistant routes and their tests; NexusCore models and the app's chat view model. No config change.

## Constraints
Keep the routes: a runs-capable endpoint (or a future Partner feature) must work unchanged. Treat an unreadable endpoint as transient — never mark runs unknown over a blip. Do not add agent-reachable write tools.

## Open questions
Whether to delete the run routes outright if the Partner never grows run submission; deferred until that is decided.
