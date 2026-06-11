# Mission Control Usage Stats

Mission Control shows provider usage cards for Claude, Codex, and OpenRouter.
The backend builds these cards in `src/backend/codexbar.ts` and returns them
from `GET /api/mission-control`.

## Sources

- Claude: reads Claude Code OAuth credentials from macOS Keychain service
  `Claude Code-credentials`, then calls Anthropic's OAuth usage endpoint. The
  `five_hour` window is shown as Session and `seven_day` is shown as Weekly.
- Codex: reads the local Codex auth file at `~/.codex/auth.json`, then calls
  ChatGPT's usage endpoint. The primary window is shown as Session and the
  secondary window is shown as Weekly.
- OpenRouter: uses the configured OpenRouter API key and calls the credits
  endpoint to show the current balance.

## Refresh Behavior

Usage stats are sampled on the backend and cached for 300 seconds. Dashboard
requests reuse the cached sample until the polling window expires, and each card
shows `Updated ... ago` based on the backend sample timestamp.

If a refresh fails after Nexus has a good value for a provider, Nexus keeps the
last good value and attaches the refresh error to that provider's stats. This
prevents Mission Control from blanking a card because of a transient network or
credential issue.

## Fallbacks

Claude falls back to `~/.claude/.statusline-usage-cache` only if the live OAuth
source fails. That file can be stale, so it should not be treated as the primary
source.

Codex falls back to CodexBar's `usage-history.jsonl` if the live Codex usage
call fails. OpenRouter has no disk fallback; it reports unavailable if the
credits call fails and no previous good sample exists.

## Privacy

Tokens and credentials are used only for local read-only usage probes. They are
not returned to the frontend, stored in Nexus, or written to logs by the usage
adapter.
