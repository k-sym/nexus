# Run Status Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the duplicated run-status header from the response bubble, pin one live status strip above the composer with a Stop button, collapse the tool-call list to an expandable summary, and turn multi-part question forms into a stepper — so the model's text output stays on screen during a run.

**Architecture:** Presentation-only React changes in `src/frontend`. Pure label helpers move to a shared module so the composer strip and the run card share them. `AgentRunCard` drops its header and delegates tool rendering to a new `ToolActivity` accordion. `QuestionCard`'s active form becomes a stepper. No backend, event-stream, or reducer changes.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, Tailwind utility classes, @phosphor-icons/react.

## Global Constraints

- All commands run from `src/frontend` (the frontend workspace).
- Run tests with `npx vitest run <path>`; typecheck with `npm run typecheck`.
- Preserve these stable hooks used by tests: `data-testid="run-status"`, `data-testid="send-button"`, `data-testid="composer-actions"`, and the Stop button's `aria-label="Stop current run"`.
- Do not change `src/frontend/src/chat/agent-run-state.ts` or `usePiStream.ts`.
- Follow existing Tailwind token classes (`text-faint`, `surface-glass`, `border-subtle`, `accent-button`, etc.).

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/frontend/src/components/runLabels.ts` (new) | Pure helpers `runPhaseLabel`, `terminalLabel`, `formatElapsed`. |
| `src/frontend/src/components/RunStatusStrip.tsx` (new) | Live status strip above composer: phase · elapsed · last activity · model. Ticks every 1s while running. Info only — no button. |
| `src/frontend/src/components/ChatPanel.tsx` (modify) | Render `RunStatusStrip` while running; swap Send → Stop in the composer-actions column; drop the old inline strip and dead `isLatest` plumbing. |
| `src/frontend/src/components/ToolCallTimeline.tsx` (modify) | Add exported `ToolActivity` accordion (active-tool + collapsible done-count summary). Existing `ToolCallTimeline`, `ToolCallBlock`, `QuestionCards` unchanged. |
| `src/frontend/src/components/AgentRunCard.tsx` (modify) | Remove `<AgentRunHeader>`; text-first for finished runs; `ToolActivity` for tools; always show content. |
| `src/frontend/src/components/AgentRunHeader.tsx` (delete) | Superseded once helpers move and the card stops using it. |
| `src/frontend/src/components/QuestionCard.tsx` (modify) | Active form → stepper (Back/Next/Submit, `Step X of N`). |

---

## Task 1: Extract shared run-label helpers

**Files:**
- Create: `src/frontend/src/components/runLabels.ts`
- Modify: `src/frontend/src/components/ChatPanel.tsx:27` (import path)
- Modify: `src/frontend/src/components/AgentRunHeader.tsx` (import helpers instead of defining, temporarily)

**Interfaces:**
- Produces: `runPhaseLabel(run: AgentRunView): string`, `terminalLabel(run: AgentRunView): string`, `formatElapsed(ms: number): string`.

- [ ] **Step 1: Create the shared module**

Create `src/frontend/src/components/runLabels.ts` with the exact bodies currently in `AgentRunHeader.tsx`:

```ts
import type { AgentRunView } from '../chat/agent-run-state';

export function runPhaseLabel(run: AgentRunView): string {
  const active = [...run.tools].reverse().find((tool) => tool.status === 'running');
  if (active?.name === 'Bash') return 'Running command';
  if (active?.name === 'Write') return 'Writing file';
  if (active?.name === 'Edit') return 'Editing file';
  if (active?.name === 'Read') return 'Reading file';
  if (active) return `Running ${active.name}`;
  if (run.phase === 'preparing_tool') return 'Preparing tool input';
  if (run.phase === 'tool_queued') return 'Tool queued';
  if (run.phase === 'model_responding') return 'Model responding';
  return 'Waiting for first provider event';
}

export function terminalLabel(run: AgentRunView): string {
  if (run.status === 'cancelled' && run.abortSource === 'user') return 'Cancelled by user';
  if (run.status === 'cancelled' && run.abortSource === 'frontend') return 'Cancelled by frontend';
  if (run.status === 'cancelled') return 'Cancelled';
  if (run.status === 'interrupted') return 'Interrupted';
  if (run.status === 'failed') return run.abortSource ? `Failed · ${run.abortSource}` : 'Failed';
  return 'Completed';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
```

- [ ] **Step 2: Point AgentRunHeader at the shared module**

In `src/frontend/src/components/AgentRunHeader.tsx`, delete the local `runPhaseLabel`, `terminalLabel`, and `formatElapsed` definitions and re-export/import from `./runLabels`. Add at the top:

```ts
import { runPhaseLabel, terminalLabel, formatElapsed } from './runLabels';
export { runPhaseLabel, terminalLabel } from './runLabels';
```

(Keep `AgentRunHeader.tsx` compiling for now; it is deleted in Task 4. `formatElapsed` is used internally by the component body — the import above supplies it.)

- [ ] **Step 3: Update ChatPanel import**

In `src/frontend/src/components/ChatPanel.tsx:27`, change:

```ts
import { runPhaseLabel } from './AgentRunHeader';
```

to:

```ts
import { runPhaseLabel } from './runLabels';
```

- [ ] **Step 4: Typecheck and run affected tests**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run src/components/AgentRunCard.test.tsx src/components/ChatPanel.test.tsx`
Expected: PASS (pure refactor, behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/runLabels.ts src/frontend/src/components/AgentRunHeader.tsx src/frontend/src/components/ChatPanel.tsx
git commit -m "refactor: extract run-label helpers into runLabels module"
```

---

## Task 2: Live status strip + Stop in the composer

**Files:**
- Create: `src/frontend/src/components/RunStatusStrip.tsx`
- Create: `src/frontend/src/components/RunStatusStrip.test.tsx`
- Modify: `src/frontend/src/components/ChatPanel.tsx` (render strip; swap Send→Stop; remove old inline strip)

**Interfaces:**
- Consumes: `runPhaseLabel`, `formatElapsed` from `./runLabels`; `AgentRunView` from `../chat/agent-run-state`.
- Produces: `RunStatusStrip({ run: AgentRunView | null, fallbackLabel: string }): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/components/RunStatusStrip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RunStatusStrip } from './RunStatusStrip';
import type { AgentRunView } from '../chat/agent-run-state';

function run(overrides: Partial<AgentRunView> = {}): AgentRunView {
  return {
    runId: 'r1', threadId: 't1', status: 'running', phase: 'model_responding',
    startedAt: Date.now() - 5_000, lastEventAt: Date.now() - 2_000,
    provider: 'openrouter', model: 'glm-5.2', tools: [], ...overrides,
  };
}

describe('RunStatusStrip', () => {
  it('shows phase, elapsed, last-activity, and model from the run view', () => {
    render(<RunStatusStrip run={run()} fallbackLabel="Working…" />);
    const strip = screen.getByTestId('run-status');
    expect(strip).toHaveTextContent('Model responding');
    expect(strip).toHaveTextContent(/last activity/i);
    expect(strip).toHaveTextContent('openrouter/glm-5.2');
  });

  it('falls back to the coarse label when no run view is available', () => {
    render(<RunStatusStrip run={null} fallbackLabel="Thinking" />);
    const strip = screen.getByTestId('run-status');
    expect(strip).toHaveTextContent('Thinking');
    expect(strip).not.toHaveTextContent(/last activity/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/RunStatusStrip.test.tsx`
Expected: FAIL ("Failed to resolve import ./RunStatusStrip").

- [ ] **Step 3: Implement the strip**

Create `src/frontend/src/components/RunStatusStrip.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Spinner } from '@phosphor-icons/react';
import type { AgentRunView } from '../chat/agent-run-state';
import { runPhaseLabel, formatElapsed } from './runLabels';

interface RunStatusStripProps {
  run: AgentRunView | null;
  fallbackLabel: string;
}

export function RunStatusStrip({ run, fallbackLabel }: RunStatusStripProps) {
  const [now, setNow] = useState(Date.now());
  const isRunning = run?.status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const label = run ? runPhaseLabel(run) : fallbackLabel;
  const model = run ? [run.provider, run.model].filter(Boolean).join('/') : '';

  return (
    <div
      className="flex items-center gap-2 border-t border-subtle px-4 py-1.5 text-xs text-indigo-200"
      data-testid="run-status"
      aria-live="polite"
    >
      <Spinner className="h-3.5 w-3.5 animate-spin flex-shrink-0" aria-hidden="true" />
      <span className="font-medium">{label}</span>
      {run && (
        <>
          <span className="text-[11px] text-faint">{formatElapsed(now - run.startedAt)}</span>
          <span className="text-[11px] text-faint">· last activity {formatElapsed(now - run.lastEventAt)} ago</span>
          {model && (
            <span className="ml-auto truncate text-[10px] text-faint" title={model}>{model}</span>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/RunStatusStrip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the strip into ChatPanel**

In `src/frontend/src/components/ChatPanel.tsx`:

1. Add import near the other component imports:

```ts
import { RunStatusStrip } from './RunStatusStrip';
```

2. Replace the `runStatusLabel` computation (currently ~lines 644-650) with a run view + fallback label:

```ts
const activeRunView: AgentRunView | null =
  (state.isRunning && state.activeRun) ? state.activeRun : (attachedRun ?? null);
const runFallbackLabel = streamStatusLabel(state.status);
```

(Keep the `attachedRun` line above it unchanged. `AgentRunView` is already imported in ChatPanel via the run types; if not, add `import type { AgentRunView } from '../chat/agent-run-state';`.)

3. Replace the old inline strip block (currently ~lines 766-775, the `{runStatusLabel && (…<div data-testid="run-status">…)}`) with:

```tsx
{isRunning && (
  <RunStatusStrip run={activeRunView} fallbackLabel={runFallbackLabel} />
)}
```

- [ ] **Step 6: Swap Send → Stop in the composer-actions column**

In `src/frontend/src/components/ChatPanel.tsx`, the composer-actions column (currently ~lines 838-851) renders the Send button only when `!isRunning`. Add a Stop button for the running case so it reads:

```tsx
<div className="flex min-w-[7.5rem] flex-col items-stretch gap-1" data-testid="composer-actions">
  <ContextUsageLabel usage={state.contextUsage} />
  {isRunning ? (
    <button
      type="button"
      onClick={handleStop}
      aria-label="Stop current run"
      className="px-4 py-2 accent-button rounded-lg transition-colors"
    >
      Stop
    </button>
  ) : (
    <button
      type="button"
      onClick={handleSend}
      data-testid="send-button"
      disabled={(!input.trim() && pendingAttachments.length === 0) || imageModelBlocked}
      className="px-4 py-2 accent-button rounded-lg disabled:opacity-40 transition-colors"
    >
      Send
    </button>
  )}
</div>
```

- [ ] **Step 7: Typecheck and run ChatPanel tests**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run src/components/ChatPanel.test.tsx`
Expected: PASS. The run-status strip test (`shows a persistent run-status strip while a turn is running`) still finds `run-status` with a matching label; the re-attach test still finds the `Stop current run` button (now in the composer) and confirms `send-button` is absent while running.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/components/RunStatusStrip.tsx src/frontend/src/components/RunStatusStrip.test.tsx src/frontend/src/components/ChatPanel.tsx
git commit -m "feat: single live run-status strip with Stop in the composer"
```

---

## Task 3: ToolActivity accordion

**Files:**
- Modify: `src/frontend/src/components/ToolCallTimeline.tsx` (add `ToolActivity`)
- Modify: `src/frontend/src/components/ToolCallTimeline.test.tsx` (add `ToolActivity` tests)

**Interfaces:**
- Consumes: existing `ToolCallInfo`, `ToolCallBlock`, `isQuestionTool` in the same file.
- Produces: `ToolActivity({ toolCalls: ToolCallInfo[], running: boolean, detailsExpanded?: boolean, terminalLabel?: string }): JSX.Element | null`.

- [ ] **Step 1: Write the failing tests**

Add to `src/frontend/src/components/ToolCallTimeline.test.tsx` (import `ToolActivity` at the top: `import { ToolCallTimeline, QuestionCards, ToolActivity } from './ToolCallTimeline';`):

```tsx
describe('ToolActivity', () => {
  const finishedTools = [
    { id: '1', name: 'Read', args: { path: '/a' }, status: 'succeeded' as const },
    { id: '2', name: 'Bash', args: { command: 'npm test' }, status: 'failed' as const, result: 'boom' },
  ];

  it('while running shows the active tool and folds the rest into a count', () => {
    render(<ToolActivity
      running
      toolCalls={[
        { id: '1', name: 'Read', args: { path: '/a' }, status: 'succeeded' },
        { id: '2', name: 'Bash', args: { command: 'npm test' }, status: 'running' },
      ]}
    />);
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();      // active tool shown
    expect(screen.getByText(/2 tool calls/)).toBeVisible();          // summary count
    expect(screen.queryByText(/read/i)).not.toBeInTheDocument();     // completed folded away
  });

  it('when finished shows a collapsed summary with the terminal label and expands on click', () => {
    render(<ToolActivity running={false} toolCalls={finishedTools} terminalLabel="Completed" />);
    const summary = screen.getByRole('button', { name: /2 tool calls/ });
    expect(summary).toHaveTextContent('1 failed');
    expect(summary).toHaveTextContent('Completed');
    expect(screen.queryByText(/npm test/)).not.toBeInTheDocument();  // list hidden by default
    fireEvent.click(summary);
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();       // full list revealed
  });

  it('renders nothing when there are no non-question tools', () => {
    const { container } = render(<ToolActivity running={false} toolCalls={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/ToolCallTimeline.test.tsx`
Expected: FAIL ("ToolActivity is not exported" / not a function).

- [ ] **Step 3: Implement ToolActivity**

In `src/frontend/src/components/ToolCallTimeline.tsx`, add `CaretDown`, `CaretUp`, `Wrench` to the phosphor import and append this component (after `ToolCallBlock`):

```tsx
interface ToolActivityProps {
  toolCalls: ToolCallInfo[];
  running: boolean;
  detailsExpanded?: boolean;
  terminalLabel?: string;
}

/** Compact tool view for an agent run: while running, only the active tool is
 *  shown with the rest folded into a clickable count; when finished, a single
 *  summary row expands the full timeline on demand. Keeps model text on screen. */
export function ToolActivity({ toolCalls, running, detailsExpanded, terminalLabel }: ToolActivityProps) {
  const [expanded, setExpanded] = useState(false);
  const tools = toolCalls.filter((tc) => !isQuestionTool(tc));
  if (tools.length === 0) return null;

  const showFull = !!detailsExpanded || expanded;
  const failed = tools.filter((tc) => tc.status === 'failed' || tc.status === 'error').length;
  const activeTool = running
    ? [...tools].reverse().find((tc) => tc.status === 'running')
    : undefined;
  const count = tools.length;
  const summaryText = `${count} tool call${count === 1 ? '' : 's'}${failed > 0 ? ` · ${failed} failed` : ''}`;

  return (
    <div className="flex flex-col gap-1 my-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={showFull}
        className="flex items-center gap-1.5 px-1 py-0.5 w-full text-left text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        <Wrench className="w-3 h-3 flex-shrink-0 text-zinc-500" />
        <span>{summaryText}</span>
        {!running && terminalLabel && (
          <span className={failed > 0 ? 'text-red-400' : 'text-emerald-400'}>· {terminalLabel}</span>
        )}
        {showFull ? <CaretUp className="ml-auto w-3 h-3" /> : <CaretDown className="ml-auto w-3 h-3" />}
      </button>

      {showFull
        ? tools.map((tc) => (
            <ToolCallBlock key={tc.id} toolCall={tc} detailsExpanded={detailsExpanded} />
          ))
        : activeTool && (
            <ToolCallBlock key={activeTool.id} toolCall={activeTool} detailsExpanded={detailsExpanded} />
          )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/ToolCallTimeline.test.tsx`
Expected: PASS (including the two pre-existing `ToolCallTimeline`/`QuestionCards` tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/ToolCallTimeline.tsx src/frontend/src/components/ToolCallTimeline.test.tsx
git commit -m "feat: ToolActivity accordion for compact run tool display"
```

---

## Task 4: Rework AgentRunCard (drop header, text-first)

**Files:**
- Modify: `src/frontend/src/components/AgentRunCard.tsx`
- Delete: `src/frontend/src/components/AgentRunHeader.tsx`
- Modify: `src/frontend/src/components/AgentRunCard.test.tsx`
- Modify: `src/frontend/src/components/ChatPanel.tsx` (remove now-dead `isLatest` plumbing)

**Interfaces:**
- Consumes: `ToolActivity` (Task 3), `terminalLabel` from `./runLabels`, `ThinkingBlock`, `ChatMessageContent`, `QuestionCards`.
- Produces: `AgentRunCard` with props unchanged **except** `isLatest` is removed.

- [ ] **Step 1: Rewrite the AgentRunCard tests to the new behavior**

Replace `src/frontend/src/components/AgentRunCard.test.tsx` body with tests that reflect: no header; content always visible; tools collapsed to a summary. Keep the `run()` factory. Replace the `describe` block with:

```tsx
describe('AgentRunCard', () => {
  it('while running shows the active tool and the streaming content, no header', () => {
    render(<AgentRunCard run={run()} content="Partial answer" thinking="" detailsExpanded={false} onStop={vi.fn()} />);
    expect(screen.getByText('Partial answer')).toBeVisible();
    expect(screen.getByText(/bash.*npm test/i)).toBeVisible();
    // Status/timing/model now live in the composer strip, not the card.
    expect(screen.queryByText('openrouter/model-1')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop current run' })).not.toBeInTheDocument();
  });

  it('shows finished content text-first with an expandable tool summary', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed', phase: 'finalizing', completedAt: Date.now(),
        tools: [
          { id: '1', name: 'Read', args: {}, status: 'succeeded', queuedAt: 1, completedAt: 2 },
          { id: '2', name: 'Bash', args: {}, status: 'failed', queuedAt: 1, completedAt: 2, error: 'failed' },
        ],
      })}
      content="Finished" thinking="" detailsExpanded={false} onStop={() => {}}
    />);
    expect(screen.getByText('Finished')).toBeVisible();                 // content shown (text-first)
    const summary = screen.getByRole('button', { name: /2 tool calls/ });
    expect(summary).toHaveTextContent('1 failed');
    expect(summary).toHaveTextContent('Completed');
  });

  it('surfaces an interrupted run error and terminal label', () => {
    render(<AgentRunCard
      run={run({ status: 'interrupted', phase: 'finalizing', completedAt: Date.now(), error: 'Stream disconnected' })}
      content="" thinking="" detailsExpanded={false} onStop={() => {}}
    />);
    expect(screen.getByText('Stream disconnected')).toBeVisible();
    expect(screen.getByRole('button', { name: /tool call/ })).toHaveTextContent('Interrupted');
  });

  it('places the question card after the assistant prelude text, at the bottom (issue #109)', () => {
    render(<AgentRunCard
      run={run({
        status: 'completed', phase: 'finalizing', completedAt: Date.now(),
        tools: [
          { id: 'q1', name: 'question', args: {
            questions: [{ id: 'q', header: 'Choose', question: 'Which option do you prefer?',
              multiple: false, allowOther: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }],
          }, status: 'running', queuedAt: 1, startedAt: 2 },
        ],
      })}
      content="Before I continue, which option do you prefer?"
      thinking="" detailsExpanded={false} onStop={() => {}}
    />);
    const prelude = screen.getByText('Before I continue, which option do you prefer?');
    const questionPrompt = screen.getByText('Which option do you prefer?');
    expect(prelude.compareDocumentPosition(questionPrompt)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('renders generated file paths in run content as preview controls', () => {
    const onOpenArtifact = vi.fn();
    const filePath = '/Users/k-sym/Projects/baker-internal/chat-preview-test.md';
    render(<AgentRunCard
      run={run({ status: 'completed', phase: 'finalizing', completedAt: Date.now(), tools: [] })}
      content={`Created it here:\n\n\`${filePath}\``}
      thinking="" detailsExpanded onStop={() => {}} onOpenArtifact={onOpenArtifact}
    />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview chat-preview-test.md' }));
    expect(onOpenArtifact).toHaveBeenCalledWith(filePath);
  });
});
```

(Removed: the `isLatest`-based collapse tests for issue #108 — that behavior is intentionally gone; finished content is always visible now. The `import` line for `AgentRunView` and the `run()` factory stay.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/AgentRunCard.test.tsx`
Expected: FAIL (old card still renders the header with model text / no summary button).

- [ ] **Step 3: Rewrite AgentRunCard**

Replace `src/frontend/src/components/AgentRunCard.tsx` with:

```tsx
import type { AgentRunView } from '../chat/agent-run-state';
import type { QuestionAnswer, QuestionToolResult } from '../lib/questions';
import { terminalLabel } from './runLabels';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolActivity, QuestionCards } from './ToolCallTimeline';
import ChatMessageContent from './ChatMessageContent';

interface AgentRunCardProps {
  run: AgentRunView;
  content: string;
  thinking?: string | null;
  detailsExpanded: boolean;
  onStop: () => void;
  questionState?: Record<string, { submitting?: boolean; error?: string; result?: QuestionToolResult }>;
  onAnswerQuestion?: (toolCallId: string, answers: QuestionAnswer[]) => Promise<void>;
  onOpenArtifact?: (path: string) => void;
}

export function AgentRunCard({
  run,
  content,
  thinking,
  detailsExpanded,
  questionState,
  onAnswerQuestion,
  onOpenArtifact,
}: AgentRunCardProps) {
  const running = run.status === 'running';

  const toolActivity = (
    <ToolActivity
      toolCalls={run.tools}
      running={running}
      detailsExpanded={detailsExpanded}
      terminalLabel={running ? undefined : terminalLabel(run)}
    />
  );

  const thinkingBlock = thinking ? (
    <ThinkingBlock
      thinking={thinking}
      isThinking={running && run.phase === 'model_responding'}
      expanded={detailsExpanded}
    />
  ) : null;

  const contentBlock = content ? (
    <div className="whitespace-pre-wrap text-sm">
      {onOpenArtifact ? <ChatMessageContent text={content} onOpenPath={onOpenArtifact} /> : content}
    </div>
  ) : null;

  return (
    <section className="agent-run-card w-full max-w-[88%] space-y-2 overflow-hidden rounded-xl border border-subtle surface-glass px-3 py-2 text-primary">
      {/* Running: show live tool activity first, then the emerging text. Finished:
          lead with the model's text and tuck tool detail into the summary below
          (issue: keep model output on screen; header removed). */}
      {running ? (
        <>
          {toolActivity}
          {thinkingBlock}
          {contentBlock}
        </>
      ) : (
        <>
          {thinkingBlock}
          {contentBlock}
          {toolActivity}
        </>
      )}
      {run.error && run.status !== 'completed' && (
        <p className="text-xs text-red-300" role="alert">{run.error}</p>
      )}
      {/* Question cards render last so the ask sits at the bottom of the bubble
          next to where the user replies (issue #109). */}
      <QuestionCards
        toolCalls={run.tools}
        questionState={questionState}
        onAnswerQuestion={onAnswerQuestion}
      />
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/AgentRunCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Remove dead `isLatest` plumbing and delete AgentRunHeader**

1. Delete the file `src/frontend/src/components/AgentRunHeader.tsx`.
2. In `src/frontend/src/components/ChatPanel.tsx`:
   - Remove the `isLatest={m.id === latestAssistantId}` prop passed to `MessageBubble` (~line 727).
   - Remove `isLatest` from `MessageBubble`'s props destructuring and its TS prop type (~lines 866-885), and remove `isLatest={isLatest}` from the `<AgentRunCard>` call (~line 900).
   - Remove the now-unused `latestAssistantId` computation (~line 639) and the `findLatestAssistantId` helper (~lines 1032-1038).

Run: `grep -rn "AgentRunHeader\|isLatest\|findLatestAssistantId\|latestAssistantId" src/frontend/src`
Expected: no matches (except possibly in unrelated history/comments — there should be none in code).

- [ ] **Step 6: Typecheck and run the full frontend test suite**

Run: `npm run typecheck`
Expected: no errors.

Run: `npx vitest run`
Expected: PASS across the suite.

- [ ] **Step 7: Commit**

```bash
git add -A src/frontend/src/components
git commit -m "feat: header-less AgentRunCard, text-first finished runs"
```

---

## Task 5: QuestionCard stepper

**Files:**
- Modify: `src/frontend/src/components/QuestionCard.tsx`
- Modify: `src/frontend/src/components/QuestionCard.test.tsx`

**Interfaces:**
- Public props of `QuestionCard` are unchanged. Only the active-form rendering changes to a stepper.

- [ ] **Step 1: Update the failing tests for stepper navigation**

In `src/frontend/src/components/QuestionCard.test.tsx`:

Replace the first test (`submits exact answers only after every question is complete`) with a stepper-aware version:

```tsx
it('walks the stepper and submits exact answers on the last step', async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  render(<QuestionCard request={request} onSubmit={onSubmit} />);

  // Step 1 of 2: Scope. Next is disabled until answered; no Submit yet.
  expect(screen.getByText('Step 1 of 2')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Delivery' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await user.click(screen.getByText('Complete change'));
  await user.click(screen.getByRole('button', { name: 'Next' }));

  // Step 2 of 2: Delivery. Submit replaces Next, disabled until answered.
  expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Delivery' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Submit answers' })).toBeDisabled();
  await user.click(screen.getByRole('radio', { name: /Now/ }));
  await user.click(screen.getByRole('button', { name: 'Submit answers' }));

  expect(onSubmit).toHaveBeenCalledWith([
    { questionId: 'scope', selected: ['full'] },
    { questionId: 'delivery', selected: ['now'] },
  ]);
});

it('lets the user step back to a previous question', async () => {
  const user = userEvent.setup();
  render(<QuestionCard request={request} onSubmit={vi.fn().mockResolvedValue(undefined)} />);
  await user.click(screen.getByText('Complete change'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await user.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByRole('group', { name: 'Scope' })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
});
```

Update the styling test (`uses the shared accent button styling for submitting answers`) so it navigates to the final step first (the 2-question `request` now starts on Scope):

```tsx
it('uses the shared accent button styling for submitting answers', async () => {
  const user = userEvent.setup();
  render(<QuestionCard request={request} onSubmit={vi.fn()} />);
  await user.click(screen.getByText('Complete change'));
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('button', { name: 'Submit answers' })).toHaveClass('accent-button');
});
```

The single-question tests (`supports multiple selections and a custom response`, `accepts a custom response without a selected option`) already use one-question requests — they must still pass with no stepper chrome (no `Step 1 of 1`, no `Next`). Leave them as-is. The `answered`/`unavailable` tests are unaffected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/QuestionCard.test.tsx`
Expected: FAIL (no `Step 1 of 2` / `Next` in current all-at-once form).

- [ ] **Step 3: Implement the stepper**

In `src/frontend/src/components/QuestionCard.tsx`, add `useState` step tracking and render one question at a time. Change the active-form `return` (currently lines 104-155) to:

```tsx
  const total = request.questions.length;
  const [step, setStep] = useState(0);
  const current = request.questions[step];
  const multiStep = total > 1;

  const currentComplete = (() => {
    const draft = drafts[current.id];
    return draft.selected.length > 0 || (current.allowOther && draft.custom.trim().length > 0);
  })();
  const isLast = step === total - 1;

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-700 bg-slate-900/60 p-4">
      {multiStep && (
        <p className="text-xs font-medium text-slate-400" aria-live="polite">Step {step + 1} of {total}</p>
      )}
      {(() => {
        const question = current;
        const draft = drafts[question.id];
        const inputType = question.multiple ? 'checkbox' : 'radio';
        return (
          <fieldset key={question.id} disabled={submitting} className="space-y-2">
            <legend className="text-sm font-medium text-slate-200">{question.header}</legend>
            <p className="text-sm text-slate-400">{question.question}</p>
            <div className="space-y-2">
              {question.options.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-700 p-2">
                  <input
                    type={inputType}
                    name={question.id}
                    value={option.value}
                    checked={draft.selected.includes(option.value)}
                    onChange={() => select(question.id, option.value, question.multiple)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-slate-200">{option.label}</span>
                    {option.description && <span className="block text-xs text-slate-400">{option.description}</span>}
                  </span>
                </label>
              ))}
            </div>
            {question.allowOther && (
              <label className="block text-sm text-slate-300">
                Other
                <input
                  type="text"
                  aria-label={`Other answer for ${question.header}`}
                  value={draft.custom}
                  onChange={(event) => setCustom(question.id, event.target.value)}
                  className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200"
                />
              </label>
            )}
          </fieldset>
        );
      })()}
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        {multiStep && step > 0 && (
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={submitting}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 disabled:opacity-50 transition-colors"
          >
            Back
          </button>
        )}
        {isLast ? (
          <button
            type="submit"
            disabled={!complete || submitting}
            className="accent-button rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Submitting…' : 'Submit answers'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setStep((s) => Math.min(total - 1, s + 1))}
            disabled={!currentComplete || submitting}
            className="accent-button rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            Next
          </button>
        )}
      </div>
    </form>
  );
```

Notes for the implementer:
- `useState` is already imported (line 1). Add the `step` state near the existing `drafts` state so hooks stay above the early returns for `inactive`/`answered` — declare `const [step, setStep] = useState(0);` alongside `const [drafts, setDrafts] = useState(...)` at the top of the component (React hooks must run unconditionally), not inside the `return`. Move the `total`/`current`/`currentComplete`/`isLast` derivations to just before the final `return`.
- `complete` (all-questions-complete, already defined at line 66) still gates the final Submit — on the last step, `complete` is true only once every step has been answered, which the stepper enforces by construction.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/QuestionCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/QuestionCard.tsx src/frontend/src/components/QuestionCard.test.tsx
git commit -m "feat: step through multi-part question forms one at a time"
```

---

## Task 6: Full verification & manual preview

**Files:** none (verification only).

- [ ] **Step 1: Full suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: all green.

- [ ] **Step 2: Manual preview checklist**

Start the app (preview tooling) and confirm:
- A long streaming run keeps the model's text visible above the composer; the tool list is a single summary row + the active tool.
- The status strip above the composer shows phase · elapsed · last activity · model and ticks each second.
- The composer shows **Stop** while running (cancels the run) and **Send** otherwise.
- A finished run shows its answer text first with a `N tool calls · Completed/Failed` row that expands the full timeline.
- A multi-part question shows one sub-question at a time with `Back`/`Next`/`Submit` and `Step X of N`; a single question shows just Submit.

- [ ] **Step 3: Final commit if any preview fixes were needed**

```bash
git add -A
git commit -m "fix: preview adjustments for run-status consolidation"
```

---

## Self-Review Notes

- **Spec coverage:** (1) single strip → Task 2; (2) Send→Stop → Task 2; (3) header removal + tool accordion → Tasks 3-4; (4) question stepper → Task 5; shared helpers → Task 1. All spec sections mapped.
- **Behavior change flagged in the spec:** whole-card collapse for finished runs is intentionally removed (finished content always visible). The old issue #108 collapse tests are replaced in Task 4, and the dead `isLatest`/`latestAssistantId`/`findLatestAssistantId` plumbing is cleaned up.
- **Stable test hooks preserved:** `run-status`, `send-button`, `composer-actions`, and `aria-label="Stop current run"` all retained.
