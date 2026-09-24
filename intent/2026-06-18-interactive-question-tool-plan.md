# Interactive Question Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render native Pi question tool calls as interactive chat cards, resume the same run with validated answers, and support terminal fenced `ask` blocks as a continuation fallback.

**Architecture:** A thread-bound Pi extension suspends question tool execution through an in-memory broker. The existing NDJSON tool lifecycle carries the question to the frontend, a dedicated answer route resolves it, and a React card submits validated selections. A pure parser maps terminal fenced `ask` blocks onto the same frontend contract but answers them through a normal follow-up turn.

**Tech Stack:** TypeScript, Fastify 5, Pi Coding Agent 0.79.6 extension API, TypeBox, React 19, Vitest, Testing Library, Node test runner.

## Global Constraints

- Native structured tool calls are canonical; fenced `ask` JSON is fallback only.
- Never infer question UI from ordinary Markdown or prose.
- Native answers resume the same Pi run by resolving the actual tool execution.
- Fallback answers start a normal continuation turn.
- Unknown, expired, answered, or cross-thread tool calls return `404`; invalid answers return `400`.
- Incomplete persisted tool calls render unavailable, never live.
- Use test-first red-green-refactor for every behavior change.

## File Map

- Create `src/backend/pi/questions.ts`: shared contracts, normalization, answer validation, result formatting, broker, and extension factory.
- Create `src/backend/test/pi-questions.test.ts`: pure contract, broker, and extension execution tests.
- Modify `src/backend/pi/runtime.ts`: own the broker and install a thread-bound question extension.
- Modify `src/backend/routes/chat.ts`: answer route, abort cleanup, and history tool-result association.
- Modify `src/backend/test/pi-runtime.test.ts`: extension registration coverage.
- Modify `src/backend/test/routes-chat.test.ts`: route and history coverage.
- Create `src/frontend/src/lib/questions.ts`: frontend contracts, native/fallback normalization, fenced parser, result parser, and answer summary.
- Create `src/frontend/src/lib/questions.test.ts`: parser and normalization tests.
- Modify `src/frontend/src/hooks/usePiStream.ts`: preserve tool details and expose structured question lifecycle.
- Modify `src/frontend/src/hooks/usePiStream.test.ts`: stream reducer question coverage.
- Modify `src/frontend/src/api.ts`: native question answer client.
- Create `src/frontend/src/components/QuestionCard.tsx`: accessible interactive and read-only card.
- Create `src/frontend/src/components/QuestionCard.test.tsx`: card interaction tests.
- Modify `src/frontend/src/components/ToolCallTimeline.tsx`: delegate question calls to the card.
- Modify `src/frontend/src/components/ChatPanel.tsx`: provide question callbacks and render fallback blocks.
- Modify `src/frontend/src/components/ChatPanel.test.tsx`: native/fallback integration coverage.

---

### Task 1: Question contract, validation, and broker

**Files:**
- Create: `src/backend/pi/questions.ts`
- Create: `src/backend/test/pi-questions.test.ts`

**Interfaces:**
- Produces `QuestionRequest`, `QuestionAnswerSubmission`, `QuestionToolResult`, `normalizeQuestionRequest(value)`, `validateQuestionAnswers(request, value)`, `formatQuestionResult(result)`, `QuestionBroker`, and `createQuestionExtension(threadId, broker)`.
- `QuestionBroker.register(threadId, toolCallId, request, signal)` returns `Promise<QuestionToolResult>`.
- `QuestionBroker.answer(threadId, toolCallId, submission)` returns `{ ok: true } | { ok: false; status: 400 | 404; error: string }`.
- `QuestionBroker.cancelThread(threadId, reason)` resolves and removes all pending entries for the thread.

- [ ] **Step 1: Write failing normalization and answer-validation tests**

Cover a valid single-select request; defaults for `multiple=false` and `allowOther=true`; multiple selections; custom text; duplicate question IDs; duplicate option values; fewer than two options; unknown selections; multiple values on a single-select question; and an unanswered question.

Use concrete inputs such as:

```ts
const request = normalizeQuestionRequest({
  questions: [{
    id: 'scope', header: 'Scope', question: 'Which scope?',
    options: [
      { value: 'small', label: 'Small', description: 'Minimal change' },
      { value: 'full', label: 'Full', description: 'Complete change' },
    ],
  }],
});
assert.equal(request.questions[0].multiple, false);
assert.equal(request.questions[0].allowOther, true);
```

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question contract'`

Expected: FAIL because `../pi/questions` does not exist.

- [ ] **Step 3: Implement minimal contracts and pure validators**

Use discriminated validation results rather than throwing on user input:

```ts
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface QuestionAnswer {
  questionId: string;
  selected: string[];
  custom?: string;
}
```

Trim identifiers and labels, reject empty values, preserve option order, and reject extra or missing question answers.

- [ ] **Step 4: Run the contract tests and verify GREEN**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question contract'`

Expected: all matching tests PASS.

- [ ] **Step 5: Write failing broker lifecycle tests**

Prove that `register` remains pending, a valid answer resolves it, wrong-thread and unknown calls return `404`, invalid answers return `400` without resolution, duplicate registration rejects, a second answer returns `404`, and `cancelThread` resolves a cancelled result.

- [ ] **Step 6: Run broker tests and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question broker'`

Expected: FAIL because broker methods are not implemented.

- [ ] **Step 7: Implement the broker and deterministic result text**

Store pending entries under `${threadId}:${toolCallId}`, remove before resolving, detach abort listeners during cleanup, and return JSON plus readable text such as `Scope: Small` from `formatQuestionResult`.

- [ ] **Step 8: Run all question unit tests and commit**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question'`

Expected: PASS.

Commit: `git commit -am "feat(chat): add question contract and broker"` after staging both new files.

---

### Task 2: Native Pi tool and runtime wiring

**Files:**
- Modify: `src/backend/pi/questions.ts`
- Modify: `src/backend/pi/runtime.ts`
- Modify: `src/backend/test/pi-questions.test.ts`
- Modify: `src/backend/test/pi-runtime.test.ts`

**Interfaces:**
- Consumes Task 1's broker and normalization functions.
- Produces `PiRuntime.questions: QuestionBroker` and installs `createQuestionExtension(threadId, questions)` for every session.

- [ ] **Step 1: Write a failing extension test**

Use a fake `ExtensionAPI` that captures `registerTool`. Assert the registered tool is named `question`, exposes a non-empty description and TypeBox parameters, and its `execute('call-1', validParams, signal, ...)` remains pending until `broker.answer('thread-1', 'call-1', submission)` resolves it with text content and structured details.

- [ ] **Step 2: Run the extension test and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question extension'`

Expected: FAIL because the extension is not registered.

- [ ] **Step 3: Implement `createQuestionExtension`**

Import `Type` from `typebox`, register the schema under tool name `question`, normalize before broker registration, return `isError: true` for invalid tool arguments, and return `{ content: [{ type: 'text', text }], details: result }` after an answer or cancellation.

- [ ] **Step 4: Run the extension test and verify GREEN**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question extension'`

Expected: PASS.

- [ ] **Step 5: Write a failing runtime-options test**

Extend `buildResourceLoaderOptions` coverage or add an injectable helper assertion proving the question extension is included after `anthropicMessagesBridge` and before/alongside the signal-filter extension for a thread-bound session.

- [ ] **Step 6: Run the runtime test and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question extension factory'`

Expected: FAIL because runtime does not install the factory.

- [ ] **Step 7: Wire the broker into `PiRuntime`**

Instantiate one broker per runtime, pass `threadId` into `createQuestionExtension`, clear the thread in `dropSession`, and preserve the current signal-filter extension.

- [ ] **Step 8: Run backend question/runtime tests and commit**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question|PiRuntime|ResourceLoader'`

Expected: PASS.

Commit: `feat(chat): register native question tool`.

---

### Task 3: Answer route and stream cleanup

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Modify: `src/backend/test/routes-chat.test.ts`

**Interfaces:**
- Adds `POST /api/threads/:threadId/questions/:toolCallId/answer` with body `{ answers: QuestionAnswer[] }` and response `{ ok: true }`.
- Consumes `fastify.pi.questions.answer` and `cancelThread`.

- [ ] **Step 1: Write failing answer-route tests**

Build the route test app with a real `QuestionBroker`. Register `call-1`, POST a valid answer, and assert `200`, `{ ok: true }`, and promise resolution. Add tests for invalid answers (`400`), unknown/cross-thread calls (`404`), and duplicate submission (`404`).

- [ ] **Step 2: Run route tests and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question answer route'`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement the answer route**

Validate that the chat thread exists first, delegate answer validation to the broker, set the returned status code exactly, and never start a second prompt from this endpoint.

- [ ] **Step 4: Run answer-route tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing abort-cleanup tests**

Register a pending question, call `/api/threads/:threadId/abort`, and assert its promise resolves cancelled and the broker no longer accepts an answer. Cover confirmed cancellation of a conflicting stream as well.

- [ ] **Step 6: Run cleanup tests and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question cleanup'`

Expected: FAIL because abort paths leave broker entries pending.

- [ ] **Step 7: Add cleanup to every terminal stream path**

Call `cancelThread` when a stream aborts, when confirmed cancellation aborts another thread, and when thread deletion drops a session. Do not cancel a successfully answered call during normal stream completion.

- [ ] **Step 8: Run route tests and commit**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question|abort|project busy'`

Expected: PASS.

Commit: `feat(chat): answer and cancel pending questions`.

---

### Task 4: History association and frontend question utilities

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Modify: `src/backend/test/routes-chat.test.ts`
- Create: `src/frontend/src/lib/questions.ts`
- Create: `src/frontend/src/lib/questions.test.ts`
- Modify: `src/frontend/src/hooks/usePiStream.ts`
- Modify: `src/frontend/src/hooks/usePiStream.test.ts`

**Interfaces:**
- Backend history attaches matching question tool results as `result`, `details`, and terminal status on the original assistant tool call.
- Frontend produces `parseTerminalAskBlock(text)`, `normalizeQuestionRequest(value)`, `parseQuestionResult(value)`, and `buildQuestionAnswerSummary(request, answers)`.
- `ToolCallInfo` gains typed `details?: unknown` and keeps final result text.

- [ ] **Step 1: Write a failing history reconstruction test**

Pass `flattenEntries` an assistant `question` tool call followed by its matching `toolResult`; assert the assistant call is `completed` with result/details. With no result, assert it is `interrupted`, not `running` or `completed`.

- [ ] **Step 2: Run the history test and verify RED**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question history'`

Expected: FAIL because tool calls are always flattened as completed without results.

- [ ] **Step 3: Implement history association**

Index tool-result entries by `toolCallId`, parse question result JSON from content/details when available, attach it to the assistant tool call, and retain non-question tool-result behavior unchanged.

- [ ] **Step 4: Run history tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing frontend utility tests**

Cover valid native normalization, valid terminal fenced JSON, leading preamble extraction, malformed JSON, a non-terminal fence, ordinary A/B Markdown, answer-result parsing, and deterministic fallback summary text.

Example fallback:

```ts
const parsed = parseTerminalAskBlock('Choose:\n```ask\n{"questions":[...]}\n```');
expect(parsed?.preamble).toBe('Choose:');
expect(parseTerminalAskBlock('A. One\nB. Two')).toBeNull();
```

- [ ] **Step 6: Run utility tests and verify RED**

Run: `npm test --workspace=src/frontend -- src/lib/questions.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 7: Implement pure frontend utilities**

Mirror the backend contract without importing backend code. Require the fence to end at the final non-whitespace character, return `null` for invalid input, and ensure the summary contains labels/custom text rather than opaque option values.

- [ ] **Step 8: Write and pass reducer lifecycle tests**

First add tests proving `tool_execution_start`/`TOOL_CALL_START` retains question args and `TOOL_CALL_UPDATE` retains completed result/details. Observe RED, then minimally widen `StreamMessage.toolCalls` and routing patches. Run: `npm test --workspace=src/frontend -- src/hooks/usePiStream.test.ts`.

- [ ] **Step 9: Run both workspaces' focused tests and commit**

Run: `npm test --workspace=src/backend -- --test-name-pattern='question history'` and `npm test --workspace=src/frontend -- src/lib/questions.test.ts src/hooks/usePiStream.test.ts`.

Expected: PASS.

Commit: `feat(chat): reconstruct and parse question messages`.

---

### Task 5: Accessible question card

**Files:**
- Create: `src/frontend/src/components/QuestionCard.tsx`
- Create: `src/frontend/src/components/QuestionCard.test.tsx`
- Modify: `src/frontend/src/api.ts`

**Interfaces:**
- `api.chat.answerQuestion(threadId, toolCallId, answers)` calls the native answer endpoint.
- `QuestionCard` props are `{ request, answeredResult?, unavailable?, submitting?, error?, onSubmit }`.
- `onSubmit(answers: QuestionAnswer[]): Promise<void>` owns transport outside the component.

- [ ] **Step 1: Write failing single-select and completeness tests**

Render a request with two questions. Assert semantic group names, radio behavior, clickable descriptions, disabled submit until complete, and the exact answer payload after submission.

- [ ] **Step 2: Run component tests and verify RED**

Run: `npm test --workspace=src/frontend -- src/components/QuestionCard.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement minimal interactive card**

Use `<fieldset>`, `<legend>`, labelled radio/checkbox inputs, a labelled custom text input, and a real submit button. Preserve selections while `submitting` or after an error.

- [ ] **Step 4: Run tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing multi-select, custom, error, answered, and unavailable tests**

Assert checkbox toggling; custom text satisfying a question; inline error copy; read-only chosen labels from `answeredResult`; and no submit button for unavailable interrupted calls.

- [ ] **Step 6: Run expanded tests and verify RED**

Expected failures must correspond to missing states.

- [ ] **Step 7: Implement the remaining card states and API client**

Add `answerQuestion` through existing `fetchJson`; do not call it directly inside the card. Render explicit `This question is no longer active` copy for interrupted history.

- [ ] **Step 8: Run component tests, typecheck, and commit**

Run: `npm test --workspace=src/frontend -- src/components/QuestionCard.test.tsx` and `npm run typecheck --workspace=src/frontend`.

Expected: PASS.

Commit: `feat(chat): add interactive question card`.

---

### Task 6: Native and fallback chat integration

**Files:**
- Modify: `src/frontend/src/components/ToolCallTimeline.tsx`
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/frontend/src/components/ChatPanel.test.tsx`

**Interfaces:**
- Native question rows call `api.chat.answerQuestion(threadId, toolCallId, answers)`.
- Fallback cards call existing `submit(buildQuestionAnswerSummary(...))`, preserving the selected thread/model behavior.
- `ToolCallTimeline` receives optional `{ threadId, onQuestionAnswered }` or a focused `onAnswerQuestion(toolCallId, answers)` callback; it remains transport-agnostic.

- [ ] **Step 1: Write a failing native integration test**

Mock history or NDJSON with a running `question` tool call, render `ChatPanel`, click an option and submit, then assert one POST to `/api/threads/t1/questions/call-1/answer` and no POST to `/messages/stream` for the answer.

- [ ] **Step 2: Run native integration test and verify RED**

Run: `npm test --workspace=src/frontend -- src/components/ChatPanel.test.tsx -t 'native question'`

Expected: FAIL because the timeline renders a generic tool row.

- [ ] **Step 3: Integrate native cards**

Detect tool name `question`, normalize its args, pass completed result or unavailable state, manage per-call submission errors in `ChatPanel`, and keep generic rendering for invalid question arguments.

- [ ] **Step 4: Run native integration test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing fallback integration tests**

Return persisted assistant content ending in a valid `ask` fence. Assert preamble plus card render, raw fence hidden, and submission starts exactly one normal `/messages/stream` turn containing the readable answer summary. Add ordinary Markdown and malformed/non-terminal fences that stay ordinary text.

- [ ] **Step 6: Run fallback tests and verify RED**

Run: `npm test --workspace=src/frontend -- src/components/ChatPanel.test.tsx -t 'fallback question|ordinary Markdown'`

Expected: FAIL because assistant content is rendered as undifferentiated Markdown.

- [ ] **Step 7: Integrate fallback rendering and continuation**

Parse only non-streaming completed assistant content. Render the preamble through the existing message renderer and the card beneath it. On submit, call the existing `submit` path so busy-state, model selection, transcript updates, and stream lifecycle remain centralized.

- [ ] **Step 8: Run ChatPanel tests, typecheck, and commit**

Run: `npm test --workspace=src/frontend -- src/components/ChatPanel.test.tsx src/components/QuestionCard.test.tsx` and `npm run typecheck --workspace=src/frontend`.

Expected: PASS.

Commit: `feat(chat): render native and fallback questions`.

---

### Task 7: Full verification and issue-level regression coverage

**Files:**
- Modify only if verification exposes a defect in files already listed above.

**Interfaces:**
- No new interfaces; this task proves the complete issue contract.

- [ ] **Step 1: Run backend tests**

Run: `npm test --workspace=src/backend`

Expected: all tests PASS with no unhandled promise rejection or open-handle warning.

- [ ] **Step 2: Run frontend tests**

Run: `npm test --workspace=src/frontend`

Expected: all tests PASS with no React `act` or accessibility warnings introduced by this feature.

- [ ] **Step 3: Run repository typecheck and build**

Run: `npm run typecheck` followed by `npm run build`.

Expected: both exit `0`.

- [ ] **Step 4: Run diff hygiene checks**

Run: `git diff --check`, `git status --short`, and inspect `git diff --stat`.

Expected: no whitespace errors and only issue #82 files changed.

- [ ] **Step 5: Manually verify both protocols**

Start Nexus, use a model instructed to invoke `question`, confirm the run visibly waits, select an answer, and confirm the same stream continues. Then send a controlled model response ending in a valid fenced `ask` block and confirm its answer creates one continuation turn. Confirm ordinary A/B Markdown remains text.

- [ ] **Step 6: Final commit if verification required fixes**

If fixes were necessary, rerun the affected red-green cycle and commit as `fix(chat): complete interactive question flow`. Otherwise do not create an empty commit.
