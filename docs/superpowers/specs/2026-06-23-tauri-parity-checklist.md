# Tauri WKWebView Parity Checklist (Phase 1 audit)

Living tick-list for the WKWebView parity gate. Mark each item **PASS** or write the
divergence in **Notes** (what looked/behaved wrong + any console error verbatim).
Don't fix as you go — just record; fixes are batched afterward.

---

## Setup (one-time)

**1. Enable Safari's Web Inspector for WKWebView**
- Safari → Settings → **Advanced** → check **"Show features for web developers"** (adds the **Develop** menu).

**2. Launch the Tauri dev shell**
```bash
# from repo root; make sure nothing is already on the ports first:
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/api/health   # want 000
npm run tauri:dev
```
Expect: splash → services boot → main Nexus window opens with data.

**3. Attach the inspector**
- Safari → **Develop → [your Mac] → Nexus** (or the localhost entry under it) → opens **Web Inspector**.
- Keep the **Console** and **Network** tabs visible while you click around. A clean console = good; copy any red errors into Notes.

> Tip: keep the inspector open the whole time. Most divergences show up as a console error or a failed network request, not just a visual glitch.

---

## A. Boot & shell (sanity — already proven in the spike, just confirm)

- [ ] App boots to the main window, data loads (backend reachable).  **Notes:**
- [ ] No red console errors on initial load.  **Notes:**

## B. Chat streaming — ⭐ TOP RISK, do this first

The chat uses `fetch` + `ReadableStream` (`/messages/stream`). WebKit has historically
buffered streamed bodies — this is the single most important check.

- [ ] **Assistant view → send a multi-sentence prompt.** Reply renders **incrementally** (tokens appear progressively), NOT all-at-once after a pause.  **Notes:**
- [ ] Network tab shows `/messages/stream` as a streaming response (data arriving over time).  **Notes:**
- [ ] **Abort mid-stream** (stop button) — stops promptly, UI returns to idle, no console error.  **Notes:**

## C. The seven views

- [ ] **dashboard** — open a project; open a task card (TaskModal); create/edit a task; open ProjectModal. Layout + data correct, no errors.  **Notes:**
- [ ] **activity** — view an agent run (AgentRunCard); expand the ToolCallTimeline; open a DiffReviewPanel (diff renders correctly).  **Notes:**
- [ ] **missions** — mission list renders; open MissionControl; view a run ledger; start/pause/stop controls render + respond.  **Notes:**
- [ ] **tickets** — ticket list renders (Jira/GitHub); open the TriageToProject flow.  **Notes:**
- [ ] **braindump** — type into the capture input (incl. paste); submit works; text/IME behave.  **Notes:**
- [ ] **assistant** — covered in section B (streaming).  ✓ (cross-ref)
- [ ] **settings** — all sections render (ModelCuration, ModelSelector, TrustPrivacy); selects/toggles work.  **Notes:**

## D. Cross-cutting interactions (most likely to differ Chromium→WebKit)

- [ ] **Clipboard copy** — click a copy button (a chat message's copy / any copy action); paste elsewhere to confirm it actually copied. (WKWebView may need a user gesture or fail silently.)  **Notes:**
- [ ] **Kanban drag (dnd-kit)** — drag a task card between columns on the dashboard; drag preview + drop + reorder all work.  **Notes:**
- [ ] **Command palette + shortcut** — open it via its keyboard shortcut; run a command.  **Notes:**
- [ ] **Modals** — open TaskModal/ProjectModal; Escape closes; focus is trapped; backdrop click behaves.  **Notes:**
- [ ] **Toasts** — trigger a notification/daemon toast; it renders and auto-dismisses.  **Notes:**
- [ ] **Dark mode** — toggle macOS appearance (System Settings → Appearance) and confirm the theme follows live (`prefers-color-scheme`).  **Notes:**
- [ ] **Scroll-follow** — in a streaming reply or activity log, it stays pinned to the bottom, and releases when you scroll up.  **Notes:**
- [ ] **OAuth / external link** — Settings → Pi auth → trigger a login that opens a browser. It opens your **default system browser** (the in-app window does NOT navigate away).  **Notes:**

---

## Divergence log (fill as you find them)

| # | Surface | What's wrong | Console error (verbatim) | Severity (blocker/annoyance/cosmetic) |
|---|---------|--------------|--------------------------|----------------------------------------|
|   |         |              |                          |                                        |

## Verdict (fill at the end)
- Overall feel as a daily driver: ___
- Any blockers: ___
- GO / NO-GO leaning: ___
