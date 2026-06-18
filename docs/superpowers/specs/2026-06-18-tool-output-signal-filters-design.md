# Design: Tool-output signal filters

## Goal

Reduce low-value tool and terminal output before it consumes model context or enters long-term memory, while preserving the raw output needed for users and diagnostics. Filtering must be deterministic, conservative around failures, configurable globally with per-project overrides, and measurable.

## Scope

This change covers Pi tool results, including terminal output produced by the built-in `bash` tool, Pi session compaction input, explicit session archives, completed-task summaries, and the chat-history response used by the Nexus frontend.

It does not add a Settings UI editor, use a model to summarize logs, rewrite user or assistant messages, or create a second output store. Raw Pi session JSONL remains the diagnostic source of truth. More extensive filter customization in the Settings view is deferred to a separate issue if needed.

## Architecture

Add a backend `signal-filters` module with a pure public operation:

```ts
filterSignal(input, context, config): {
  text: string;
  stats: {
    inputBytes: number;
    outputBytes: number;
    inputLines: number;
    outputLines: number;
  };
  appliedFilters: string[];
}
```

`context` supplies the tool name, command when available, error state, and project repository path. The function has no filesystem, network, database, clock, or model dependency. Given the same input and resolved configuration, it returns the same result.

The pipeline is integrated at four boundaries:

1. A Pi extension factory handles the `context` event before every provider request. It replaces textual tool-result blocks with filtered copies. It reconstructs bash commands by matching tool-call IDs to the preceding assistant tool calls. The session messages and on-disk JSONL are not mutated.
2. The extension handles `session_before_compact` by replacing tool results in `messagesToSummarize` and `turnPrefixMessages` with filtered copies. Raw branch entries remain unchanged.
3. Session archive and completed-task summary builders apply the same pipeline before creating model or memory input.
4. Chat-history flattening calculates the filtered projection only for telemetry. The API still returns raw tool-result text and adds filter statistics and applied filter names for the frontend.

Only text blocks in tool-result messages are eligible. Image blocks, user messages, assistant prose, thinking blocks, and tool-call arguments are passed through unchanged.

## Configuration

Configuration lives in the existing global `~/.nexus/config.yaml`. Defaults are deep-merged for older installations. Project overrides are keyed by normalized absolute repository path, matching `projects.repo_path` after resolving `~` and removing a trailing separator.

```yaml
signal_filters:
  enabled: true
  min_input_bytes: 4096
  max_output_bytes: 12000
  filters:
    ansi: true
    progress: true
    repeated_lines: true
    package_manager: true
    test_output: true
    stack_trace: true
    diff_context: true
  projects:
    /Users/example/Projects/quiet-repo:
      enabled: false
    /Users/example/Projects/noisy-repo:
      max_output_bytes: 8000
      filters:
        stack_trace: false
```

Project values recursively override global values. Missing project entries use the global settings. `enabled: false` bypasses all filters and reports zero savings. Individual filters can be disabled without changing the others. Invalid numeric values are clamped to safe defaults when configuration is resolved rather than inside the pure pipeline.

The default thresholds are deliberately conservative. Inputs below `min_input_bytes` skip structural compression, but ANSI/control cleanup can still run because those bytes have no semantic value.

## Filter Pipeline

Filters execute in this fixed order:

1. **ANSI/control cleanup** removes terminal escape sequences and non-semantic control characters while preserving newlines and tabs.
2. **Progress cleanup** resolves carriage-return progress updates to the latest meaningful state and collapses spinner/progress redraws.
3. **Repeated-line grouping** replaces consecutive identical or normalized warning lines with one line and a repeat count.
4. **Package-manager/build reduction** recognizes common npm install and build noise, preserving package totals, warnings, audit summaries, timing totals, and failure lines.
5. **Test-output reduction** preserves suite/test totals, failed test names, assertions, file references, and failure summaries while collapsing long runs of passing cases.
6. **Stack-trace reduction** retains the exception heading, file-bearing application frames, the first bounded frame group, `Caused by` boundaries, and the final failure status. Repeated framework/internal frames are summarized.
7. **Diff-context reduction** preserves file and hunk headers plus added and removed lines while collapsing large unchanged context regions.
8. **Size budget** applies only when the preceding filters still exceed `max_output_bytes`. It retains the beginning, detected error neighborhoods with nearby lines, and the tail, separated by explicit omission markers.

Recognizers are line-oriented and deterministic. A filter that does not confidently recognize its input leaves it unchanged. Omission markers state what was removed; the filtered output must not silently join unrelated lines.

## Failure Preservation

For failed tool results, the filtered projection starts with a diagnostic header containing the tool name, command when available, and failed status. Pi already appends the shell exit code to failed bash output; that line is treated as mandatory and survives every filter and the final size budget.

The following are mandatory signal on failures:

- exception and assertion messages
- explicit error/failure lines
- shell exit-code or termination lines
- file paths and line/column references
- failed test and suite names
- `Caused by` boundaries
- a small, fixed number of lines around each retained error
- the final output tail

If filtering throws unexpectedly, the caller fails open to the raw tool result, records zero savings, and continues the provider, compaction, archive, or summary operation. Signal filtering must never turn an otherwise valid operation into an error.

## Raw Output and Observability

Raw output remains in Pi session JSONL and remains the text displayed in the tool-result timeline. Nexus does not persist a filtered duplicate.

When chat history is returned, each textual tool result includes:

```ts
signal_filter: {
  input_bytes: number;
  output_bytes: number;
  saved_bytes: number;
  saved_percent: number;
  applied_filters: string[];
}
```

The frontend shows this as a compact, non-interactive indicator such as `Model context: 68% smaller`, with the applied filter names available in its title/tooltip. The indicator is omitted when filtering is disabled or saves no bytes. Expanding the result always shows raw output.

Byte counts use UTF-8 byte length, not JavaScript string length. Percentages are rounded for display only; tests assert exact byte counts.

## Archive and Memory Behavior

Session archives retain user and assistant prose as before, but tool-result sections are filtered before the 30,000-character transcript cap is applied. Tool calls include their command or tool name so retained failures remain attributable.

Completed-task summaries currently extract assistant prose and exclude tool results. That exclusion remains explicit and is covered by a regression test. The task-summary entry reader uses the shared signal-aware message projection, but selects assistant prose only; therefore raw terminal output cannot reach heuristic extraction, Obsidian output, or memory writes. If task summaries later consume tool results, the projection already provides their filtered form.

Filter telemetry is operational metadata only and is not added to memory content.

## Testing

Focused backend tests use fixed fixtures and cover:

- ANSI and carriage-return cleanup
- progress and repeated-warning collapse
- successful npm install/build summaries
- passing and failing test output
- stack traces with application frames, framework noise, and nested causes
- diffs with large unchanged regions
- final size-budget behavior
- preservation of command, exit code, error lines, nearby context, and file references
- deterministic output and exact UTF-8 byte statistics
- disabled filters, numeric defaults, path normalization, and project override merging
- unknown output passing through conservatively
- fail-open behavior at each integration boundary

Integration tests cover:

- provider context receives filtered tool results while the session entry remains raw
- session compaction preparation receives filtered copies without mutating branch entries
- session archive filters tool output before transcript truncation
- task-memory paths do not store raw log spam
- chat-history responses contain raw output plus correct telemetry

Frontend tests cover indicator visibility, percentage text, filter-name tooltip content, and confirmation that expanded output remains raw.

## Acceptance Criteria Mapping

- Long noisy output is reduced before provider context injection by the Pi `context` extension.
- Failures preserve command, status/exit code, relevant errors, nearby context, and file references through mandatory-signal rules.
- Session compaction, archive, and task-memory paths use the same filter pipeline, preventing low-value log spam from entering summaries or memory.
- Raw Pi output is retained for diagnostics and frontend display.
- Global defaults and repository-path project overrides are inspectable in `~/.nexus/config.yaml`.
- Before/after UTF-8 byte counts are exposed in chat history and displayed beside tool output.
- Pure fixed-order filters and focused fixtures make behavior deterministic and regression-testable.
