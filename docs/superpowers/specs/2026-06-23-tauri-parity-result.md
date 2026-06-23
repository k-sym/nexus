# Phase 1 — WKWebView Parity Gate: Result

**Date:** 2026-06-23
**Phase:** 1 of the full Tauri conversion (`2026-06-23-tauri-full-conversion-design.md`)
**Method:** interactive audit of the live macOS WKWebView (`npm run tauri:dev`) against the
checklist in `2026-06-23-tauri-parity-checklist.md`, with Safari Web Inspector for
console/network. Driven by the maintainer; fixes + regression by the agent.

## Verdict: ✅ GO

WKWebView is a viable daily-driver shell for Nexus. The highest-risk behaviour
(streaming chat) works, all seven views render and behave correctly, and the only
divergences found were four shell-integration issues — all now fixed and verified live.
Nothing uncovered argues against continuing to Phases 2–6.

## Coverage

| Area | Result |
|---|---|
| **Chat streaming** (`fetch` + `ReadableStream`, `/messages/stream`) — the #1 risk | ✅ **PASS** — replies render incrementally (not buffered-then-dumped); `/new` clears; abort works. Confirmed live. |
| **All 7 views** (`dashboard, activity, missions, tickets, braindump, assistant, settings`) | ✅ render and behave as expected. Confirmed live. |
| **Kanban drag** (native HTML5 DnD) | ✅ fixed + verified (was a divergence — see below). |
| **Window drag + titlebar** | ✅ fixed + verified (was a divergence — see below). |
| Cross-cutting: clipboard copy, command palette, modals, toasts, dark-mode toggle, scroll-follow, OAuth external-open | ⚠️ **not individually stress-tested.** Exercised incidentally during the view sweep; no problems observed, but each was not isolated and confirmed. Low residual risk (all standard web APIs that WebKit supports). Carried as a spot-check follow-up. |

## Divergences found and resolved

All four were **shell-integration** gaps (Tauri/WKWebView differences from Electron/Chromium),
not application logic. Fixed in commit `d95618b`; frontend suite green (157 tests).

1. **Kanban cards wouldn't drag.** The board uses the native HTML5 DnD API
   (`draggable` + `dataTransfer`); Tauri's OS-level drag-drop handler is ON by default and
   swallowed the DOM drag events. **Fix:** `.disable_drag_drop_handler()` on the main window
   (Rust). *(API note: the method is `disable_drag_drop_handler()`, not `drag_drop_enabled(false)`.)*
2. **Window wouldn't drag.** `TopBar` gated its drag handle on the Electron user-agent, which
   is absent in WKWebView; and `-webkit-app-region: drag` (Electron) is ignored by Tauri.
   **Fix (frontend):** detect Tauri and use `data-tauri-drag-region="deep"` (a *bare* attribute
   only drags direct clicks → hit-or-miss; `deep` drags any non-interactive descendant).
3. **Window drag silently denied even with the attribute.** `data-tauri-drag-region` invokes
   `start_dragging`, which needs `core:window:allow-start-dragging` (not in `core:default`).
   In dev the webview loads the Vite server — a **remote** origin — so the capability also had
   to be granted to it via `remote.urls`. **Fix:** added the permission + the dev `remote` URL
   (capabilities). *(In a packaged build the webview is the local asset protocol, which the
   capability already covers — this `remote` entry is dev-only.)*
4. **Top-left bleed + faint window title over the logo.** **Fix:** the Tauri-detection above
   now applies the `mac-traffic-lights` padding (clears the traffic lights), and
   `.hidden_title(true)` removes the title text.

## Residual / known items (carry into later phases)

- The cross-cutting interactions in the table above should get a quick isolated spot-check
  (especially **clipboard copy** — WebKit can require a user gesture — and **OAuth external
  open** via `tauri-plugin-shell`). Low risk; not a gate.
- These fixes were verified in **dev** (Vite URL). Phase 3/4 should re-confirm the same
  behaviours in the **packaged** build (where the webview uses the local asset protocol and
  the dev-only `remote` capability is irrelevant) — drag and titlebar in particular.

## Acceptance (spec §4 Phase 1)

> "every flow exercised, divergences fixed or logged, explicit go/no-go."

Met: every view + the top-risk streaming path exercised live; all divergences fixed and
verified (with the residual cross-cutting items explicitly logged); **GO**. Phases 2–6
(productionize splash → sign/notarize → dmg → dev-experience → remove Electron) are unblocked.
