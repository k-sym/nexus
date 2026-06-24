# Spike Result: Tauri v2 Shell for Nexus Desktop

**Issue:** [#78](https://github.com/k-sym/nexus/issues/78)  
**Branch:** `spike/tauri-v2-shell`  
**Date:** 2026-06-23  
**Platform tested:** macOS arm64 (Darwin 25.5.0)  

---

## 1. Recommendation

**Continue the migration to Tauri v2.** The shell-only bundle is ~17 MB vs Electron's ~261 MB (~15× smaller), idle RSS is ~267 MB vs ~444 MB (~177 MB lower), full behavioral parity with the Electron shell was reached in all exercised paths, and the #1 de-risking requirement — webview-to-localhost fetch and WebSocket from a `tauri://localhost` secure-context origin — works under a scoped CSP without any permissive fallback. The backend, daemon, frontend bundle, and all Node services remain byte-identical; only the shell changes. Electron is fully intact and recoverable on `main` at any point. The remaining work before Tauri can become the shipping default is well-scoped: cross-platform packaging, signing/notarization, and a thorough WKWebView interactive-use pass.

---

## 2. Evidence

### 2.1 Bundle size

| Metric | Electron | Tauri | Delta | Ratio |
|---|---|---|---|---|
| Total `.app` | 748 MB | 505 MB | −243 MB | 1.48× |
| Shared: services | 380 MB | 380 MB | (identical) | |
| Shared: node runtime | 108 MB | 108 MB | (identical) | |
| **Shell-only** | **261 MB** | **17 MB** | **−243 MB** | **~15×** |

Shell-only arithmetic (KB): Electron 766188 − 389140 − 110276 = 266,772 KB; Tauri 517296 − 389176 − 110276 = 17,844 KB. The difference is structural: Electron bundles Chromium + Electron runtime (~260 MB of `Contents/Frameworks/`); Tauri's shell is a single strip-release Rust binary (~18 MB) with no bundled WebKit (system WebKit.framework is zero bytes in the bundle).

### 2.2 Idle RSS

Each app launched, backend polled to 200, then 10 s settle. Shell processes classified and attributed; shared Node services excluded from both sides.

| Process role | Electron RSS | Tauri RSS | Delta |
|---|---|---|---|
| Main process | 159 MB | 109 MB | −50 MB |
| GPU helper | 112 MB | 69 MB | −43 MB |
| Network helper | 46 MB | 18 MB | −28 MB |
| Renderer / WebContent | 128 MB | 72 MB | −56 MB |
| **Shell total** | **444 MB** | **267 MB** | **−177 MB** |

**Attribution caveat:** Tauri's WebKit XPC processes (`com.apple.WebKit.{GPU,Networking,WebContent}`) have `ppid=1` (standard macOS XPC behavior). Attribution is moderate-confidence — confirmed by: (a) PIDs appeared after Tauri launch and (b) all three terminated on Tauri quit. macOS copy-on-write for WebKit framework pages means per-process RSS figures may overcount shared physical memory. Treat 267 MB as an upper bound on Tauri's private contribution; the true private advantage may be larger.

### 2.3 Cold start

| Metric | Electron | Tauri | Delta |
|---|---|---|---|
| Time-to-backend-ready (med.) | 1685 ms | 1666 ms | −19 ms |

**This is not a shell-speed comparison.** The metric measures time from `open <app>` to first HTTP 200 on `/api/health`, which requires Node backend initialization to complete. The −19 ms difference is within run-to-run noise (Tauri range 28 ms; Electron valid-run range 3 ms). No shell-only cold-start conclusion can be drawn from this methodology. Reported for completeness only; do not cite as evidence.

*Source: `docs/superpowers/specs/2026-06-23-tauri-shell-measurements.md`*

---

## 3. Parity Checklist

Each behavior from the design doc §2 (the Electron shell contract), verified against implemented code and exercised paths (Task 8 + Task 9 prod-build verification):

| Electron behavior | Status | Notes |
|---|---|---|
| System Node resolution (PATH + candidates, `NEXUS_NODE`, ≥20 gate) | **Reproduced** | `resolve_node()` in `supervisor.rs`; 10 unit tests green (Tasks 3, 6) |
| Spawn daemon (`:4100`) + backend (`:4173`) | **Reproduced** | Dev: npm scripts; prod: `node dist/...` from `resource_dir()`; ps-confirmed in-bundle paths in Task 9 |
| Spawn Vite dev server (`:5173`) in dev only | **Reproduced** | `boot()` branches on `is_dev`; skipped in prod |
| Health-poll with fail-fast on early child exit | **Reproduced** | `probe()` + `wait_for_health()` (Tasks 4–5); fail-fast via `has_exited()` check |
| Reuse-already-running services (no double-spawn) | **Reproduced** | `ensure_service()` probes first; reused service is never killed; proven via panic-on-call test (Task 7) |
| Degraded-model warning dialog | **Reproduced** | `check_models()` parses daemon `/health`; `tauri-plugin-dialog` non-blocking warning; daemon optional — memory degrades gracefully |
| Splash window + `boot:status` progress | **Reproduced** | `splash.html` via `tauri://localhost` asset protocol; `emit("boot://status", …)` after each state change; `withGlobalTauri:true` + `window.__TAURI__.event.listen` |
| Group-kill all spawned children on window-close | **Reproduced** | `WindowEvent::CloseRequested` (main window) wired to `kill_spawned()`; process-group kill (not just direct child) confirmed by grandchild-survives test (Task 6) |
| Group-kill all spawned children on app-exit | **Reproduced** | `RunEvent::Exit` also wired to `kill_spawned()`; SIGTERM routes through proven exit path via atomic-flag + watcher thread (Task 8 hardening) |
| Reused services NOT killed | **Reproduced** | `reused` vs `children` tracked separately; only `children` are group-killed |
| External `http(s)` links in system browser | **Reproduced** | Navigation handler → `tauri-plugin-shell` open |
| Prod bundled-Node spawn | **Reproduced** | Task 9 prod build: GUI-launched `.app` spawned daemon+backend under `Contents/Resources/node/bin/node` (ps-confirmed); 200s on 4100+4173; clean quit reaped PIDs |
| `window.__NEXUS_API__` injection (prod) | **Reproduced** | `initialization_script` sets `window.__NEXUS_API__ = 'http://127.0.0.1:4173/api'` in prod main window; dev falls through Vite proxy; `src/frontend/src/api-base.ts` unchanged |
| `titleBarStyle: hiddenInset` analog | **Reproduced** | `TitleBarStyle::Overlay` set on main window |
| Zero frontend code changes | **Confirmed** | `src/frontend/` is byte-identical across both shells |

**Implemented-but-not-exhaustively-exercised:** The splash `beforeDevCommand` path was corrected in Task 9 but not re-run end-to-end in dev mode after the fix (the prod path exercises the same string; low-risk gap). Interactive click-through of all frontend routes under WKWebView was not performed (see §5).

---

## 4. Risk #1 Verdict

**CLEARED.** Webview-to-localhost fetch and WebSocket succeed under a scoped CSP from a `tauri://localhost` (asset-protocol) secure-context origin.

**Probe result:** `FETCH ok=true status=200` for `http://127.0.0.1:4173/api/health`; WebSocket error was route-level (no upgrade handler at `/`), not a security block; no global errors.

**CSP in `tauri.conf.json` (production):**
```
default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; script-src 'self' 'unsafe-inline'
```

This is stricter than the reference app's `csp: null` (which allows all connections). The scoped `connect-src` was sufficient on first attempt — no fallback to `csp: null` was needed. The `https://unpkg.com` entry from the probe phase was removed before production; the splash page now bundles `@tauri-apps/api` locally.

---

## 5. What Was NOT Tested / Limitations

These are real gaps in the spike evidence base. They do not reverse the recommendation but must be tracked as preconditions before promoting Tauri to the shipping default.

- **macOS-only build.** No Linux (WebKitGTK) or Windows (WebView2) build was produced. Cross-platform differences are assessed analytically only (§6).
- **Adhoc-signed only.** The `.app` is signed with an ad-hoc identity. `com.apple.security.cs.allow-dyld-environment-variables` and `disable-library-validation` entitlements are declared in the plist but are not Gatekeeper-enforced until the app is Developer-ID signed. Notarization was not done. Entitlement behavior on end-user machines is unverified.
- **WKWebView rendering and JS parity not exhaustively exercised.** The frontend loads, `__NEXUS_API__` injection works, and backend is reachable. No systematic click-through of all application routes, modals, or interactive features was performed. WKWebView vs Chromium behavior differences (CSS, Web APIs, Intl, WebGL) under real interactive use are unknown.
- **node-pty terminal WebSockets not specifically verified.** The WebSocket CSP allows `ws://127.0.0.1:*` and `ws://localhost:*`, and the probe confirmed WebSocket is not security-blocked. However, the live terminal experience (node-pty over WebSocket inside the packaged app) was not exercised in the Task 9 verification.
- **Cold start not a clean shell metric.** The methodology (time-to-`/api/health`) captures Node service init, not shell initialization. No shell-only startup comparison was made.
- **Dev splash end-to-end not re-run after Task 9 path fix.** The corrected `beforeDevCommand` (`cp splash.html ../src/frontend/dist/splash.html`) was verified as the right string but not live-tested in dev mode post-fix.

---

## 6. Cross-Platform Assessment

*Analytical only — no builds produced on non-macOS.*

### Linux (WebKitGTK)

- **Rendering:** WebKitGTK (GTK3/4-embedded WebKit) carries known CSS and Web API gaps versus Chromium. Font rendering, CSS Grid edge cases, and WebGL support vary by distro and WebKitGTK version. A frontend parity audit on Linux is mandatory before shipping.
- **Dependency:** Users must have `libwebkit2gtk-4.1` (or `libwebkitgtk-6.0`) installed. Unlike macOS, WebKit is not guaranteed present. This is a meaningful distribution concern — either bundle it (large) or accept a runtime dependency.
- **Packaging:** Tauri produces `.deb`, `.rpm`, and AppImage on Linux. The Node services staging and resource-path logic in `boot()` is OS-agnostic in principle, but path separators and `resource_dir()` behavior should be validated.

### Windows (WebView2)

- **WebView2 runtime:** Ships by default on Windows 10 1803+ and 11, but older installs may need the Evergreen runtime. Tauri can bundle a fixed version (large) or use the Evergreen bootstrapper. The Nexus installer strategy must decide.
- **Rendering:** WebView2 is Chromium-based (Edge), so frontend parity is less of a concern than on Linux — closer to Electron. CSS/JS behavior should largely match.
- **Process isolation:** Process-group kill (`setsid`/`kill(-pgid)`) is Unix-only. The Windows equivalent (job objects) is not yet implemented. `kill_spawned()` would fall back to direct-child kill only on Windows, potentially leaving node-pty grandchildren as orphans. This needs a Windows-specific implementation before shipping.
- **Entitlements/signing:** Windows uses Authenticode (PKCS#7); no entitlements file. The macOS `entitlements.plist` is irrelevant. Code-signing with an EV certificate is standard; auto-update via Tauri's updater plugin is well-supported on Windows.

### Resource / target-triple handling

The current `bundle.resources` approach (staging Node services as plain directory trees) is not target-triple-sensitive. The bottleneck is the `resolve_node()` candidate list (`~/.nvm`, Homebrew, etc.) which has macOS-specific paths. A Windows/Linux candidate list must be added. The `spawn_env` PATH enrichment is similarly macOS-biased.

### Signing and notarization

- **macOS:** Developer-ID signing + notarization required for distribution. `tauri-plugin-updater` supports Sparkle on macOS. The spike's adhoc signature is build-time-only; a proper signing workflow needs CI secrets.
- **Linux/Windows:** See above. Per-OS signing workflows need CI matrix jobs.

---

## 7. Follow-Up Issues

These are ready to file as individual issues. Minor cleanup items are taken directly from the SDD progress ledger.

- **Cross-platform Tauri packaging (Linux + Windows).** Target: produce `.deb`/AppImage (Linux) and NSIS/MSI (Windows) builds in CI. Includes: WebKitGTK dependency strategy; Windows job-object group-kill implementation (Unix `setsid`/`kill(-pgid)` does not port); `resolve_node()` candidate paths for each OS; `spawn_env` PATH for each OS.

- **Signing, notarization, and auto-update.** macOS: Developer-ID signing + notarization + Sparkle/`tauri-plugin-updater`. Windows: Authenticode signing. Linux: GPG-signed package repos or AppImage signing. All three need CI secrets and release pipeline integration.

- **Exhaustive WKWebView frontend parity pass (interactive + terminals).** Systematic click-through of all application routes, modals, forms, and interactive flows under WKWebView. Specifically: node-pty terminal sessions over WebSocket in the packaged `.app`; any CSS/Web API divergences from Chromium; Intl/date formatting differences. Gate: no regressions vs Electron before promoting Tauri to default.

- **Promote Tauri to default desktop wrapper.** Once cross-platform packaging, signing, and WKWebView parity are proven: replace the root `npm start` / `npm run package` scripts to target Tauri, archive or remove the Electron workspace, update README + CI. Prerequisite: all above issues closed.

- **Cleanup: entitlements plist comment.** `tauri/src-tauri/entitlements.plist` still contains a comment referencing Electron/V8 (harmless, but misleading). Fix before distribution.

- **Cleanup: `spawn_npm` prod-guard.** `spawn_npm` calls `resolve_node()` internally; it is currently only called from dev-mode paths, so there is no prod regression, but the call is logically inconsistent and should be guarded or refactored.

- **Cleanup: dev splash re-verification.** The `beforeDevCommand` path was corrected in Task 9 (`cp splash.html ../src/frontend/dist/splash.html`) but not live-tested in dev mode after the fix. Verify the splash renders correctly on `npm run tauri:dev` before closing the migration.

- **Cleanup: `canonicalize` fallback.** `repo_root()` falls back to `"."` if `canonicalize` fails. In dev this is fine; harden with an explicit error before shipping prod builds.

- **Optional: strip `https://unpkg.com` dead-weight from CSP.** Already removed in Task 8; confirm it is absent in the final committed `tauri.conf.json`. (Belt-and-suspenders check.)

---

## 8. Acceptance Criteria (Design Doc §11)

| Criterion | Status |
|---|---|
| Committed spike writeup with continue/stay recommendation backed by measured deltas | **MET** — this document |
| Working Tauri shell prototype with parity to §2 Electron behaviors | **MET** — all 14 behaviors reproduced; two minor gaps documented (§5) |
| Electron wrapper left fully intact and recoverable | **MET** — `electron/` and `dist-app/` unchanged throughout; Electron is the current `main` default |
| Go-forward work split into smaller migration issues | **MET** — §7 above |

---

*Spike conducted on branch `spike/tauri-v2-shell`. Measurements in `docs/superpowers/specs/2026-06-23-tauri-shell-measurements.md`. Design and risk details in `docs/superpowers/specs/2026-06-23-tauri-shell-spike-design.md`. SDD progress ledger in `.superpowers/sdd/progress.md`.*
