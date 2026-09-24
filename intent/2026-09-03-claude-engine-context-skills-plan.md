# Claude Engine Context Files, Skills and Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Claude-engine sessions the project's `AGENTS.md`/`CLAUDE.md` the way Pi sessions already get them, and let the user opt the engine into their global Claude Code skills, plugins and hooks (and per-project ones) through config, surfaced in Settings.

**Architecture:** Two config knobs under `engines.claude`: `setting_sources` (which Claude Code settings the SDK loads: `user` = `~/.claude` skills/plugins/hooks/settings, `project` = `.claude/*` + `CLAUDE.md`, `local`) and `skills` (`all` | `none` | list). `ClaudeEngine` reads the project context files with Pi's own loader and appends them to the system-prompt appendix — `AGENTS.md` always, `CLAUDE.md` only when the SDK will not load it itself (i.e. `project` not in `setting_sources`) — so Pi and Claude sessions see the same instructions and nothing is injected twice. `GET /api/engines` and the Settings Engines section report the effective values. Nexus policy stays authoritative: the existing PreToolUse `ask` hook still routes every tool call through `canUseTool` regardless of any `permissions.allow` rules loaded from settings.

**Measured on the laptop (2026-09-03, SDK 0.3.258):** `settingSources: []` → 20 bundled skills, 0 plugins, 31 tools. `settingSources: ['user']` → 68 skills (the `~/.claude/skills` set synced by skillshare), 6 plugins (codex, gitkraken-hooks, swift-lsp, ui-ux-pro-max, atlassian, superpowers), 130 tools (plugin MCP servers), and `~/.claude/settings.json` hooks (Notification, PreToolUse, Stop). Pi's loader (`loadProjectContextFiles`) reads `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md` from the cwd (and the agent dir, which Nexus points at `~/.nexus/sessions`).

## Global Constraints

- Backend ESM (`.js` suffixes); backend tests `npx tsx --test <file>` from `src/backend`; frontend tests `npx vitest run <file>` from `src/frontend`; rebuild shared before backend typecheck when `NexusConfig` changes (`npm run --workspace=src/shared build`).
- Config: `engines.claude.setting_sources: Array<'user' | 'project' | 'local'>` default `[]`; `engines.claude.skills: 'all' | 'none' | string[]` default `'all'`. Unknown strings in `setting_sources` are dropped, not passed to the SDK.
- SDK mapping: `settingSources: cfg.setting_sources`; `skills`: `'all'` → `'all'`, `'none'` → `[]`, list → the list.
- Context files: use `loadProjectContextFiles({ cwd, agentDir: pi.paths.sessionsDir })` from `@earendil-works/pi-coding-agent`. Append each file as `# Project instructions (<basename>)\n\n<content>` to the Claude session's `systemPromptAppendix`, after the existing orientation/Monday blocks. Skip files named `CLAUDE.md`/`CLAUDE.MD` when `'project'` is in `setting_sources`. Cap each file at 24 000 characters (truncate with a trailing `\n\n[truncated]`). Pi sessions are untouched (they already load these).
- `GET /api/engines` adds `settingSources: string[]` and `skills: 'all' | 'none' | string[]` to the engine status; the Settings Engines section shows them in words.
- Nothing under `project_docs/**` is committed; `src/glasses/package-lock.json` stays out of commits.

---

### Task 1: Config + engine wiring + context files

**Files:**
- Modify: `src/shared/index.ts` (`NexusConfig.engines.claude` gains `setting_sources`, `skills`), `src/backend/config.ts` (defaults), `src/backend/engines/claude/auth.ts` (nothing), `src/backend/engines/claude/status.ts` (status fields), `src/backend/engines/claude/session.ts` (`ClaudeSessionDeps.settingSources`, `.skills` → query options), `src/backend/engines/claude/engine.ts` (context files + passes the new deps)
- Create: `src/backend/engines/claude/context-files.ts`
- Test: `src/backend/test/claude-context-files.test.ts` (new), `src/backend/test/claude-session.test.ts` (append), `src/backend/test/claude-engine.test.ts` (append), `src/backend/test/routes-engines.test.ts` (adjust the `deepEqual` for the new fields), `src/backend/test/config-engines.test.ts` (adjust defaults)

**Interfaces:**
- `src/backend/engines/claude/context-files.ts`:
  ```ts
  export interface ContextFile { path: string; content: string }
  export const CONTEXT_FILE_MAX_CHARS = 24_000;
  export function selectContextFiles(files: ContextFile[], settingSources: string[]): ContextFile[]; // drops CLAUDE.md when 'project' present
  export function formatContextFiles(files: ContextFile[]): string; // '' when none; each block "# Project instructions (<basename>)\n\n<content>" joined by "\n\n"; truncation rule above
  export function projectContextAppendix(cwd: string, agentDir: string, settingSources: string[]): string; // loadProjectContextFiles → select → format; never throws (returns '' on error)
  ```
- `ClaudeSessionDeps` gains `settingSources: Array<'user'|'project'|'local'>` and `skills: 'all' | string[]` (already mapped: `'none'` becomes `[]` in the engine).
- `EngineStatus` gains `settingSources: string[]` and `skills: 'all' | 'none' | string[]`.
- Config normaliser `normalizeClaudeEngineConfig(cfg)` in `status.ts` (exported): filters `setting_sources` to the three known values; coerces `skills` to `'all' | 'none' | string[]` (default `'all'`).

- [ ] **Step 1: Tests first**

`src/backend/test/claude-context-files.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTEXT_FILE_MAX_CHARS, formatContextFiles, projectContextAppendix, selectContextFiles } from '../engines/claude/context-files.js';

test('selectContextFiles drops CLAUDE.md only when the SDK loads project settings itself', () => {
  const files = [{ path: '/r/AGENTS.md', content: 'a' }, { path: '/r/CLAUDE.md', content: 'c' }];
  assert.deepEqual(selectContextFiles(files, []).map((f) => f.path), ['/r/AGENTS.md', '/r/CLAUDE.md']);
  assert.deepEqual(selectContextFiles(files, ['project']).map((f) => f.path), ['/r/AGENTS.md']);
  assert.deepEqual(selectContextFiles(files, ['user']).map((f) => f.path), ['/r/AGENTS.md', '/r/CLAUDE.md']);
});

test('formatContextFiles labels each file and truncates long ones', () => {
  assert.equal(formatContextFiles([]), '');
  const out = formatContextFiles([{ path: '/r/AGENTS.md', content: 'Be terse.' }, { path: '/r/sub/CLAUDE.md', content: 'x'.repeat(CONTEXT_FILE_MAX_CHARS + 10) }]);
  assert.match(out, /^# Project instructions \(AGENTS\.md\)\n\nBe terse\./);
  assert.match(out, /# Project instructions \(CLAUDE\.md\)\n\nx+\n\n\[truncated\]$/);
  assert.ok(out.length < CONTEXT_FILE_MAX_CHARS + 200);
});

test('projectContextAppendix reads AGENTS.md from the cwd via the Pi loader and never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-ctx-'));
  try {
    const cwd = join(dir, 'repo'); mkdirSync(cwd); writeFileSync(join(cwd, 'AGENTS.md'), 'Use pnpm.');
    const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
    assert.match(projectContextAppendix(cwd, agentDir, []), /Use pnpm\./);
    assert.equal(projectContextAppendix(join(dir, 'missing'), agentDir, []), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

Append to `claude-session.test.ts`: the recorded query options carry `settingSources` and `skills` from deps (`makeSession(dir, queryFn, { settingSources: ['user'], skills: 'all' })` → `calls[0].options.settingSources` deep-equals `['user']`, `calls[0].options.skills === 'all'`; with `skills: []` the option is `[]`).

Append to `claude-engine.test.ts`: with a temp cwd containing `AGENTS.md` ("Prefer tabs."), a session's first query has `options.systemPrompt.append` containing `Prefer tabs.`; with `setting_sources: ['project']` in the engine config and only a `CLAUDE.md` present, the append does NOT contain the file (SDK loads it) — and with `[]` it does. (Add `setting_sources`/`skills` to the `enabled` fixture: `setting_sources: [], skills: 'all'`.)

Adjust `routes-engines.test.ts`'s `deepEqual` to include `settingSources: [], skills: 'all'` and `config-engines.test.ts`'s expected defaults to include `setting_sources: [], skills: 'all'`.

- [ ] **Step 2: Shared type + defaults** — in `NexusConfig.engines.claude` add:

```ts
      /** Which Claude Code settings the SDK loads for engine sessions:
       *  `user` = ~/.claude (skills, plugins, hooks, settings), `project` =
       *  .claude/* + CLAUDE.md, `local` = .claude/settings.local.json. Empty
       *  (default) = isolation: only Nexus's tools, policy and prompt. */
      setting_sources: Array<'user' | 'project' | 'local'>;
      /** Skills offered to the model: 'all' (default), 'none', or a list of skill names. */
      skills: 'all' | 'none' | string[];
```

Defaults in `config.ts`: `setting_sources: [], skills: 'all'`. Rebuild shared.

- [ ] **Step 3: Normaliser + status** (`status.ts`)

```ts
const SETTING_SOURCES = new Set(['user', 'project', 'local']);
export function normalizeClaudeEngineConfig(cfg: ClaudeEngineConfig): { settingSources: Array<'user'|'project'|'local'>; skills: 'all' | 'none' | string[] } {
  const settingSources = (Array.isArray(cfg.setting_sources) ? cfg.setting_sources : []).filter((s): s is 'user'|'project'|'local' => typeof s === 'string' && SETTING_SOURCES.has(s));
  const raw = cfg.skills as unknown;
  const skills = raw === 'none' ? 'none' : Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : 'all';
  return { settingSources, skills };
}
```

`claudeEngineStatus` spreads `normalizeClaudeEngineConfig(cfg)` into the status (`settingSources`, `skills`).

- [ ] **Step 4: Context files module** (`context-files.ts`) — as specified in Interfaces; `projectContextAppendix` wraps `loadProjectContextFiles` in try/catch.

- [ ] **Step 5: Session + engine** — `session.ts`: add the two deps and pass `settingSources: this.deps.settingSources` and `skills: this.deps.skills` in the query options (replace the hard-coded `settingSources: []`). `engine.ts` `createSession`: `const { settingSources, skills } = normalizeClaudeEngineConfig(cfg)`; `systemPromptAppendix: [pi.systemPromptAppendixFor(threadId, cwd), projectContextAppendix(cwd, pi.sessionDirFor === undefined ? '' : pi.paths.sessionsDir, settingSources)].filter(Boolean).join('\n\n')`; `skills: skills === 'none' ? [] : skills`.

- [ ] **Step 6: Verify + commit** — the five test files, `npm run --workspace=src/backend test`, typecheck. Commit: `feat(engines): project AGENTS.md/CLAUDE.md for Claude sessions; configurable setting sources and skills`.

---

### Task 2: Surface in Settings + docs

- `src/frontend/src/components/EnginesSection.tsx`: after the auth line, render `Settings loaded: none (isolated)` or `Settings loaded: user, project` and `Skills: all | none | <n> listed`. Tests in `EnginesSection.test.tsx` for both.
- README Engines section: document `setting_sources` (global = `user`, per-project = `project`), `skills`, the AGENTS.md/CLAUDE.md injection rule, and that Nexus policy still gates every tool call even with `permissions.allow` rules loaded. Plan "Known limits" updated. Commit: `docs(engines): setting sources, skills and context files`.

### Task 3: Live verification (laptop)

`NEXUS_LIVE_CLAUDE=1` run of `test/live/claude-engine.test.ts` still 2/2. Then a manual probe: temporarily set `setting_sources: ['user']` in `~/.nexus/config.yaml`, restart the dev backend, send "Which skills do you have? Name three." on a `claude-code` model and confirm the answer lists user skills; confirm a Supervise-parked approval still appears for `Bash` despite `permissions.allow` rules in `~/.claude/settings.json`. Revert the config afterwards unless K-Sym wants it on.
