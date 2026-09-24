# Tool-Output Signal Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically compress noisy Pi tool output before model context, session compaction, archives, and memory while keeping raw session output available and showing users the measured savings.

**Architecture:** A pure backend filter pipeline produces a filtered text projection and UTF-8 byte/line statistics. A message projector applies it to copied Pi messages for provider/compaction input, while archives and chat-history telemetry reuse the same API; raw Pi JSONL is never modified. Global YAML provides defaults plus normalized repository-path overrides.

**Tech Stack:** TypeScript 5.6, Node.js test runner, Pi Coding Agent 0.79.6 extension API, Fastify, React 18, Vitest, Testing Library, YAML via `js-yaml`.

## Global Constraints

- Raw Pi session JSONL remains the diagnostic source of truth; do not add a duplicate output store.
- Do not rewrite user messages, assistant prose, thinking blocks, tool-call arguments, or image blocks.
- Filtering is deterministic and local; it must not call a model, filesystem, database, network, or clock.
- Filtering failures fail open to raw output and must not fail provider, compaction, archive, or task-summary operations.
- Global configuration is stored only in `~/.nexus/config.yaml`; no Settings UI editor is added.
- Project overrides are keyed by normalized absolute repository path.
- Defaults are `enabled: true`, `min_input_bytes: 4096`, and `max_output_bytes: 12000`.
- UTF-8 byte counts use `Buffer.byteLength`; display percentages are rounded only in the frontend.
- Use test-first red/green cycles and commit after each task.

---

### Task 1: Add typed configuration and project override resolution

**Files:**
- Modify: `src/shared/index.ts`
- Modify: `src/backend/config.ts`
- Create: `src/backend/signal-filters/config.ts`
- Create: `src/backend/test/signal-filter-config.test.ts`
- Modify: `src/backend/test/routes-settings.test.ts`

**Interfaces:**
- Produces: `SignalFilterFlags`, `SignalFilterProjectOverride`, and `SignalFilterConfig` in `@nexus/shared`.
- Produces: `ResolvedSignalFilterConfig`, `normalizeSignalFilterProjectPath(pathname)`, and `resolveSignalFilterConfig(config, repoPath)` from `signal-filters/config.ts`.
- `ResolvedSignalFilterConfig` contains only `enabled`, `min_input_bytes`, `max_output_bytes`, and fully populated `filters`; it does not contain `projects`.

- [ ] **Step 1: Write failing resolver tests**

Create `src/backend/test/signal-filter-config.test.ts` with cases that assert defaults, recursive filter merging, disabled projects, `~` expansion, trailing-slash removal, and invalid numeric fallback:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { NexusConfig } from '@nexus/shared';
import {
  DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
  normalizeSignalFilterProjectPath,
  resolveSignalFilterConfig,
} from '../signal-filters/config';

const base = {
  signal_filters: {
    ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG,
    projects: {
      '/tmp/noisy': { max_output_bytes: 8000, filters: { stack_trace: false } },
      '/tmp/off': { enabled: false },
    },
  },
} as NexusConfig;

test('resolveSignalFilterConfig deep-merges the matching project override', () => {
  const resolved = resolveSignalFilterConfig(base, '/tmp/noisy/');
  assert.equal(resolved.max_output_bytes, 8000);
  assert.equal(resolved.filters.stack_trace, false);
  assert.equal(resolved.filters.test_output, true);
});

test('resolveSignalFilterConfig supports a disabled project', () => {
  assert.equal(resolveSignalFilterConfig(base, '/tmp/off').enabled, false);
});

test('resolveSignalFilterConfig replaces invalid numeric values with defaults', () => {
  const invalid = structuredClone(base);
  invalid.signal_filters.min_input_bytes = -1;
  invalid.signal_filters.max_output_bytes = Number.NaN;
  const resolved = resolveSignalFilterConfig(invalid, '/tmp/other');
  assert.equal(resolved.min_input_bytes, 4096);
  assert.equal(resolved.max_output_bytes, 12000);
});

test('normalizeSignalFilterProjectPath expands home and removes trailing separators', () => {
  assert.equal(normalizeSignalFilterProjectPath('/tmp/repo///'), '/tmp/repo');
  assert.equal(normalizeSignalFilterProjectPath('~/repo').endsWith('/repo'), true);
});
```

- [ ] **Step 2: Run the resolver tests and verify RED**

Run: `npm test --workspace=src/backend -- test/signal-filter-config.test.ts`

Expected: FAIL because `@nexus/shared` lacks the signal-filter types and `../signal-filters/config` does not exist.

- [ ] **Step 3: Add config types and defaults**

Add these types to `src/shared/index.ts` and add `signal_filters: SignalFilterConfig` to `NexusConfig`:

```ts
export interface SignalFilterFlags {
  ansi: boolean;
  progress: boolean;
  repeated_lines: boolean;
  package_manager: boolean;
  test_output: boolean;
  stack_trace: boolean;
  diff_context: boolean;
}

export interface SignalFilterProjectOverride {
  enabled?: boolean;
  min_input_bytes?: number;
  max_output_bytes?: number;
  filters?: Partial<SignalFilterFlags>;
}

export interface SignalFilterConfig {
  enabled: boolean;
  min_input_bytes: number;
  max_output_bytes: number;
  filters: SignalFilterFlags;
  projects: Record<string, SignalFilterProjectOverride>;
}
```

Add this block to `DEFAULT_CONFIG` in `src/backend/config.ts`:

```ts
signal_filters: {
  enabled: true,
  min_input_bytes: 4096,
  max_output_bytes: 12000,
  filters: {
    ansi: true,
    progress: true,
    repeated_lines: true,
    package_manager: true,
    test_output: true,
    stack_trace: true,
    diff_context: true,
  },
  projects: {},
},
```

- [ ] **Step 4: Implement path normalization and resolution**

Create `src/backend/signal-filters/config.ts` with a frozen default, path normalization via `os.homedir()`, `path.resolve()`, and `path.normalize()`, exact normalized-key matching, recursive flag merging, and a numeric guard:

```ts
import os from 'node:os';
import path from 'node:path';
import type { NexusConfig, SignalFilterFlags } from '@nexus/shared';

export interface ResolvedSignalFilterConfig {
  enabled: boolean;
  min_input_bytes: number;
  max_output_bytes: number;
  filters: SignalFilterFlags;
}

export const DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG: ResolvedSignalFilterConfig = {
  enabled: true,
  min_input_bytes: 4096,
  max_output_bytes: 12000,
  filters: {
    ansi: true,
    progress: true,
    repeated_lines: true,
    package_manager: true,
    test_output: true,
    stack_trace: true,
    diff_context: true,
  },
};

export function normalizeSignalFilterProjectPath(value: string): string {
  const expanded = value === '~' ? os.homedir()
    : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2))
      : value;
  return path.normalize(path.resolve(expanded)).replace(/[\\/]+$/, '') || path.parse(path.resolve(expanded)).root;
}

const positiveInteger = (value: unknown, fallback: number) =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;

export function resolveSignalFilterConfig(config: NexusConfig, repoPath: string): ResolvedSignalFilterConfig {
  const global = config.signal_filters ?? { ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG, projects: {} };
  const normalizedRepo = normalizeSignalFilterProjectPath(repoPath);
  const project = Object.entries(global.projects ?? {}).find(
    ([key]) => normalizeSignalFilterProjectPath(key) === normalizedRepo,
  )?.[1];
  return {
    enabled: project?.enabled ?? global.enabled ?? true,
    min_input_bytes: positiveInteger(project?.min_input_bytes ?? global.min_input_bytes, 4096),
    max_output_bytes: positiveInteger(project?.max_output_bytes ?? global.max_output_bytes, 12000),
    filters: {
      ...DEFAULT_RESOLVED_SIGNAL_FILTER_CONFIG.filters,
      ...(global.filters ?? {}),
      ...(project?.filters ?? {}),
    },
  };
}
```

- [ ] **Step 5: Add a settings round-trip regression**

Extend `src/backend/test/routes-settings.test.ts` with a PUT/GET test using a project override and assert that the override is persisted unchanged. This proves the existing broad config route does not drop the new block:

```ts
test('settings round-trips signal filter project overrides', async () => {
  const original = loadConfig();
  const app = makeApp();
  try {
    const payload = structuredClone(original);
    payload.signal_filters.projects['/tmp/noisy'] = {
      max_output_bytes: 8000,
      filters: { stack_trace: false },
    };
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().signal_filters.projects['/tmp/noisy'].max_output_bytes, 8000);
    assert.equal(loadConfig().signal_filters.projects['/tmp/noisy'].filters?.stack_trace, false);
  } finally {
    saveConfig(original);
    await app.close();
  }
});
```

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test --workspace=src/backend -- test/signal-filter-config.test.ts test/routes-settings.test.ts`

Expected: PASS with zero failures.

- [ ] **Step 7: Commit**

```bash
git add src/shared/index.ts src/backend/config.ts src/backend/signal-filters/config.ts src/backend/test/signal-filter-config.test.ts src/backend/test/routes-settings.test.ts
git commit -m "feat: configure tool output signal filters"
```

---

### Task 2: Build the deterministic filter pipeline

**Files:**
- Create: `src/backend/signal-filters/pipeline.ts`
- Create: `src/backend/test/signal-filter-pipeline.test.ts`

**Interfaces:**
- Consumes: `ResolvedSignalFilterConfig` from Task 1.
- Produces: `SignalFilterContext`, `SignalFilterStats`, `SignalFilterResult`, and `filterSignal(input, context, config)`.
- `SignalFilterContext` is `{ toolName: string; command?: string; isError: boolean }`.

- [ ] **Step 1: Write failing cleanup and statistics tests**

Create table-driven tests for ANSI, carriage-return progress, Unicode byte counts, disabled filtering, and small-input structural bypass:

```ts
test('filterSignal strips ANSI and keeps the final carriage-return progress state', () => {
  const input = '\u001b[32mInstalling\u001b[0m 10%\rInstalling 80%\rInstalling 100%\nadded 42 packages';
  const result = filterSignal(input, { toolName: 'bash', command: 'npm install', isError: false }, config({ min_input_bytes: 1 }));
  assert.doesNotMatch(result.text, /\u001b|10%|80%/);
  assert.match(result.text, /Installing 100%/);
  assert.equal(result.stats.inputBytes, Buffer.byteLength(input));
  assert.equal(result.stats.outputBytes, Buffer.byteLength(result.text));
  assert.ok(result.appliedFilters.includes('ansi'));
  assert.ok(result.appliedFilters.includes('progress'));
});

test('filterSignal reports UTF-8 bytes rather than string length', () => {
  const result = filterSignal('✓✓✓', { toolName: 'bash', isError: false }, config({ enabled: false }));
  assert.equal(result.stats.inputBytes, 9);
  assert.equal(result.stats.outputBytes, 9);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test --workspace=src/backend -- test/signal-filter-pipeline.test.ts`

Expected: FAIL because `pipeline.ts` does not exist.

- [ ] **Step 3: Implement the pipeline shell, cleanup, and stats**

Implement `filterSignal` as a fixed sequence of named pure transforms. Each transform returns the original string when it makes no change. Record a filter name only when its output differs. If `enabled` is false, return raw text and empty filters. Apply ANSI/control and progress cleanup before the `min_input_bytes` check; apply structural transforms only at or above the threshold.

Use these exact public types:

```ts
export interface SignalFilterContext {
  toolName: string;
  command?: string;
  isError: boolean;
}

export interface SignalFilterStats {
  inputBytes: number;
  outputBytes: number;
  inputLines: number;
  outputLines: number;
}

export interface SignalFilterResult {
  text: string;
  stats: SignalFilterStats;
  appliedFilters: string[];
}
```

Use `Buffer.byteLength(text, 'utf8')` and `text === '' ? 0 : text.split('\n').length`. Strip ANSI with a CSI/OSC-safe expression, remove control bytes except `\n`, `\r`, and `\t`, then resolve every physical line containing `\r` to its last non-empty redraw.

- [ ] **Step 4: Write failing repeated-line and recognizer tests**

Add fixtures for:

```ts
test('groups normalized repeated warnings', () => {
  const input = Array.from({ length: 40 }, (_, i) => `warning package deprecated (${i + 1}ms)`).join('\n');
  const result = filterSignal(input, bash('npm install'), config({ min_input_bytes: 1 }));
  assert.match(result.text, /repeated 40 times/);
});

test('reduces successful npm and passing test noise but keeps totals', () => {
  const npm = filterSignal(NPM_INSTALL_FIXTURE, bash('npm install'), config({ min_input_bytes: 1 }));
  assert.match(npm.text, /added 421 packages/);
  assert.match(npm.text, /0 vulnerabilities/);
  assert.ok(npm.stats.outputBytes < npm.stats.inputBytes);

  const tests = filterSignal(PASSING_TEST_FIXTURE, bash('npm test'), config({ min_input_bytes: 1 }));
  assert.match(tests.text, /Tests:\s+120 passed/);
  assert.doesNotMatch(tests.text, /passes case 73/);
});

test('reduces unchanged diff context but keeps headers and changes', () => {
  const result = filterSignal(LARGE_DIFF_FIXTURE, { toolName: 'edit', isError: false }, config({ min_input_bytes: 1 }));
  assert.match(result.text, /^--- a\/src\/file.ts/m);
  assert.match(result.text, /^\+const fixed = true;/m);
  assert.match(result.text, /unchanged lines omitted/);
});
```

Fixtures must be literal deterministic strings in the test file, generated with `Array.from` where repetition is material; do not read external logs.

- [ ] **Step 5: Implement structural filters**

Add private transforms in this exact order: `collapseRepeatedLines`, `reducePackageManagerOutput`, `reduceTestOutput`, `reduceStackTrace`, and `reduceDiffContext`.

Use conservative activation predicates:

```ts
const packageCommand = /(?:^|\s)(?:npm|pnpm|yarn)(?:\s|$)/i.test(context.command ?? '');
const testCommand = /(?:^|\s)(?:npm\s+(?:run\s+)?test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|node\s+--test)(?:\s|$)/i.test(context.command ?? '');
const diffInput = /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(text);
const stackInput = /(?:^|\n)(?:\w*(?:Error|Exception):|\s+at\s+|Caused by:)/m.test(text);
```

Every reducer must retain lines matching the shared mandatory-signal predicate: errors/failures, assertions, file `:line[:column]` references, exit/termination status, test totals, package/audit totals, diff headers/changes, and `Caused by`. Replace each removed contiguous region with one marker carrying its line count.

- [ ] **Step 6: Write failing failure-preservation and budget tests**

Add a failed Jest/Vitest fixture with a command, assertion, `src/parser.ts:42:9`, framework frames, a nested cause, and `Command exited with code 1`. Assert every required signal survives and generic framework frames are reduced. Add a 30 KB unknown-output fixture and assert the output fits `max_output_bytes`, contains its head and tail, contains an omission marker, and retains two lines around an embedded error.

- [ ] **Step 7: Implement diagnostic headers and final budget**

For `isError`, prefix exactly:

```text
[Nexus signal filter]
Tool: bash
Command: npm test
Status: failed

```

Omit the command line when unavailable. Add the header only when structural compression or the final budget changes the body. The final budget selects whole lines: mandatory-signal lines plus two neighbors, then the first 20 and last 20 lines. If still over budget, reduce head/tail counts while never dropping mandatory lines; truncate an individually oversized non-mandatory line with an explicit byte-omission marker. Preserve `Command exited with code N` as mandatory. Do not slice a JavaScript string by bytes in a way that corrupts UTF-8.

- [ ] **Step 8: Verify determinism and GREEN**

Run: `npm test --workspace=src/backend -- test/signal-filter-pipeline.test.ts`

Expected: PASS. Run each fixture through `filterSignal` twice and assert deep equality.

- [ ] **Step 9: Commit**

```bash
git add src/backend/signal-filters/pipeline.ts src/backend/test/signal-filter-pipeline.test.ts
git commit -m "feat: add deterministic signal filter pipeline"
```

---

### Task 3: Project copied Pi messages into provider and compaction input

**Files:**
- Create: `src/backend/signal-filters/messages.ts`
- Create: `src/backend/signal-filters/extension.ts`
- Create: `src/backend/test/signal-filter-messages.test.ts`
- Modify: `src/backend/pi/runtime.ts`
- Modify: `src/backend/test/pi-runtime.test.ts`

**Interfaces:**
- Consumes: `filterSignal` and `ResolvedSignalFilterConfig`.
- Produces: `projectToolResultMessages(messages, repoPath, config)` returning `{ messages, resultsByToolCallId }`.
- Produces: `createSignalFilterExtension(repoPath, getConfig?)` as a Pi `ExtensionFactory`; `getConfig` defaults to `loadConfig`.
- Produces: `SignalProjection` values keyed by tool-call ID for later telemetry reuse.

- [ ] **Step 1: Write failing message projection tests**

Use a minimal assistant tool call followed by a raw tool result. Assert the projected result contains the filter marker/summary, the original nested content remains byte-for-byte raw, assistant/user objects preserve identity when unchanged, image blocks preserve identity, and the command is recovered from `toolCall.arguments.command`:

```ts
const raw = 'PASS case 1\n'.repeat(500) + 'Tests: 500 passed\n';
const messages = [
  { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'npm test' } }] },
  { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: raw }] },
] as any[];
const projected = projectToolResultMessages(messages, '/tmp/repo', resolved);
assert.equal((messages[1].content[0] as any).text, raw);
assert.ok((projected.messages[1] as any).content[0].text.length < raw.length);
assert.equal(projected.resultsByToolCallId.get('call-1')?.context.command, 'npm test');
```

Also inject a `filter` dependency that throws and assert the projector returns raw content with zero-savings metadata.

- [ ] **Step 2: Run projection tests and verify RED**

Run: `npm test --workspace=src/backend -- test/signal-filter-messages.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement immutable message projection**

Walk messages once, collecting tool calls by ID from assistant content. For each textual tool result, call `filterSignal` separately per text block with `{ toolName, command, isError }`. Clone only a changed block/message/array. Return a projection map containing the combined raw result, combined filtered result, aggregate stats, applied filter names de-duplicated in pipeline order, and recovered context. Wrap each filter call in `try/catch`; on exception return the raw block and zero savings.

- [ ] **Step 4: Write failing extension event tests**

Export a small `registerSignalFilterHandlers(pi, repoPath, getConfig)` helper so tests can capture handlers without constructing a Pi runtime. Assert:

- the `context` handler returns projected messages;
- the source event messages remain raw;
- the `session_before_compact` handler replaces `messagesToSummarize` and `turnPrefixMessages` with projected arrays;
- `branchEntries` is not mutated;
- a thrown config loader causes both handlers to return/leave raw input rather than throw.

- [ ] **Step 5: Implement the extension factory**

Register both handlers:

```ts
pi.on('context', (event) => {
  try {
    const resolved = resolveSignalFilterConfig(getConfig(), repoPath);
    return { messages: projectToolResultMessages(event.messages, repoPath, resolved).messages };
  } catch {
    return { messages: event.messages };
  }
});

pi.on('session_before_compact', (event) => {
  try {
    const resolved = resolveSignalFilterConfig(getConfig(), repoPath);
    event.preparation.messagesToSummarize = projectToolResultMessages(
      event.preparation.messagesToSummarize, repoPath, resolved,
    ).messages;
    event.preparation.turnPrefixMessages = projectToolResultMessages(
      event.preparation.turnPrefixMessages, repoPath, resolved,
    ).messages;
  } catch {
    // Fail open: Pi uses the original preparation arrays.
  }
});
```

Before assignment, compute both projected arrays; this prevents half-mutated preparation if the second projection fails.

- [ ] **Step 6: Wire the extension into every Pi session**

Change `buildResourceLoaderOptions` to accept `extensionFactories?: ExtensionFactory[]` and append them after the Anthropic bridge. In `createSession`, pass `[createSignalFilterExtension(cwd)]`. Preserve `noExtensions: true` so only explicitly provided factories run.

Extend `pi-runtime.test.ts` to assert a caller-supplied factory is present alongside the bridge and that the input array is not mutated.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm test --workspace=src/backend -- test/signal-filter-messages.test.ts test/pi-runtime.test.ts
npm run typecheck --workspace=src/backend
```

Expected: both commands exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/backend/signal-filters/messages.ts src/backend/signal-filters/extension.ts src/backend/test/signal-filter-messages.test.ts src/backend/pi/runtime.ts src/backend/test/pi-runtime.test.ts
git commit -m "feat: filter Pi provider and compaction context"
```

---

### Task 4: Filter archive transcripts and guard task-memory extraction

**Files:**
- Modify: `src/backend/sessions/archive.ts`
- Modify: `src/backend/memory/summarize.ts`
- Modify: `src/backend/test/routes-chat.test.ts`
- Modify: `src/backend/test/routes-task-summary.test.ts`

**Interfaces:**
- Consumes: `projectToolResultMessages` and resolved per-repository configuration.
- Changes: archive transcript construction includes tool attribution and filtered tool-result text before the existing 30,000-character cap.
- Changes: `summarizeTaskThread(db, pi, task, deps?)` projects Pi messages through the shared filter before selecting assistant prose.
- Preserves: `extractAssistantText(entries)` continues to exclude tool results from task memory after projection.

- [ ] **Step 1: Write a failing archive integration test**

Add a raw bash tool call/result to `archiveThreadToMemory` test input with more than 30,000 characters of passing-test noise followed by a required summary. Capture `input.transcript` in the injected summarizer and assert:

```ts
assert.match(transcript, /TOOL bash \(npm test\)/);
assert.match(transcript, /Tests:\s+500 passed/);
assert.doesNotMatch(transcript, /passes case 499/);
assert.ok(transcript.length < 30_000);
```

Use a project-specific config override through an injected `resolveFilters` archive dependency so the test does not modify the developer's global config.

- [ ] **Step 2: Run the archive test and verify RED**

Run: `npm test --workspace=src/backend -- test/routes-chat.test.ts`

Expected: FAIL because archive transcript construction currently copies raw tool results and does not accept the filter dependency.

- [ ] **Step 3: Implement signal-aware archive transcript building**

Extend `ArchiveDeps` with:

```ts
resolveFilters?: (repoPath: string) => ResolvedSignalFilterConfig;
```

Default it to `resolveSignalFilterConfig(loadConfig(), repoPath)`. Before `entriesToTranscriptMessages`, project the entries' `message` values through `projectToolResultMessages`. Preserve user and assistant text. Format a tool result as `TOOL <name> (<command>): <filtered text>` when a command exists and `TOOL <name>: ...` otherwise. Apply `.slice(0, 30000)` only after projection and formatting. Catch projection/config errors and fall back to the current raw transcript path.

- [ ] **Step 4: Add the task-memory exclusion regression**

Extend `extractAssistantText pulls assistant text blocks and ignores user/tool messages` with a 20 KB raw tool result containing `SECRET_LOG_SPAM`, then assert the extracted output does not contain it. Add a `summarizeTaskThread` integration assertion that injects a `resolveFilters` dependency, supplies a noisy tool result through `pi.readMessages`, and confirms that neither captured memory inputs nor Obsidian summary text contains the sentinel.

- [ ] **Step 5: Project task messages, then keep extraction assistant-only**

Add an optional dependency without changing existing callers:

```ts
interface TaskSummaryDeps {
  resolveFilters?: (repoPath: string) => ResolvedSignalFilterConfig;
}

export async function summarizeTaskThread(
  db: Database.Database,
  pi: PiRuntime,
  task: TaskRow,
  deps: TaskSummaryDeps = {},
): Promise<boolean>
```

Resolve filters once, project the `message` objects from Pi entries with `projectToolResultMessages`, reconstruct entry wrappers with projected messages, then call `extractAssistantText`. Wrap resolution/projection in `try/catch` and fall back to the original entries. Add `isAssistantMessage` or an equivalent local guard and a comment explaining that task memory intentionally excludes tool output after the signal-aware projection; do not start storing filtered tools in task memory. The regression from Step 4 is the required behavior.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test --workspace=src/backend -- test/routes-chat.test.ts test/routes-task-summary.test.ts
npm run typecheck --workspace=src/backend
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/backend/sessions/archive.ts src/backend/memory/summarize.ts src/backend/test/routes-chat.test.ts src/backend/test/routes-task-summary.test.ts
git commit -m "feat: filter session archive output"
```

---

### Task 5: Expose telemetry with raw chat output and render savings

**Files:**
- Modify: `src/backend/routes/chat.ts`
- Modify: `src/backend/test/routes-chat.test.ts`
- Modify: `src/frontend/src/hooks/usePiStream.ts`
- Modify: `src/frontend/src/components/ChatPanel.tsx`
- Modify: `src/frontend/src/components/ChatPanel.test.tsx`

**Interfaces:**
- Produces API field `signal_filter` on persisted textual tool-result messages.
- Produces frontend `SignalFilterTelemetry` with snake-case fields matching the API.
- Preserves raw `content` in the history response and expanded UI.

- [ ] **Step 1: Write the failing history API test**

Make `flattenEntries` exported for direct unit testing or exercise `GET /api/threads/:threadId` with a runtime override. Supply a noisy raw tool result and assert:

```ts
assert.equal(message.content, raw);
assert.equal(message.signal_filter.input_bytes, Buffer.byteLength(raw));
assert.ok(message.signal_filter.output_bytes < message.signal_filter.input_bytes);
assert.equal(
  message.signal_filter.saved_bytes,
  message.signal_filter.input_bytes - message.signal_filter.output_bytes,
);
assert.ok(message.signal_filter.applied_filters.includes('test_output'));
```

Also assert no telemetry for disabled/no-savings output.

- [ ] **Step 2: Run the route test and verify RED**

Run: `npm test --workspace=src/backend -- test/routes-chat.test.ts`

Expected: FAIL because `flattenEntries` has no repository/config argument and emits no telemetry.

- [ ] **Step 3: Add backend telemetry while preserving raw content**

Change `flattenEntries(entries, repoPath, resolvedConfig?)`; resolve global/project config once per request, not once per message. Build one message projection map, then keep `extractText(m.content)` as raw `content` and attach:

```ts
signal_filter: savedBytes > 0 ? {
  input_bytes: result.stats.inputBytes,
  output_bytes: result.stats.outputBytes,
  saved_bytes: savedBytes,
  saved_percent: Math.round((savedBytes / result.stats.inputBytes) * 100),
  applied_filters: result.appliedFilters,
} : undefined,
```

Pass `cwd` at both history routes. If resolving/filtering fails, return the existing raw response with no telemetry.

- [ ] **Step 4: Write the failing frontend telemetry test**

In `ChatPanel.test.tsx`, mock history containing a tool result with raw `content: 'raw line\n'.repeat(300)`, `toolName: 'bash'`, and `signal_filter` showing 68% savings. Assert:

- `Model context: 68% smaller` is visible;
- the indicator title contains `test_output, repeated_lines`;
- raw content is initially collapsed;
- toggling the existing details control reveals the raw content, not filtered text;
- a second tool message without savings has no indicator.

- [ ] **Step 5: Add frontend types and rendering**

Add to `usePiStream.ts`:

```ts
export interface SignalFilterTelemetry {
  input_bytes: number;
  output_bytes: number;
  saved_bytes: number;
  saved_percent: number;
  applied_filters: string[];
}
```

Add `signal_filter?: SignalFilterTelemetry` to `StreamMessage`. In the tool-result branch of `MessageBubble`, render the tool/status label plus:

```tsx
{msg.signal_filter && msg.signal_filter.saved_bytes > 0 && (
  <span
    className="ml-2 text-[10px] text-emerald-400/80"
    title={`Applied filters: ${msg.signal_filter.applied_filters.join(', ')}`}
  >
    Model context: {msg.signal_filter.saved_percent}% smaller
  </span>
)}
```

When `detailsExpanded` is true and raw `msg.content` is non-empty, render it in a wrapping `<pre>` below the indicator. Do not show the filtered projection anywhere.

- [ ] **Step 6: Run backend/frontend focused tests**

Run:

```bash
npm test --workspace=src/backend -- test/routes-chat.test.ts
npm test --workspace=src/frontend -- --run src/components/ChatPanel.test.tsx
npm run typecheck --workspace=src/backend
npm run typecheck --workspace=src/frontend
```

Expected: all four commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/backend/routes/chat.ts src/backend/test/routes-chat.test.ts src/frontend/src/hooks/usePiStream.ts src/frontend/src/components/ChatPanel.tsx src/frontend/src/components/ChatPanel.test.tsx
git commit -m "feat: show tool output context savings"
```

---

### Task 6: Verify acceptance criteria and integration safety

**Files:**
- Modify only if verification exposes a requirement gap; any fix must start with a failing regression test in the owning task's test file.

**Interfaces:**
- Consumes all prior task outputs.
- Produces fresh verification evidence for issue #74.

- [ ] **Step 1: Run formatting/diff checks**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional files are modified.

- [ ] **Step 2: Run the complete backend suite**

Run: `npm test --workspace=src/backend`

Expected: exit 0 with zero failed tests.

- [ ] **Step 3: Run the complete frontend suite**

Run: `npm test --workspace=src/frontend -- --run`

Expected: exit 0 with zero failed tests.

- [ ] **Step 4: Run repository typechecks and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Audit the implementation against the spec**

Use `rg` and tests to confirm each item:

```bash
rg -n "signal_filters|createSignalFilterExtension|session_before_compact|signal_filter|projectToolResultMessages" src
rg -n "Command exited with code|Caused by|saved_bytes|SECRET_LOG_SPAM" src/backend/test src/frontend/src
```

Expected: evidence exists for model context, compaction, archive/task memory, project overrides, raw-output telemetry, failure preservation, and deterministic tests.

- [ ] **Step 6: Inspect final commits and working tree**

Run:

```bash
git log --oneline -7
git status --short
```

Expected: design/plan plus one focused commit per implementation task; working tree clean.
