# Mission Control usage empty state

## Implementation notes

Mission Control treats the Claude statusline cache as an optional fallback after live OAuth usage and CodexBar history. If that cache has not been created, the backend now returns `No Claude usage data found` instead of exposing the raw `ENOENT` message and the user's home-directory path.

Current CodexBar versions no longer create `usage-history.jsonl`. Mission Control now invokes CodexBar's supported JSON CLI for Claude, Codex, and OpenRouter on each five-minute sample. Direct provider APIs, legacy history, and the Claude statusline cache remain fallbacks when the CLI is missing or fails.

There is no change to successful usage sampling or to unexpected-error reporting.

## Testing notes

- Verify a machine without `~/.claude/.statusline-usage-cache` shows the normal unavailable state and the friendly message.
- Verify live Claude OAuth usage and existing statusline-cache usage still populate the session and weekly windows.
- Verify unexpected cache read failures remain visible for diagnosis.
- Verify the three cards match `codexbar --provider <provider> --format json --json-only` and identify their source as `codexbar-*`.
