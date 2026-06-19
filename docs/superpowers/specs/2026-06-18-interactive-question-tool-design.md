# Interactive Question Tool Design

## Goal

Restore structured question cards in Nexus chat using a native Pi tool as the canonical protocol, while retaining fenced `ask` blocks as a compatibility fallback. A native question pauses the current agent run and resumes that same run after the user answers. Nexus does not infer questions from ordinary Markdown.

## Scope

This design covers:

- A structured Pi question tool supporting one or more questions.
- Single-select and multi-select options.
- An optional custom text response.
- Streaming and rendering a pending question as an interactive card.
- Validating and submitting answers to a suspended tool execution.
- Resuming the same agent run with the answer as its tool result.
- Reconstructing answered native question cards from persisted Pi session messages.
- Parsing a valid terminal fenced `ask` JSON block as a fallback question card.
- Continuing a fallback question through a new user turn.

It does not cover natural-language or Markdown option inference, generic forms, or the broader run-card timeline from issue #80.

## Question Contract

The native tool is named `question`. Its input contains a non-empty `questions` array. Each question has:

- `id`: a stable identifier unique within the call.
- `header`: a short contextual label.
- `question`: the full prompt shown to the user.
- `options`: two or more entries with stable `value`, display `label`, and optional `description`.
- `multiple`: optional boolean, defaulting to `false`.
- `allowOther`: optional boolean, defaulting to `true`.

The tool result is structured JSON containing the tool-call ID and one answer per question. Each answer identifies the question and contains selected option values and, when supplied, a custom response. The accompanying text is concise and readable so models that pay limited attention to structured result details still receive the decision clearly.

The backend validates unique question IDs, unique option values within each question, allowed selections, single-select cardinality, required answers, and custom responses. Invalid tool input returns a normal error tool result. Invalid user submissions return an HTTP validation error without resolving the suspended tool.

## Architecture

### Question extension and broker

A backend question extension registers the Pi tool. Its `execute` function validates and normalizes the request, then registers a pending tool call with an in-memory question broker and awaits its promise.

The broker keys pending entries by thread ID and tool-call ID. The Pi runtime creates each session with a question-extension factory bound to that session's thread ID, so execution cannot leak between threads. The broker exposes bounded operations to register, inspect, answer, cancel, and clear pending questions.

Each tool-call ID can have only one unresolved entry. A duplicate registration fails safely. Answer resolution removes the entry before resolving it, making duplicate submissions deterministic.

### Chat transport

Pi already emits `tool_execution_start` with tool name and arguments. The current NDJSON route forwards that event, so no separate question event is required. The frontend recognizes `question` calls and renders their arguments as a question card while the tool remains running.

A new endpoint accepts an answer for a specific thread and tool-call ID. It validates the payload through the broker, resolves the pending tool execution, and returns success. The original streaming request remains open; Pi receives the tool result and continues the same run.

If the stream is aborted, the route cancels pending questions for that run or thread. Runtime/session teardown also clears pending questions so promises do not remain indefinitely.

### Frontend state and rendering

`usePiStream` retains structured tool arguments and final result data. Question tool calls use the same lifecycle as other tools: `running` means awaiting an answer, while `completed` contains the submitted answer. The question card receives the current tool-call state and submits through the answer endpoint.

The card:

- Uses radio controls for single-select questions and checkboxes for multi-select questions.
- Shows labels and descriptions as clickable rows.
- Offers a custom text field only when `allowOther` is true.
- Disables submission until every question has a valid answer.
- Prevents duplicate submission while the request is in flight.
- Displays validation or network errors without discarding selections.
- Becomes read-only after the tool completes and visibly retains the chosen answers.
- Uses semantic fieldsets, legends, labels, and keyboard-operable controls.

The ordinary composer remains disabled while an agent run, including a pending native question, is active.

## Fenced `ask` Fallback

Nexus recognizes a single terminal fenced block tagged `ask` containing JSON compatible with the native question contract. The block must be the final non-whitespace content in an assistant response. Invalid blocks remain visible as ordinary text.

For a valid block, Nexus renders the preceding text normally and the parsed block as the same question card. Because a fenced response has already completed rather than suspended a tool execution, submission creates a new user turn containing a readable answer summary. That turn uses the normal streaming endpoint and the selected model already associated with the thread.

The fallback parser does not inspect ordinary lists, headings, lettered choices, or prose. This avoids turning rhetorical or informational content into unintended controls.

## Persistence and Reload

Native questions rely on Pi session history:

- The assistant tool-call block contains the original question contract.
- The corresponding tool-result message contains the submitted answer.
- History flattening associates that result with the question call so the frontend can render an answered, read-only card.

An unresolved in-memory question cannot survive a backend restart. On reload, a question tool call without a matching result is shown as interrupted/unavailable, not as an active form. Resuming such a conversation requires a new user message; Nexus must not fabricate a tool result.

Fallback questions and answers use the existing chat/session continuation path. The assistant content retains the fenced contract, while the subsequent user message preserves a readable answer summary.

## Errors and Concurrency

- Answers for unknown, expired, or wrong-thread tool calls return `404`.
- Malformed or invalid answers return `400` and leave the question pending.
- A second valid submission after resolution returns `404` and cannot alter the first result.
- Aborting an active run resolves the tool with a cancellation error and clears the broker entry.
- If the answer endpoint succeeds but the stream disconnects afterward, Pi session persistence remains authoritative for the completed tool result.
- Question card submission errors are displayed inline and can be retried when the pending entry still exists.

## Testing

Backend unit tests cover question normalization, invalid schemas, answer validation, single- and multi-select behavior, custom answers, broker thread isolation, duplicate submission, cancellation, and answer-result formatting.

Backend route tests cover successful answer resolution, wrong-thread and unknown calls, malformed payloads, duplicate answers, and cleanup after abort.

Frontend reducer tests cover recognition of running question tool calls, completion with structured answer data, and history reconstruction.

Component tests cover radio and checkbox interaction, custom responses, disabled submission, successful submission, inline failures, keyboard-accessible labels, and read-only answered state.

Fallback tests cover valid terminal blocks, malformed JSON, non-terminal blocks, ordinary Markdown remaining plain text, answer-summary construction, and continuation through the normal stream.

End-to-end verification uses a model turn that invokes the native question tool, waits visibly, accepts a click, and continues within the same assistant run. A second check uses a model response containing a fenced `ask` block and confirms that answering starts a continuation turn.

## Acceptance Criteria

- A native `question` tool call renders clickable choices instead of a generic tool row.
- Submitting a native answer resumes the same Pi run with a real tool result.
- Multiple questions, multi-select, and custom responses follow their declared constraints.
- Invalid, duplicate, expired, or cross-thread submissions cannot resolve a pending call.
- Answered cards remain readable after completion and reload.
- An incomplete native question after restart is not presented as live.
- A valid terminal fenced `ask` block renders through the same card as a fallback.
- Answering a fallback question starts a normal continuation turn.
- Ordinary Markdown choices are never automatically converted into a question card.
