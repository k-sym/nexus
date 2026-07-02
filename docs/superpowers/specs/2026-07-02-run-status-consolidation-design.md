# Run status consolidation & tool-noise collapse

**Date:** 2026-07-02
**Status:** Approved (design)
**Scope:** Frontend presentation only — no backend, streaming, or data-flow changes.

## Problem

The live status of a streaming agent run is rendered twice:

1. A thin label-only strip above the composer (`ChatPanel.tsx`, ~line 766).
2. The full `AgentRunHeader` at the top of the response bubble (`AgentRunHeader.tsx`).

Separately, `ToolCallTimeline` renders **every** tool call as its own block
(`ToolCallTimeline.tsx`, ~line 44). During a long run the list grows without
bound and pushes the model's actual text output off-screen, forcing the user to
scroll to read the response. Multi-part question forms (`QuestionCard.tsx`)
render all sub-questions full-height at once, producing a very tall form.

The result is functionally fine but visually broken: duplicated status, a
runaway tool list, and stacked question fields.

## Goals

- A single source of live run status, pinned above the composer where the user
  is already looking.
- The model's text output stays on screen while a run streams.
- Tool transparency preserved but opt-in (expandable), not forced.
- Question forms presented one step at a time.

## Non-goals

- No changes to the backend, the pi event stream, or `agent-run-state` reducer.
- No change to how tool calls are stored or streamed.
- No whole-card collapse affordance for finished runs (explicitly dropped — see
  Decisions).

## Design

### 1. Single live status strip (`RunStatusStrip`)

Replace the thin status strip above the composer with a `RunStatusStrip`
component that carries everything the bubble header used to show:

`spinner · phase label · elapsed · "last activity Xs ago" · model`

- The 1-second tick (`useState(now)` + `setInterval`) currently in
  `AgentRunHeader` moves into this component.
- It reads the active run already computed in `ChatPanel` (`state.activeRun` /
  `attachedRun`, ChatPanel ~line 643).
- When only a coarse status is available (a re-attached backend run with no
  `AgentRunView`), it degrades gracefully to `spinner + label` with no timers
  and no elapsed/last-activity fields.
- Rendered only while `isRunning`.

### 2. Send → Stop in the composer

While `isRunning`, the composer renders a **Stop** button (wired to the
existing `handleStop`) in place of **Send** (ChatPanel ~line 840). The Stop
control no longer lives in a run header.

### 3. Remove the bubble header; collapse the tool list

`AgentRunCard` drops `<AgentRunHeader>` entirely.

**While running** (`run.status === 'running'`):
- Show only the currently-running tool call, expanded (reusing `ToolCallBlock`).
- Show one clickable summary row: `✓ N tool calls` with `· M failed` appended
  when any failed. Completed and queued tools fold into this count.
- Clicking the summary expands the full timeline (all `ToolCallBlock`s).
- Net effect: the bubble stays ~2–3 lines tall so streaming model text sits
  directly above the composer.

**When finished:**
- No header. Model text renders directly.
- Below it, a subtle inline toggle: `🔧 N tool calls · <terminal status>`
  (e.g. `Completed`, `Failed`) that expands the full timeline on demand.

This is a new `running` / `summary` display mode inside `ToolCallTimeline`. The
existing `ToolCallBlock`, `QuestionCards`, `buildHeader`, and all diff/output
rendering are reused unchanged for the expanded list.

### 4. Questions become a stepper

`QuestionCard`'s **active** form (the editable state) switches from
all-fieldsets-stacked to one sub-question at a time:

- `Back` / `Next` navigation with a `1 of N` progress indicator.
- `Submit answers` replaces `Next` on the last step.
- `Next`/`Submit` disabled until the current sub-question is answered
  (per-question validation, same rule as today's `complete` check applied to the
  current step).
- A single-question request skips the stepper chrome (just the question +
  Submit).
- The `answered` summary state and the `inactive` state are untouched.

## Components touched

| File | Change |
|------|--------|
| `src/frontend/src/components/ChatPanel.tsx` | Swap thin strip for `RunStatusStrip`; add Stop button in composer. |
| `src/frontend/src/components/AgentRunCard.tsx` | Remove `<AgentRunHeader>`; drive new running/finished tool modes; finished = text-first with inline tool toggle. |
| `src/frontend/src/components/ToolCallTimeline.tsx` | Add running/summary accordion mode (active tool + collapsible done-count). |
| `src/frontend/src/components/QuestionCard.tsx` | Active form → stepper. |
| `src/frontend/src/components/AgentRunHeader.tsx` | Lift pure helpers out; header rendering no longer used by the run card. |
| `src/frontend/src/components/runLabels.ts` (new) | Shared `runPhaseLabel`, `terminalLabel`, `formatElapsed`. |

`AgentRunHeader.tsx` becomes unused for rendering once its helpers move to
`runLabels.ts`; delete the component export if nothing else imports it (verify
during implementation).

## Decisions

- **Tool accordion (running):** active tool expanded + collapsible done-count
  summary (chosen over "only active tool" and "collapsed summary only").
- **Question form:** stepper, one at a time (chosen over compact-grouped and
  leave-as-is).
- **Finished runs:** header removed entirely; status conveyed only by the muted
  inline tool-toggle row. No whole-card collapse affordance.

## Testing

- Unit/component tests for `QuestionCard` stepper: navigation, per-step
  validation, single-question shortcut, answered/inactive states unchanged.
- Component test for `ToolCallTimeline` running mode: active tool shown,
  completed folded into count, expand reveals full list, failed count surfaced.
- Verify `RunStatusStrip` ticks while running and degrades without an
  `AgentRunView`.
- Manual preview: long run keeps model text on screen; Stop works from the
  composer; finished run shows text-first with expandable tools.
