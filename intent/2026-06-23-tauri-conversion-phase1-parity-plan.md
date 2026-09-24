# Tauri Conversion — Phase 1: WKWebView Parity Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **NOTE: this phase is an INTERACTIVE GUI audit of a native macOS WKWebView window — automated E2E against a live macOS WKWebView is unsupported (`tauri-driver` has no macOS backend). Most tasks are driven by a human (or an agent with computer-use) following explicit per-surface pass criteria, with Safari Web Inspector for console/network and screenshots as evidence. The vitest suite is a regression guard for any code fixes, NOT the parity proof (jsdom ≠ WKWebView).**

**Goal:** Prove (or disprove) that the Nexus React UI runs in the Tauri/WKWebView shell with full day-to-day parity to the Electron/Chromium experience — the go/no-go gate for the rest of the conversion.

**Architecture:** Run the Tauri dev shell (`npm run tauri:dev`, which boots the supervisor → daemon + backend + Vite → main webview at `http://localhost:5173`). Drive every view and cross-cutting interaction in the WKWebView, observing the DOM/behaviour and the Safari Web Inspector console/network. Catalogue every WebKit-vs-Chromium divergence in a living checklist, fix each with a minimal targeted change to `src/frontend`, re-verify, then write a go/no-go result doc.

**Tech Stack:** Tauri v2 (WKWebView), the existing React 19 + Vite + Tailwind + dnd-kit frontend, Safari Web Inspector (WKWebView remote debugging), vitest (regression guard).

## Global Constraints

From `docs/superpowers/specs/2026-06-23-tauri-full-conversion-design.md`:

- **Platform: macOS arm64 only.** No Linux/Windows work.
- **This phase is the go/no-go gate** (spec §4 Phase 1, §5). Electron stays fully intact and runnable until Phase 6 — do NOT modify `electron/`, `electron-builder.yml`, or remove Electron in this phase.
- **Frontend fixes must be minimal and targeted** to genuine WKWebView divergences — Phase 1 is the first phase permitted to touch `src/frontend/src`, but it is parity-fixing, not a redesign. No unrelated refactoring.
- **Do not touch** `src/backend`, `src/memory-daemon`, or the Rust shell (`tauri/src-tauri`) in this phase unless a divergence's root cause is genuinely there (if so, flag it — it may belong to a different phase).
- **Backend/daemon/frontend artifacts are unchanged** in architecture; the webview talks to the backend over the scoped-CSP-allowed localhost origin proven in the spike.
- **The vitest suite must stay green** after any fix: `npm run --workspace=src/frontend test`.
- Work happens on branch `feat/tauri-full-conversion`. Commit after each task.
- **There is NO frontend terminal** (no xterm/WebSocket in the webview) — do not invent a terminal parity check; node-pty is backend-only and never reaches the webview.

---

## File structure

```
docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md   # living audit checklist (Task 1, updated through Task 5)
docs/superpowers/specs/2026-06-23-tauri-parity-result.md      # go/no-go result (Task 6)
src/frontend/src/**                                            # targeted parity fixes only (Task 5)
```

No new production source files are expected unless a fix requires one. The two docs are the primary deliverables alongside any fixes.

---

## Task 1: Inspection harness + parity checklist

**Files:**
- Create: `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md`

**Interfaces:**
- Produces: a repeatable way to (a) launch the Tauri dev shell, (b) read the WKWebView console/network via Safari Web Inspector, and (c) a checklist enumerating every surface with concrete check + expected outcome + a result field. Consumed by Tasks 2–5.

- [ ] **Step 1: Launch the Tauri dev shell and confirm it boots**

Ensure ports `4100/4173/5173` are clear (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/api/health` → `000`). Run `npm run tauri:dev` from the repo root. Expected: splash → supervisor spawns daemon+backend+vite (watch `[boot]` stderr) → main window opens to the Nexus UI. If the UI loads and shows data, the webview↔backend path works (as proven in the spike).

- [ ] **Step 2: Attach Safari Web Inspector to the WKWebView**

Enable Safari's developer tools: Safari → Settings → Advanced → check **"Show features for web developers"** (adds the Develop menu). With the Tauri dev app running, open Safari → **Develop → [this Mac] → [Nexus app] → localhost** to open the Web Inspector against the WKWebView. Confirm you can see the **Console** and **Network** tabs live.
Expected: console attaches and shows the app's logs. If the webview does not appear under Develop, confirm Tauri dev builds enable an inspectable webview (Tauri v2 enables devtools in debug builds; on macOS 13.3+ the webview must be `isInspectable`, which the debug build sets). Fallback: open devtools programmatically from the Rust shell in dev if needed — note this in the checklist doc as the harness step.

- [ ] **Step 3: Write the parity checklist doc**

Create `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md` with the harness steps above and a table of every surface to verify, each row: **Surface | Check (what to do) | Expected | Result (pass/divergence) | Notes**. Seed it with these rows (the real surfaces, from `src/frontend/src`):

Views: `dashboard` (KanbanBoard dnd, ProjectModal/TaskModal, task cards), `activity` (ActivityConsole, AgentRunCard, ToolCallTimeline, DiffReviewPanel), `missions` (MissionsView list + MissionControl + run ledger), `tickets` (TicketsView list + TriageToProject), `braindump` (BraindumpView capture), `assistant` (AssistantView/ChatPanel streaming — see Task 2), `settings` (SettingsPage, ModelCuration, ModelSelector, PiAuthSection OAuth, TrustPrivacySection).
Cross-cutting: chat streaming (Task 2), clipboard copy (ChatPanel/App copy buttons), dnd-kit Kanban drag, CommandPalette + keyboard shortcuts, modals/`<dialog>` behaviour, toasts (NotificationToasts/DaemonToasts), dark mode (`appearance.ts` `matchMedia('prefers-color-scheme')`), scroll-follow (`useFollowAtBottom`), external-link/OAuth open (PiAuthSection → system browser via tauri-plugin-shell).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md
git commit -m "docs(tauri): parity audit harness + surface checklist (phase 1)"
```

---

## Task 2: Chat streaming parity (the #1 risk)

**Files:**
- Modify (only if a divergence is found): `src/frontend/src/components/ChatPanel.tsx` and/or the stream-reading path
- Update: `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md` (streaming rows)

**Interfaces:**
- Consumes: the harness from Task 1.
- Produces: a verified verdict on whether `fetch` + `ReadableStream` incremental streaming (`/messages/stream`, NDJSON) renders progressively in WKWebView. This is isolated first because it is the highest-risk divergence and gates the value of the whole shell.

- [ ] **Step 1: Exercise a streaming chat turn in WKWebView**

In the running Tauri dev app, open the **assistant** view, send a prompt that produces a multi-token reply. Watch the message render.
Expected (PASS): tokens/chunks appear **incrementally** as they arrive (the same progressive render as in Electron), not all-at-once after a delay. Watch the Network tab: the `/messages/stream` response should show as a streaming/`fetch` body. Watch Console for errors.

- [ ] **Step 2: Test stream abort**

Start another streaming reply and click stop/abort mid-stream.
Expected: the stream stops promptly, no console errors, UI returns to idle (parity with Electron behaviour).

- [ ] **Step 3: Record the verdict; if divergent, diagnose**

Record PASS or the exact divergence in the checklist. If streaming **buffers** (whole reply appears at once) or **stalls**, diagnose: WKWebView historically buffers streamed `fetch` bodies unless chunks flush — check the backend response is unbuffered and that the reader loop (`getReader().read()` in `ChatPanel.tsx`) isn't waiting on a full buffer. The likely-needed frontend tweak is ensuring the reader processes each chunk as received; a backend Content-Type / no-transform header may also matter (if root cause is backend, FLAG it — backend is out of Phase-1 scope per Global Constraints, escalate rather than patching backend here).

- [ ] **Step 4: If a frontend fix was needed, keep tests green + re-verify**

Run `npm run --workspace=src/frontend test` (must stay green). Re-run Steps 1–2 in WKWebView to confirm the fix. Capture a screenshot of a mid-stream render as evidence.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md src/frontend 2>/dev/null
git commit -m "test(tauri): verify chat streaming parity in WKWebView (phase 1)"
```
(If no fix was needed, commit only the checklist update with message `docs(tauri): chat streaming parity verified in WKWebView`.)

---

## Task 3: Per-view parity sweep

**Files:**
- Update: `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md` (one row per view, filled in)

**Interfaces:**
- Consumes: the harness (Task 1).
- Produces: a pass/divergence result for each of the six remaining views (assistant covered in Task 2). Divergences are catalogued here and fixed in Task 5 (so this task stays a pure audit; fixing is batched).

- [ ] **Step 1: Sweep each view with the console open**

For EACH of `dashboard`, `activity`, `missions`, `tickets`, `braindump`, `settings`: navigate to it in the WKWebView, exercise its primary interactions, and watch the Console/Network for errors. Concrete per-view checks:
- **dashboard:** open a project, open a task card (TaskModal), create/edit a task, open ProjectModal. Layout + data render correctly; no console errors.
- **activity:** view an agent run (AgentRunCard), expand ToolCallTimeline, open a DiffReviewPanel — diffs render with correct syntax/layout.
- **missions:** mission list renders, open MissionControl, view a run ledger; controls (start/pause/stop) render and respond.
- **tickets:** ticket list renders (Jira/GitHub), open TriageToProject flow.
- **braindump:** type into the capture input, submit; text input + IME/paste behave.
- **settings:** all sections render (ModelCuration, ModelSelector, TrustPrivacy); form controls (selects, toggles) work. (PiAuth OAuth open is a cross-cutting check in Task 4.)

- [ ] **Step 2: Record results**

For each view, mark PASS or describe the divergence precisely (what looked/behaved wrong, any console error verbatim) in the checklist. Do NOT fix here — fixes are batched in Task 5.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md
git commit -m "docs(tauri): per-view WKWebView parity sweep results (phase 1)"
```

---

## Task 4: Cross-cutting interaction parity

**Files:**
- Update: `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md` (cross-cutting rows)

**Interfaces:**
- Consumes: the harness (Task 1).
- Produces: pass/divergence results for the interactions most likely to differ between Chromium and WebKit. Divergences catalogued for Task 5.

- [ ] **Step 1: Verify each cross-cutting interaction**

In the WKWebView, exercise and record:
- **Clipboard copy:** click a copy button (ChatPanel message copy / App copy). Expected: text lands on the system clipboard. WKWebView may require a user gesture or fail silently — verify it actually copies (paste elsewhere to confirm); note any gesture/permission divergence.
- **dnd-kit Kanban drag:** drag a task card between columns on the dashboard. Expected: drag preview + drop + reorder work (pointer events parity).
- **CommandPalette + shortcuts:** trigger the command palette via its keyboard shortcut; run a command. Expected: shortcut fires and palette works (key-event parity).
- **Modals / `<dialog>`:** open TaskModal/ProjectModal; Escape-to-close, focus trap, backdrop behave.
- **Toasts:** trigger a NotificationToast / DaemonToast (e.g. a daemon event). Expected: renders + auto-dismisses.
- **Dark mode:** toggle the OS appearance (or in-app) and confirm `matchMedia('prefers-color-scheme')` updates the theme live (`appearance.ts`).
- **Scroll-follow:** in a streaming chat / activity log, confirm `useFollowAtBottom` keeps pinned to bottom and releases on scroll-up.
- **External-link / OAuth open:** Settings → PiAuthSection → trigger a login that opens the system browser. Expected: opens in the default browser via tauri-plugin-shell (parity with Electron `shell.openExternal`); the in-app webview does NOT navigate away.

- [ ] **Step 2: Record results + commit**

Mark each PASS or divergence in the checklist.
```bash
git add docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md
git commit -m "docs(tauri): cross-cutting WKWebView parity results (phase 1)"
```

---

## Task 5: Fix catalogued divergences (loop)

**Files:**
- Modify: `src/frontend/src/**` (targeted, per divergence)
- Test: existing `src/frontend/src/**/*.test.tsx` (regression guard)
- Update: `docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md` (mark each divergence resolved)

**Interfaces:**
- Consumes: the divergence list catalogued in Tasks 2–4.
- Produces: a frontend where every catalogued WKWebView divergence is fixed or explicitly accepted, with the vitest suite green.

> This task is a LOOP over the divergences found in Tasks 2–4. If Tasks 2–4 found **zero** divergences, skip to Step 4 (record "no fixes required"). Otherwise repeat Steps 1–3 per divergence. Do not invent fixes for problems that did not occur — YAGNI.

- [ ] **Step 1: For one divergence — write/adjust a regression test where feasible, then fix**

Pick the next catalogued divergence. If it is unit-testable in jsdom (logic, not a pure WebKit rendering quirk), add/adjust a vitest test in the relevant `*.test.tsx` capturing the corrected behaviour. Then apply the **minimal** targeted fix in `src/frontend/src`. (Pure rendering/CSS quirks that jsdom can't see are verified only in the webview — note that in the checklist.)

- [ ] **Step 2: Verify — vitest green + re-check in WKWebView**

Run `npm run --workspace=src/frontend test` (must pass). Reload the Tauri dev webview and re-exercise the specific surface to confirm the divergence is gone and no new console error appeared. Capture a screenshot if visual.

- [ ] **Step 3: Commit this fix**

```bash
git add src/frontend docs/superpowers/specs/2026-06-23-tauri-parity-checklist.md
git commit -m "fix(tauri): <divergence> parity in WKWebView (phase 1)"
```
Repeat Steps 1–3 for the next divergence.

- [ ] **Step 4: Final regression run**

Run `npm run --workspace=src/frontend test` once more. Expected: full suite green. Confirm every checklist row is now PASS or explicitly ACCEPTED (with reason).

---

## Task 6: Parity-pass result doc (go/no-go)

**Files:**
- Create: `docs/superpowers/specs/2026-06-23-tauri-parity-result.md`

**Interfaces:**
- Consumes: the completed checklist + fixes.
- Produces: the explicit GO / NO-GO decision for proceeding to Phases 2–6.

- [ ] **Step 1: Write the result doc**

Summarize: (a) **Verdict** — GO (WKWebView is a viable daily driver) or NO-GO (with the blocker); (b) **Coverage** — every view + cross-cutting interaction exercised, linking the checklist; (c) **Divergences found + how resolved** (or accepted, with reason); (d) **Streaming verdict** (Task 2) called out explicitly since it was the top risk; (e) **Residual/known issues** carried as caveats; (f) **Any backend/Rust root causes** discovered that belong to other phases.

- [ ] **Step 2: Verify against the spec**

Confirm the Phase 1 acceptance bar from spec §4 is met: "every flow exercised, divergences fixed or logged, explicit go/no-go." If GO, the later phases (2–6) are unblocked.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-parity-result.md
git commit -m "docs(tauri): WKWebView parity gate result + go/no-go (phase 1)"
```

---

## Self-Review

**1. Spec coverage (Phase 1 of the migration spec):**
- "Drive every view and flow interactively in the Tauri webview" → Tasks 2 (assistant), 3 (6 views), 4 (cross-cutting). ✓
- "catalogue and fix any WebKit-vs-Chromium divergence (CSS, JS/Intl, scroll/drag, file inputs)" → Tasks 3–4 catalogue, Task 5 fixes; scroll (useFollowAtBottom), drag (dnd-kit), inputs (braindump/forms) all covered. ✓
- "verify node-pty terminal over websocket in WKWebView" → CORRECTED: no frontend terminal exists; explicitly scoped out in Global Constraints. The original spec line was based on a spike-era assumption; documented as N/A. ✓ (gap intentionally closed)
- "first to touch src/frontend/src (small, targeted fixes only)" → Task 5, constrained. ✓
- "documented parity pass … explicit go/no-go" → Task 6. ✓
- Streaming (`/messages/stream` ReadableStream) elevated to its own Task 2 as the top risk — not named in the spec but is the highest-value parity check. ✓

**2. Placeholder scan:** No TBD/TODO. Tasks 2–4 are interactive checks with concrete per-surface actions + expected outcomes (not "test everything"). Task 5 is an explicit loop with a zero-divergence skip path. The one unavoidable open-endedness — which specific fixes Task 5 applies — is inherent to an audit (you cannot enumerate fixes for divergences not yet found); it is bounded by "minimal/targeted, catalogued items only, YAGNI" rather than left vague. No hidden "add error handling" placeholders.

**3. Type/identifier consistency:** View names (`dashboard, activity, missions, tickets, braindump, assistant, settings`) match `GlobalView` in `App.tsx:26`. Component names (ChatPanel, KanbanBoard, MissionControl, PiAuthSection, useFollowAtBottom, appearance.ts) match `src/frontend/src`. The two doc artifacts are referenced by identical paths across Tasks 1→5 (checklist) and 6 (result). Test command `npm run --workspace=src/frontend test` is consistent throughout.

**Note on execution:** Tasks 2–4 are interactive GUI verification on a native WKWebView and are best executed by the maintainer (or an agent with computer-use), not headless subagents. Task 1 (harness + checklist) and Tasks 5–6 (fixes + writeup) are agent-friendly. Flag this at execution handoff.
