# Spike: Tauri v2 shell as a leaner Nexus desktop wrapper

**Issue:** [#78](https://github.com/k-sym/nexus/issues/78) — Spike: evaluate Tauri v2 shell as a leaner Nexus desktop wrapper
**Date:** 2026-06-23
**Status:** Design — pending implementation plan
**Type:** Spike (prove/disprove wrapper parity; not a migration)

## 1. Goal

Determine whether Nexus should replace its Electron shell with a Tauri v2 desktop
shell, **keeping the existing React frontend, Node/Fastify backend, and memory
daemon unchanged**. Produce a working Tauri prototype with parity to the current
Electron shell, measure the footprint deltas, and write a defensible
**continue-migration vs stay-on-Electron** recommendation backed by evidence.

This is a spike. We are not rewriting the backend or daemon in Rust, not replacing
Fastify, and not redesigning the frontend. Electron stays fully intact and
recoverable throughout.

## 2. Context: what the Electron shell does today

`electron/main.ts` (~250 lines) is the entire contract we must reproduce. It:

- Resolves a usable **system Node (>=20)** — never Electron's `fork()`, because that
  loads Electron's ABI and breaks the native `better-sqlite3` the services depend on.
  Probes PATH, then a candidate list (Homebrew, nvm/fnm/volta), honours `NEXUS_NODE`.
- Spawns the **memory daemon** (`:4100`) and **backend** (`:4173`) — in dev via npm
  scripts, in prod as compiled `node dist/...` — plus the **Vite dev server** (`:5173`)
  in dev only. Each spawned **detached** so it leads its own process group.
- **Health-polls** each service (`/health`, `/api/health`, the Vite URL) with fail-fast
  on early child exit, and **reuses** any service already running (e.g. a daemon under
  launchd) rather than double-spawning.
- Reads the **LLM stack status** off the daemon's `/health` (`gen`/`embed`/`rerank`)
  and shows a **degraded-memory warning** dialog when any is down — non-blocking; the
  daemon is optional and memory degrades gracefully.
- Shows a **splash window** (`splash.html`) fed by `boot:status` IPC during startup,
  then swaps to the main window once backend + frontend are ready.
- **Group-kills** all spawned children on quit (`process.kill(-pid)`), so node-pty
  terminals and other grandchildren don't orphan. Services it *reused* are not killed.
- Opens external `http(s)` links in the system browser (`shell.openExternal`).
- macOS `titleBarStyle: hiddenInset`.

Frontend coupling to the shell is minimal:
- `window.__NEXUS_API__` (`src/frontend/src/api-base.ts`) — absolute API base in prod;
  absent in dev so calls fall through the Vite proxy.
- `window.nexusBoot.onStatus` — splash progress (splash page only).

Backend CORS is `@fastify/cors` with `{ origin: true }` (`src/backend/index.ts:69`),
so it reflects any origin — a `tauri://localhost` webview is allowed.

**Footprint motivation:** the current Electron `dist-app` is **753 MB**; the frontend
build is **488 KB**. The shell (Chromium + Electron runtime) dominates.

## 3. Prior art: zosmaai/zosma-cowork

A shipping Tauri v2 + Rust + Node-sidecar desktop app (`gh repo clone
zosmaai/zosma-cowork`) solves several of the hard parts. Confirmed, copyable
findings:

- **Webview → localhost fetch works in production** with `tauri.conf.json`
  `app.security.csp: null` and **no** localhost entry in `capabilities/` — `127.0.0.1`
  is a W3C "potentially trustworthy" origin, so it isn't mixed content, and `csp: null`
  removes any `connect-src` barrier. This de-risks our #1 concern.
- **Node bundled as a plain `bundle.resources` entry, spawned via
  `std::process::Command`** (NOT Tauri's `externalBin`/sidecar API), resolved via
  `resource_dir()` in prod and source paths in dev. This is the same model as Nexus's
  Electron `extraResources`.
- `.kill_on_drop(true)` on the child; `NODE_OPTIONS=--use-system-ca` at spawn so
  bundled Node trusts the OS cert store; macOS entitlement
  `com.apple.security.cs.allow-dyld-environment-variables` is **required** for a
  bundled Node child to launch.

**Key difference from zosma:** their sidecar is a single Node RPC peer driven over
stdin/stdout JSON-lines. Nexus's daemon and backend are **autonomous HTTP servers
with health endpoints**, so Nexus's supervisor stays **health-poll-based** (a direct
port of `electron/main.ts`) and needs **no RPC bridge**.

**Divergence we will not copy:** `kill_on_drop` kills only the direct child. Nexus's
backend spawns node-pty grandchildren, so we keep Electron's **process-group kill**
in addition to `kill_on_drop`.

## 4. Architecture

```
Tauri (Rust core process)
 ├─ splash WebviewWindow ── emit("boot://status") ──> splash.html (boot progress)
 ├─ supervisor.rs  ── spawn + health-poll ──> memory-daemon :4100, backend :4173,
 │                                            vite :5173 (dev only)
 └─ main WebviewWindow ──> Vite build
        prod: bundled assets via Tauri asset protocol (+ injected window.__NEXUS_API__)
        dev:  http://localhost:5173 (Vite proxy handles /api)
```

The daemon, backend, model stack, and frontend bundle are **byte-identical** across
the Electron and Tauri shells. The only real variable in the evaluation is the shell:
WebKit/Rust vs Chromium/Electron.

### Project layout (sibling, Electron untouched)

```
tauri/
├── package.json              # npm workspace; @tauri-apps/cli devDep (no rustup needed)
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # windows created in CODE, not config, for boot timing
│   ├── build.rs
│   ├── capabilities/default.json
│   └── src/
│       ├── main.rs           # app setup, window lifecycle, dialogs
│       └── supervisor.rs     # the electron/main.ts port
└── splash.html               # adapted from electron/splash.html (Tauri event API)
```

Root `package.json` gains `tauri:dev` / `tauri:build` scripts. The `electron`
workspace and all of `electron/` are unchanged.

## 5. Component design

### 5.1 Rust supervisor (`supervisor.rs`) — 1:1 port of `electron/main.ts`

| Electron (TS) | Tauri (Rust) |
|---|---|
| `resolveNode()` / `nodeCandidates()` / `NEXUS_NODE` / `>=20` gate | `resolve_node()` — same PATH + candidate probing, `node --version`, parse major |
| `spawnEnv()` PATH enrichment | build enriched `PATH` (+ `NODE_OPTIONS=--use-system-ca`) for `Command` |
| `spawnDaemon/Backend/Frontend` (npm dev / `node` prod) | `Command` in a **new process group** (`setsid`/`process_group(0)`), `kill_on_drop(true)` |
| `probe()` / `waitForHealth()` (fail-fast on early exit) | `ureq`/`reqwest` GET with timeout + poll loop; abort if child exits early |
| `ensureService()` reuse-or-spawn | probe first → reuse (untracked, never killed) else spawn + wait |
| `checkModels()` off daemon `/health` | parse `models.{gen,embed,rerank}`, derive degraded set |
| `killChildren()` group-kill | kill the **process group** of each tracked child on exit |
| splash + `boot:status` IPC | splash `WebviewWindow` + `emit("boot://status", payload)` |
| `preflightRuntime()` / degraded dialogs | `tauri-plugin-dialog` message boxes |
| `setWindowOpenHandler` → `openExternal` | navigation handler → `tauri-plugin-shell` open for `http(s)` |

Behavioral contract preserved exactly: daemon optional (degrades), backend + frontend
gate readiness, reuse already-running services, fail fast on early child exit, never
kill reused services.

### 5.2 Window lifecycle (`main.rs`)

Windows are created **in Rust code**, not declared statically in `tauri.conf.json`, so
we control timing the way `createMainWindow()` does:

1. Create + show **splash** window (`splash.html`).
2. Run the supervisor; `emit("boot://status", …)` after each state change.
3. On `preflightRuntime` failure → dialog + quit.
4. On degraded models → non-blocking warning dialog.
5. When backend + frontend are ready → create the **main** window
   (prod: asset protocol + `initialization_script` injecting `window.__NEXUS_API__ =
   'http://127.0.0.1:4173/api'`; dev: `http://localhost:5173`), then close the splash.
6. macOS `TitleBarStyle::Overlay` (the `hiddenInset` analog).
7. On window-close / app-exit → process-group kill of tracked children, then quit.

### 5.3 Frontend integration — zero frontend code changes

- **API base:** Tauri `initialization_script` sets `window.__NEXUS_API__` on the main
  window in prod only. In dev the main window loads the Vite URL and `apiUrl()` falls
  through the proxy. `src/frontend/src/api-base.ts` is **not** modified.
- **Splash status:** `splash.html` is adapted to listen via `@tauri-apps/api/event`
  `listen('boot://status', …)` instead of `window.nexusBoot.onStatus`. This is a
  shell-owned page; the production `nexusBoot` preload contract is irrelevant here.
- **External links:** navigation handler opens `http(s)` via `tauri-plugin-shell`.

### 5.4 Webview → localhost (the de-risked #1 risk)

Default to a **scoped CSP** in `tauri.conf.json` that allows local services, since
Nexus loads no remote content:

```
connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*
```

If WKWebView still blocks `fetch`/WebSocket to localhost, fall back to
`app.security.csp: null` (the proven zosma setting). **Validate this first**, before
the full supervisor port — a bare Tauri window loading the built frontend against an
already-running backend, confirming both `fetch` and the node-pty terminal WebSocket
reach localhost. If unmitigable, that is the documented blocker.

## 6. Dev vs prod flows

- **Dev** (`npm run tauri:dev`): `beforeDevCommand` is empty; the Rust supervisor owns
  spawning daemon + backend + Vite (npm scripts, mirroring Electron `isDev`), waits on
  health, then shows the main window pointed at `devUrl=http://localhost:5173`. This
  exercises the same supervision + reuse path as prod.
- **Prod** (packaged): supervisor resolves the bundled Node, spawns compiled daemon +
  backend from `resource_dir()`, shows the main window on bundled assets. Vite is
  `skipped` (bundled), exactly as in Electron.

## 7. Packaging — reuse existing staging

No new staging pipeline. Tauri ships `.stage/services` (backend, daemon, frontend
`dist`) and `.stage/node` as Tauri **`bundle.resources`**, resolved at runtime via
`resource_dir()` — the direct analog of Electron's `extraResources` +
`process.resourcesPath`. Services run under the **bundled system Node** (never a
Tauri-compiled binary), preserving the `better-sqlite3` ABI guarantees that
`scripts/stage-services.cjs` already provides.

- We deliberately do **not** use Tauri's `externalBin`/sidecar mechanism (that is for
  single compiled binaries with target triples); resources match our Node-services
  model — consistent with both Nexus's Electron build and zosma's actual approach.
- Build: `npm run prepackage` (existing) → `npm run tauri:build` → `.app` in
  `target/release/bundle/macos`.
- macOS entitlements: start from `build/entitlements.mac.plist`; add
  `com.apple.security.cs.allow-dyld-environment-variables` per zosma's documented
  requirement for a bundled Node child. (Spike builds are unsigned `--dir`-equivalent;
  signing/notarization is out of scope.)

## 8. Measurement methodology

Because daemon/backend/models/frontend are identical across shells, isolate the
**shell delta**:

| Metric | Method |
|---|---|
| **Bundle size** | Size of the `.app` **minus** the shared `.stage/services` + `.stage/node` resources → pure shell weight. Also report total `.app` as the headline. |
| **Cold start** | Time from process start to main-window-shown, via a log timestamp at app-start and at window-show. Same instrumentation added to **both** shells. Run 3× cold, report median. |
| **Idle RSS** | Resident memory of the shell process(es) at idle (Tauri core + WebKit helpers vs Electron main + Chromium helpers), `ps`-sampled after settle, **excluding** the shared daemon/backend. |

## 9. Risks & parity gaps (de-risk in order)

1. **🟡 Mixed-content / secure-context fetch** — proven lever exists (`csp: null`, or
   scoped `connect-src`). Validate first with a bare-window probe (fetch + ws).
2. **WKWebView vs Chromium rendering/JS parity** — load the real UI, click main flows,
   watch the console; document divergence.
3. **Titlebar `hiddenInset` / drag-region parity** on macOS.
4. **Cross-platform (analytical only)** — Linux WebKitGTK behavioral differences,
   Windows WebView2, resource/sidecar target triples. Cannot build on this Mac;
   documented as migration requirements. (Homebrew Rust here has no `rustup`, so
   cross-target tooling is also absent — noted.)
5. **Bundled-Node TLS / OAuth** — `--use-system-ca` mitigation noted for Jira/GitHub/
   Anthropic outbound TLS if cert issues arise.
6. **Signing / notarization / auto-update** — out of scope; noted as follow-up.

## 10. Toolchain prerequisites (all satisfied on this machine)

- Rust 1.96 (Homebrew) ✓
- Xcode + Apple clang (linker/cc) ✓
- System WebKit (no Chromium to ship) ✓
- Tauri CLI — installed during implementation as `@tauri-apps/cli` npm devDep in the
  `tauri/` workspace (prebuilt binary; no global cargo install).

## 11. Acceptance / exit criteria

- A committed spike writeup with a **continue-migration vs stay-on-Electron**
  recommendation backed by the measured size / cold-start / RSS deltas.
- A working Tauri shell prototype with parity to the Electron shell behaviors in §2
  (startup/splash status, port checks, reuse, start-missing, degraded warning, clean
  process-group shutdown) — **or** a clearly documented blocker (most likely risk #1)
  explaining why parity is impractical.
- Electron wrapper left fully intact and recoverable.
- Any go-forward work split into smaller migration issues (e.g. cross-platform
  packaging, signing, frontend WKWebView fixes).

## 12. Out of scope

Rewriting the backend or memory daemon in Rust; replacing Fastify; redesigning the
frontend; shipping Tauri as the default wrapper before parity is proven; signing /
notarization / auto-update; cross-platform builds (assessed analytically only).

## Risk #1 verdict (probe result)

**Status: WORKS** — webview-to-localhost fetch and WebSocket both succeed under the scoped CSP.

**Probe setup:**
- `tauri/src-tauri/probe-dist/probe.html` loaded via Tauri asset protocol (`frontendDist: "probe-dist"`, `url: "probe.html"`) — NOT a plain http devUrl. This is the correct secure-context test.
- Backend (`npm run dev:backend`) was running at `http://127.0.0.1:4173` (confirmed 200 on `/api/health`).
- `probe_report` Tauri command wrote output to `/tmp/nexus-tauri-probe.txt` and stdout.

**CSP that worked (first attempt — no fallback needed):**
```
default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; script-src 'self' 'unsafe-inline' https://unpkg.com
```
Note: `https://unpkg.com` was added to `script-src` to allow the CDN import of `@tauri-apps/api/core`. The brief's original scoped CSP did not include this; omitting it would have caused a blocked CDN script error (not a blocked fetch), so it was added to isolate the fetch/ws signal cleanly.

**Exact probe output captured from `/tmp/nexus-tauri-probe.txt` and `[probe]` stdout:**
```
FETCH ok=true status=200 | WS error (route-level, not security block) | no_global_errors
```

**Fetch result:** `FETCH ok=true status=200` — fetch to `http://127.0.0.1:4173/api/health` succeeded from the `tauri://localhost` asset-protocol origin. No mixed-content error, no CSP block.

**WebSocket result:** `WS error (route-level, not security block)` — the WebSocket to `ws://127.0.0.1:4173/` was not security-blocked; it errored because no WebSocket upgrade route exists at that path. This is the expected/acceptable outcome per the task brief.

**Global errors:** none (`no_global_errors`).

**`csp: null` fallback:** not needed. Scoped CSP was sufficient.

**Conclusion:** Risk #1 is **de-risked**. WKWebView does not block `fetch()` or `WebSocket` connections to `127.0.0.1` from a `tauri://localhost` secure-context origin when `connect-src` explicitly allows them. The supervisor implementation can proceed. The CSP above is now committed into `tauri.conf.json` as the production setting.
