# Handoff: finalise the Claude Agent SDK engine on baker-pro

**For:** Claude running on `baker-pro` (the Nexus backend host).
**From:** the laptop session that built PR #410.
**Branch:** `feat/claude-agent-sdk-engine` → PR [k-sym/nexus#410](https://github.com/k-sym/nexus/pull/410) (base `main`).
**Plan (the spec):** `project_docs/plans/2026-09-02-claude-agent-sdk-engine.md` — read its header, Design decisions and Known limits first.

## 1. What this branch is

Nexus reached Claude through a third-party OAuth bridge inside the Pi runtime. Anthropic's consumer terms (Feb 2026) allow Free/Pro/Max OAuth only inside Claude Code and claude.ai, so that path was non-compliant. This branch makes the chat engine pluggable and adds a second engine that runs Claude through the official **Claude Agent SDK** (the Claude Code harness, binary bundled in the npm package). Model keys pick the engine by provider prefix: `claude-code/<model>` → Claude engine; everything else → Pi, unchanged.

Pi's event vocabulary and Pi's `SessionManager` JSONL remain the contract, so the NDJSON stream, `flattenEntries`, the frontend, the iOS client and archive were not touched. The Claude engine runs one SDK `query()` per turn, resumed through a session id stored as a `nexus.engine_session` custom entry in the thread JSONL; every tool call (read-only built-ins included) goes through the shared `decideToolCall` gate (policy → Supervise → `ApprovalBroker` → audit); the Nexus tools reach Claude as an in-process MCP server built from the same Pi extension factories; Claude's own `AskUserQuestion` is disabled in favour of Nexus's `question`.

Key files:

| Area | Path |
| --- | --- |
| Engine contracts / registry / Pi adapter | `src/backend/engines/{types,registry,pi-engine}.ts` |
| Claude engine | `src/backend/engines/claude/{engine,session,events,pi-tools-bridge,tool-names,tool-use-correlator,models,auth}.ts` |
| Shared tool gate | `src/backend/pi/approvals.ts` (`decideToolCall`) |
| Pi runtime exposure | `src/backend/pi/runtime.ts` (`openSessionManagerFor`, `extensionFactoriesFor`, `systemPromptAppendixFor`, `onSessionDropped`, `auditSink`) |
| Wiring | `src/backend/index.ts`, `src/backend/routes/chat.ts`, `src/backend/routes/pi.ts`, `src/backend/fastify.d.ts` |
| Config | `NexusConfig.engines.claude` in `src/shared/index.ts`; defaults in `src/backend/config.ts` |
| Tests | `src/backend/test/claude-*.test.ts`, `engines-registry.test.ts`, `approvals-gate.test.ts`, `routes-chat-engines.test.ts`, live: `src/backend/test/live/claude-engine.test.ts` |
| Signing | `scripts/sign-nested-binaries.sh` (bundled `claude` gets JIT entitlements) |
| Docs | README → "Engines" |

## 2. State at handoff

Done and reviewed (per-task reviews plus a whole-branch Opus review; every Critical/Important finding fixed):

- Backend suite 1071/1072 on the laptop. The single failure is a pre-existing, environment-dependent test (`pi-runtime.test.ts` "a session prompt gains the orientation block…", it fails on `main` too because `~/.agents/skills` on the laptop leaks the word "screenshot" into Pi's base prompt). It may simply pass on baker-pro.
- Backend and frontend typecheck clean; `npm run build`, `stage:services` and the prune script keep `@anthropic-ai/claude-agent-sdk-darwin-arm64`.

**Not verified, and the reason this handoff exists:**

1. **The live round trip now passes on the laptop (2/2, after K-Sym refreshed the login and commit `f385c47c` fixed context usage).** `src/backend/test/live/claude-engine.test.ts` has two cases: a plain Haiku turn plus resume, and a tool-using turn that asserts the SDK's per-content-block assistant frames were merged into one persisted assistant entry — confirmed against real SDK traffic. Two facts from that run: the SDK reports `apiKeySource: 'none'` for a working subscription login (the log now says `auth source: none (no API key; using the claude login)`), and the SDK never attaches `context_usage` to assistant messages, so context usage is derived from `result.modelUsage[model].contextWindow` and the last assistant message's token usage. **baker-pro must still run the live test once as the backend user** to prove that account's login works in the LaunchAgent environment.
2. **Manual app checks** (Supervise approval card, `question` card, Stop, restart + resume, delete cleanup, image turn) have not been done.
3. **Signed `npm run dist` — DONE on the laptop (2026-09-03).** App and dmg notarized (both `status: Accepted`), Gatekeeper `source=Notarized Developer ID`, and the bundled `claude` (199 MB, `Identifier=claude`, hardened runtime, JIT/unsigned-executable-memory/disable-library-validation entitlements) executed from inside the signed `.app`: `--version` → `2.1.258 (Claude Code)` and a `-p` Haiku turn returned `PONG`. Nothing further needed from baker-pro on this point.

## 3. baker-pro specifics

- Nexus backend runs from LaunchAgents (`launchctl list | grep nexus`): `nexus-backend` (port 4173, gateway 8899) and `nexus-memory` (4100 / 8443). Deploy loop is: pull → `npm ci` → `npm run build` → `launchctl kickstart -k gui/$(id -u)/<label>`. The backend takes ~30 s to finish its boot handshake; do not judge health before that.
- baker-pro is on Node 26 (laptop is Node 22). The SDK needs ≥ 18; the better-sqlite3 ABI guard (`scripts/ensure-sqlite-abi.cjs`, runs on `predev`/`prestart`) handles native rebuilds. Backend and memory daemon are separate installs.
- **The bundled Claude Code uses the login of the user account that runs the backend LaunchAgent.** You cannot perform that login yourself (interactive, browser-based, credentials). Ask K-Sym to run one of these as that user before you start:
  - `claude login` (interactive), or
  - `claude setup-token` and export the result as `CLAUDE_CODE_OAUTH_TOKEN` in the environment the backend reads (the backend loads the nearest `.env`; config default is `engines.claude.oauth_token: ${CLAUDE_CODE_OAUTH_TOKEN}`). Never write the token literal into `config.yaml`.
  - Confirm with `claude -p "say ok"` as that user.
- The engine strips `ANTHROPIC_API_KEY` from the child process unless `engines.claude.auth: api_key`. If baker-pro's environment carries an `ANTHROPIC_API_KEY` for other reasons, that is fine; it will not be used by the Claude engine.
- A live `JIRA_TOKEN` in the shell breaks the "unconfigured Jira" backend tests; run the suite without it exported if those fail.
- `project_docs/**` is a Dropbox symlink: `git status` may show phantom deletes there. Verify with `git diff` before any `git add`, and never stage that directory from a script.

## 4. Finalisation checklist

Work through in order. Stop and report if any step fails in a way you cannot explain.

1. **Fetch and build**
   ```bash
   cd ~/Projects/nexus && git fetch origin && git checkout feat/claude-agent-sdk-engine && git pull
   npm ci
   ls node_modules/@anthropic-ai/            # expect claude-agent-sdk AND claude-agent-sdk-darwin-arm64
   npm run typecheck
   npm run --workspace=src/backend test      # expect all green (or only the orientation-block env test)
   npm run build
   ```
   If `claude-agent-sdk-darwin-arm64` is missing, `npm ci` skipped optional deps; fix the install (do not set `executable_path` to a system `claude` as a workaround unless K-Sym asks).

2. **Auth precondition** — K-Sym has done §3's login. Verify `claude -p "say ok"` works as the backend user.

3. **Live test**
   ```bash
   cd src/backend && NEXUS_LIVE_CLAUDE=1 npx tsx --test test/live/claude-engine.test.ts
   ```
   Expect 2/2 passing and a log line `[claude-engine …] auth source: none (no API key; using the claude login)` — the SDK reports `apiKeySource: 'none'` both for a keychain login and for `CLAUDE_CODE_OAUTH_TOKEN`; only `ANTHROPIC_API_KEY` would be wrong. **Done on baker-pro 2026-09-03: 2/2 pass** — but only after `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) was added to `~/Projects/nexus/.env`: the keychain login is unreadable from ssh and unsafe for a LaunchAgent using a different `claude` binary, so the token is the required setup on this host. Interpret failures with §5.

4. **Deploy the backend** (`npm run build` done above) → `launchctl kickstart -k gui/$(id -u)/<nexus-backend label>` → wait ~30 s → `curl -s localhost:4173/api/models | jq '.allModels[] | select(.provider=="claude-code") | {id, configured}'` should list the five Claude models with `configured: true`.

5. **Manual checks** (from the laptop UI pointed at baker-pro, or via `curl`). Each is pass/fail; record outcomes:
   1. New session, model `Claude Code · claude-opus-5` (enable it under Settings → Models if curation is customised). Send "list the files in this repo". Expect a streamed reply with a `Bash`/`Glob` tool card and a context-usage bar afterwards. The transcript must show one assistant bubble with text and tool calls together, not text that vanishes when the tool starts.
   2. Turn on Supervise; ask it to create a file. Expect an approval card (iOS push too if APNs configured); Allow; the tool runs; the Decisions view shows a `write` row with source `supervise`. Also ask it to read a file under Supervise: a `read` approval must appear (read-only built-ins are policy-gated via the PreToolUse `ask` hook).
   3. Ask "ask me which option I prefer, A or B". Expect the Nexus question card (tool name `question`), answer it, the turn continues with the answer.
   4. Stop a long turn mid-stream. Expect the run card "Cancelled by user", the partial text kept, and **no** error bubble.
   5. Restart the backend (`launchctl kickstart -k …`), send another turn in the same session: the model still has the earlier context (resume works) and the history renders unchanged.
   6. Switch the session's model to a Pi model (e.g. an OpenRouter one) and send: expect a 409 `engine_mismatch` error telling you to start a new session (sessions are pinned to their first engine).
   7. Delete the session; confirm `~/.claude/projects/<cwd-slug>/<sdk-session-id>.jsonl` is gone for the backend user.
   8. Send with an image attached to a `claude-code` model; the model describes it.

6. **Merge** once steps 3 and 5 pass and the laptop reports the signed-dist launch (step 3 in §2) done or waived. The repo merges with merge commits, not squashes:
   ```bash
   gh pr merge 410 --merge
   ```
   Then on baker-pro: `git checkout main && git pull && npm ci && npm run build && launchctl kickstart -k gui/$(id -u)/<nexus-backend label>`.

7. **Report back** to K-Sym: outcome of each numbered check, the `auth source` observed, anything you changed, and delete this handoff file in a follow-up commit if it is no longer useful.

## 5. Interpreting a live-test failure

- **Second prompt fails with "No conversation found" / similar.** Resume-id handling: `ClaudeEngineSession.recordSessionId` stores `session_id` from the SDK `init` message and passes it as `resume` on the next `query()`. Check the JSONL under `~/.nexus/sessions/<slug>/` for a `nexus.engine_session` entry and compare with `~/.claude/projects/…`. If the SDK writes the transcript under a different `dir`, pass `resume` together with the same `cwd` it was created with (it already does) and inspect `deleteSession`/`resume` option docs in `src/backend/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- **Tool-using case fails on "one response's blocks merged into a single entry".** The SDK docs (`sdk.d.ts` ≈ line 3269) say the CLI emits one `assistant` message per completed content block, sharing `message.id`, with `stop_reason: null`. `SdkEventMapper.handleAssistant`/`flushAssistant`/`mergeBlocks` in `events.ts` buffer those per id and flush on: a non-null `stop_reason`, a `user` frame, a `result` frame, a new `stream_event message_start`, or an id change. If real frames differ (e.g. each frame repeats accumulated content, or the final frame carries the full message), capture them: temporarily log `msg.type`, `msg.subtype`, `msg.message?.id`, `msg.message?.stop_reason` and `msg.message?.content?.map(b => b.type)` inside the `for await` in `session.ts`, run the test once, then adjust `mergeBlocks`/flush triggers and add a fixture to `claude-events.test.ts` mirroring the captured sequence. Keep the existing 15+ fixtures green.
- **Auth source is `none` and the turn 401s.** The backend user has no valid login; go back to §3. Do not "fix" it by setting an API key.
- **Auth source is `ANTHROPIC_API_KEY`.** The env strip failed; check `engines.claude.auth` in `~/.nexus/config.yaml` (must be `subscription`) and `resolveClaudeAuthEnv` in `auth.ts`.

## 6. Gotchas learned on the laptop

- Pi's `SessionManager` buffers entries in memory and only flushes to disk once an **assistant** message has been appended on that instance. A lone user message or custom entry never creates the file. Any test that inspects the JSONL must persist an assistant message first.
- The approval extension's thin wrapper must return `undefined` for a plain allow but the broker's own `{ block: false, answeredBy }` for a confirm resolved to allow; the plan's first draft got this wrong and a test caught it.
- Aborted Claude turns are persisted with `stopReason: 'aborted'` and **no** `errorMessage` (Pi parity); anything with `errorMessage` renders as a provider error in both the frontend and `flattenEntries`.
- One SDK process is spawned per turn (1–2 s startup). Known, accepted for v1; a persistent streaming-input query per session is the follow-up.
- Rollback without a revert: set `engines.claude.enabled: false` in `~/.nexus/config.yaml`; the `claude-code/*` models disappear from the picker and Pi is untouched.

## 7. Follow-ups already agreed (not blockers)

From the final review's Minor triage: assert factory names (not just count) in the `extensionFactoriesFor` test; a key-order-independence test for `ToolUseCorrelator`; route `POST /api/models/active` through the registry; make `fastify.engines` optional in `fastify.d.ts` to drop two casts; tests for the fallback registry and the disabled-Claude 400; bound the `await interrupt()` in `abort()` with the grace timer; consider `disallowedTools: ['AskUserQuestion','Task']` until subagent traffic is rendered; legacy threads with `last_model_key = NULL` bypass the engine pin.
