# Full conversion: Tauri v2 as the default Nexus shell (macOS)

**Follows:** the Tauri v2 spike ([#78](https://github.com/k-sym/nexus/issues/78), [PR #98](https://github.com/k-sym/nexus/pull/98))
**Date:** 2026-06-23
**Status:** Design — pending implementation plan(s)
**Type:** Migration (promote the spike prototype to the production default; remove Electron)

## 1. Goal

Take the Tauri v2 shell from a proven spike to **the default — and only — desktop
shell for Nexus on macOS**, producing a **signed + notarized** distributable, and
**remove Electron** entirely. Keep the React frontend, Node/Fastify backend, and
memory daemon unchanged in architecture (the frontend may take small fixes for
WKWebView parity).

The spike already proved feasibility and parity and measured a ~15× smaller shell /
−177 MB idle RSS (see `2026-06-23-tauri-shell-spike-result.md` and
`2026-06-23-tauri-shell-measurements.md`). This document scopes the remaining effort.

## 2. Scope (decided)

- **Platform:** macOS, **arm64 only**. No Linux/Windows. (Consequence: the existing
  Unix-only supervisor — `libc::setsid`/`kill`, SIGTERM watcher — needs no
  cross-platform work.)
- **Distribution:** **signed + notarized** with a Developer ID identity (the maintainer
  is an Apple developer). **No auto-update.** Output is a notarized `.dmg`.
- **Electron:** **removed outright** as the end state (sequenced last — see §5).

### Out of scope
- Linux / Windows support (and therefore Job Objects, WebView2, conpty, target triples).
- Auto-update (Tauri updater, update server, key management).
- Universal (x64) builds — Apple Silicon only.
- CI/CD pipelines (none exist today; builds stay local). Optional follow-up.
- Backend/daemon/Fastify rewrites.

## 3. Baseline: what the spike already delivered

On `spike/tauri-v2-shell` (PR #98), verified in dev and a packaged `.app`:
- Rust supervisor: system-Node resolution, health-poll, reuse-or-spawn, degraded-model
  warning, splash, **process-group kill on both close paths**, async-signal-safe SIGTERM.
- Prod bundled-Node spawn from `resource_dir()`; services + Node shipped as Tauri
  `bundle.resources` (reusing the existing `.stage/` pipeline).
- Webview→localhost cleared with a **scoped CSP** (`connect-src` localhost).
- 12 tests (11 unit + 1 process-group integration), warning-clean.
- Electron left 100% untouched.

This migration starts from that branch.

## 4. Workstreams (phases)

Each phase is a bounded unit with its own deliverable; each becomes its own
implementation plan when reached (so earlier-phase findings inform later phases).

### Phase 1 — WKWebView parity hardening (the go/no-go gate)
**Effort: M · Risk: M.** The spike confirmed the UI loads and the backend is reachable
but did **not** exhaustively exercise the app in WKWebView. Drive every view and flow
interactively in the Tauri webview; catalogue and fix any WebKit-vs-Chromium
divergence (CSS, JS/`Intl`/date, scroll/drag, file inputs, focus, animation). Crucially,
**verify the node-pty terminal feature works over its websocket inside WKWebView**
(left unverified in the spike). This phase is the first to legitimately touch
`src/frontend/src` (small, targeted fixes only). **Deliverable:** a documented parity
pass — every flow exercised, divergences fixed or logged — that is the explicit
go/no-go for proceeding. If a showstopper appears, Electron is still intact.

### Phase 2 — Productionize the splash
**Effort: S · Risk: L.** Replace the spike's `cp splash.html → src/frontend/dist`
build-hook hack with a clean dedicated splash asset (its own minimal bundled entry or
a Tauri-served asset) so the splash is no longer entangled with the frontend build
output. **Deliverable:** splash renders from a first-class source, no `cp` into `dist`.

### Phase 3 — Signing + notarization
**Effort: M · Risk: M–H (the main new infrastructure).** Configure Tauri's macOS
signing with a **Developer ID Application** identity; enable **hardened runtime**;
finalize entitlements (remove the Electron/V8-era comment; keep what WKWebView + a
bundled Node child actually require — `disable-library-validation`,
`allow-dyld-environment-variables` — and drop `allow-jit`/`allow-unsigned-executable-memory`
if WebKit doesn't need them, verified by test). **The subtle part:** every nested
Mach-O must be signed, not just the app bundle — the bundled `node`, node-pty's
`spawn-helper`, and all `.node` native modules (better-sqlite3, sqlite-vec, node-pty)
under `Resources/services` and `Resources/node`. Tauri does not sign `resources/`
contents automatically the way electron-builder does, so this needs an explicit
signing sweep (sign nested binaries → sign the app → notarize via `notarytool` →
staple). **Deliverable:** a signed, notarized, stapled `.app` that passes
`spctl --assess` and launches without Gatekeeper prompts on a clean machine.

### Phase 4 — DMG packaging
**Effort: S · Risk: L.** Switch the Tauri bundle target from `app` to `dmg`; confirm
the notarized DMG mounts and the app launches cleanly through Gatekeeper.
**Deliverable:** a distributable notarized `.dmg`.

### Phase 5 — Dev-experience parity + spike-Minor cleanups
**Effort: S · Risk: L.** Resolve the accepted spike Minors (`spawn_npm` prod-guard so
it can never bypass bundled Node; harden the dev-root `canonicalize` fallback;
re-verify the splash copy on the corrected `beforeDevCommand` path). Confirm devtools
open in dev, Vite HMR works through the Tauri webview, and add a prod-simulation env
flag analogous to `NEXUS_ELECTRON_PROD` if useful. Resolve the macOS titlebar overlay
(`hiddenInset` analog) if the spike used a fallback. **Deliverable:** `npm run
tauri:dev` is a first-class daily-driver dev loop.

### Phase 6 — Make Tauri default + remove Electron (last)
**Effort: M · Risk: M.** Rewire root `package.json`: `dev`/`build`/`dist`/`pack` →
Tauri (the supervisor owns spawning daemon+backend+Vite in dev). **Delete** the
`electron/` workspace, `electron-builder.yml`, the `electron` workspace entry, and the
`electron` + `electron-builder` devDependencies. **Keep** the shared staging scripts
(`stage-services.cjs`, `fetch-node-runtime.cjs`, `ensure-sqlite-abi.cjs`,
`fix-node-pty-permissions.cjs`) — Tauri reuses them; audit and remove only
electron-only scripts (e.g. `after-pack.cjs`). Update `CLAUDE.md`, the auto-memory, and
any docs that describe the Electron shell. **Deliverable:** Electron is gone; Tauri is
the sole shell; `npm run dist` produces the notarized DMG.

## 5. Sequencing

```
Phase 1 (parity gate) ─┬─▶ Phase 2 (splash) ──┐
   │ go/no-go          └─▶ Phase 5 (dev/cleanup)┼─▶ Phase 3 (sign+notarize) ─▶ Phase 4 (dmg) ─▶ Phase 6 (remove Electron)
   └────────────────────────────────────────────┘
```

**Phase 1 is the gate** — it determines whether WKWebView is a true daily-driver. Even
though Electron is "removed outright" as the end state, its **deletion (Phase 6) is
sequenced last**, after parity is proven and Tauri has been daily-driven briefly — so a
fallback exists until the river is crossed. Phases 2 and 5 are independent and can run
alongside. Phases 3→4 are the distribution chain. Phase 6 is the point of no return.

## 6. Effort estimate

**~1 week of focused work**, dominated by:
- **Phase 1** (parity confidence — interactive testing + unknown fixes), and
- **Phase 3** (notarization iteration — nested-binary signing is the classic Mac
  time-sink).

Phases 2, 4, 5 are hours each; Phase 6 is roughly a half-day. The two M–H-risk phases
(1 and 3) carry the uncertainty; the rest is mechanical.

## 7. Acceptance criteria

- Every Nexus flow works in the Tauri/WKWebView shell, including node-pty terminals,
  with parity to the Electron experience (divergences fixed or explicitly documented).
- A **signed + notarized, stapled** arm64 `.dmg` that launches via Gatekeeper with no
  prompts and runs the bundled-Node services correctly.
- `npm run dev` / `npm run dist` drive the Tauri shell; `electron/`, `electron-builder.yml`,
  and the Electron dependencies no longer exist in the repo.
- Docs/CLAUDE.md/memory updated to describe the Tauri shell as the default.
- The spike's accepted Minor findings are resolved.

## 8. Process

One migration spec (this document); a separate implementation plan is written **per
phase as it is reached**, so the parity-gate (Phase 1) outcome and the signing (Phase 3)
realities inform the later plans rather than being guessed upfront.
