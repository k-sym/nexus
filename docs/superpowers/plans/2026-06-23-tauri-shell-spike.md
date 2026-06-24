# Tauri v2 Shell Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working Tauri v2 desktop shell that reaches parity with Nexus's Electron shell (`electron/main.ts`) wrapping the unchanged React frontend + Node backend + memory daemon, then measure the footprint deltas and write a continue-vs-stay recommendation.

**Architecture:** A sibling `tauri/` npm workspace with a Rust core (`src-tauri/`). The Rust core ports `electron/main.ts` 1:1 as a **health-poll supervisor** (not an RPC bridge): resolve system Node, spawn daemon/backend (+ Vite in dev), poll health, reuse already-running services, show a splash window fed by `emit("boot://status")`, warn on degraded models, group-kill children on exit. Services + a bundled Node ship as Tauri `bundle.resources` (reusing the existing `.stage/` pipeline) and run under system Node — never a compiled binary. The frontend is unchanged; the shell injects `window.__NEXUS_API__` in prod.

**Tech Stack:** Tauri v2, Rust (edition 2021), `tauri-plugin-dialog`, `tauri-plugin-shell`, `reqwest` (blocking or async) for health probes, `serde`/`serde_json`, `@tauri-apps/cli` (npm devDep). Existing: Node 20+, Vite, Fastify backend, memory daemon.

## Global Constraints

Every task implicitly includes these (copied verbatim from the spec):

- **Electron stays fully intact and recoverable.** Do not modify anything under `electron/`, the `electron` workspace entry, or `electron-builder.yml`.
- **Zero frontend code changes.** Do not modify `src/frontend/src/**` (notably `api-base.ts`). Splash adaptation lives in the shell-owned `tauri/splash.html` only.
- **Backend and memory daemon unchanged.** No edits to `src/backend/**` or `src/memory-daemon/**` for the spike.
- **System Node, never fork.** Services run under a resolved **system Node >= 20** (honour `NEXUS_NODE`); never a Tauri-compiled binary. This preserves the `better-sqlite3` ABI.
- **Bundle services as resources, spawn via `std::process::Command`** — NOT Tauri's `externalBin`/sidecar API. Resolve via `resource_dir()` in prod, repo paths in dev.
- **Process-group kill is mandatory.** Spawn each child in its own process group and kill the **group** on exit (backend spawns node-pty grandchildren). `kill_on_drop(true)` is added on top, not instead.
- **Inject `NODE_OPTIONS=--use-system-ca`** into the spawn env (bundled Node OS-cert trust).
- **Reuse already-running services** (probe before spawn); **never kill a reused service**.
- **Readiness gating:** backend + frontend gate the main window; the **daemon is optional** (memory degrades gracefully) and is non-gating.
- **Health/port contract:** daemon `http://127.0.0.1:4100/health`, backend `http://127.0.0.1:4173/api/health`, Vite `http://localhost:5173/`, prod API base `http://127.0.0.1:4173/api`. Model stack `gen`/`embed`/`rerank` read off the daemon `/health`.
- **Tauri CLI** is installed as an `@tauri-apps/cli` npm devDep in the `tauri/` workspace — no global `cargo install`.
- **macOS-only build/measurement.** Linux WebKitGTK / Windows WebView2 / target triples are assessed analytically, not built.
- Work happens on branch `spike/tauri-v2-shell`. Commit after every green step.

> **Tauri v2 API caveat:** exact Tauri v2 builder/window/plugin signatures (e.g. `WebviewWindowBuilder`, `app.path().resource_dir()`, `initialization_script`, `tauri_plugin_dialog`) must be confirmed against the installed `tauri` crate version and the zosma reference (`gh repo clone zosmaai/zosma-cowork`, see `src-tauri/src/lib.rs`). Where a step shows Tauri-integration code, treat it as the intended shape; adjust to compiler feedback. The **pure-logic** tasks (3–6) are exact and must compile/test as written.

---

## File structure

```
tauri/
├── package.json                  # workspace; @tauri-apps/cli + @tauri-apps/api devDeps; tauri:* scripts
├── splash.html                   # adapted from electron/splash.html (Tauri event listen)
└── src-tauri/
    ├── Cargo.toml                # crate + deps
    ├── build.rs                  # tauri_build::build()
    ├── tauri.conf.json          # app/window/bundle config; CSP; resources
    ├── capabilities/default.json # dialog + shell:allow-open permissions
    └── src/
        ├── main.rs              # entry: prevents console window, calls lib::run()
        ├── lib.rs               # app setup, window lifecycle, dialogs, exit cleanup
        ├── node.rs              # resolve_node + version parsing (Task 3)
        ├── health.rs           # probe + wait_for_health + degraded_models (Tasks 4–5)
        └── supervisor.rs        # spawn, process groups, ensure_service, boot (Tasks 6–7)
```

Root `package.json`: add `"tauri/"` to `workspaces` and `tauri:dev` / `tauri:build` scripts. Nothing else outside `tauri/` changes (except Task 11's two-line cold-start log in `electron/main.ts`, explicitly scoped there).

---

## Task 1: Scaffold the `tauri/` workspace and open a blank window

**Files:**
- Create: `tauri/package.json`, `tauri/src-tauri/Cargo.toml`, `tauri/src-tauri/build.rs`, `tauri/src-tauri/tauri.conf.json`, `tauri/src-tauri/capabilities/default.json`, `tauri/src-tauri/src/main.rs`, `tauri/src-tauri/src/lib.rs`
- Modify: `package.json` (root — add workspace + scripts)

**Interfaces:**
- Produces: `lib::run()` (the Tauri app entry, called by `main.rs`); `npm run tauri:dev` / `npm run tauri:build` root scripts.

- [ ] **Step 1: Install the Tauri CLI + API as workspace devDeps**

Create `tauri/package.json`:
```json
{
  "name": "nexus-tauri",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@tauri-apps/api": "^2"
  }
}
```

- [ ] **Step 2: Wire the root workspace + scripts**

In root `package.json`, add `"tauri/"` to the `workspaces` array, and add to `scripts`:
```json
"tauri:dev": "npm run --workspace=tauri dev",
"tauri:build": "npm run prepackage && npm run --workspace=tauri build"
```
Run: `npm install` (installs the new workspace's devDeps).
Expected: `tauri/node_modules/.bin/tauri` exists.

- [ ] **Step 3: Create the Rust crate skeleton**

`tauri/src-tauri/Cargo.toml`:
```toml
[package]
name = "nexus-tauri"
version = "0.1.0"
edition = "2021"

[lib]
name = "nexus_tauri_lib"
crate-type = ["lib", "cdylib", "staticlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["blocking"] }
```

`tauri/src-tauri/build.rs`:
```rust
fn main() {
    tauri_build::build()
}
```

`tauri/src-tauri/src/main.rs`:
```rust
// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nexus_tauri_lib::run()
}
```

`tauri/src-tauri/src/lib.rs`:
```rust
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Minimal config + capabilities**

`tauri/src-tauri/tauri.conf.json` (one declared window for now; later tasks move window creation into Rust):
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Nexus (Tauri)",
  "version": "0.1.0",
  "identifier": "it.resolve.nexus.tauri",
  "build": { "beforeDevCommand": "", "beforeBuildCommand": "", "frontendDist": "../../src/frontend/dist" },
  "app": {
    "windows": [{ "title": "Nexus", "width": 1400, "height": 900, "visible": true }],
    "security": { "csp": null }
  },
  "bundle": { "active": true, "targets": ["app"], "icon": ["icons/icon.icns"] }
}
```
Copy a placeholder icon: `mkdir -p tauri/src-tauri/icons && cp build/icon.icns tauri/src-tauri/icons/icon.icns 2>/dev/null || npx --workspace=tauri tauri icon assets/<any-png>` (use any existing PNG; icon fidelity is irrelevant to the spike).

`tauri/src-tauri/capabilities/default.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Nexus Tauri shell capabilities",
  "windows": ["*"],
  "permissions": [
    "core:default",
    "dialog:default",
    "shell:allow-open"
  ]
}
```

- [ ] **Step 5: Run it — blank window opens**

Run: `npm run tauri:dev`
Expected: Rust compiles; a window titled "Nexus" opens showing the existing built frontend (run `npm run --workspace=src/frontend build` first if `src/frontend/dist` is absent). It will not function yet (no backend running) — we only verify the window opens and Rust↔WebKit works.

- [ ] **Step 6: Commit**

```bash
git add tauri/ package.json package-lock.json
git commit -m "feat(tauri): scaffold sibling tauri v2 workspace + blank window"
```

---

## Task 2: Kill-switch probe — webview → localhost fetch + WebSocket (GATE)

This validates the spec's #1 risk **before** investing in the supervisor. If localhost `fetch`/WebSocket are hard-blocked in WKWebView and neither CSP setting fixes it, STOP and write the blocker (Task 12 short-circuits to a "stay on Electron / blocked" writeup).

**Files:**
- Create: `tauri/src-tauri/probe.html` (temporary; deleted after this task)
- Modify: `tauri/src-tauri/tauri.conf.json` (point window at the probe, then revert)

**Interfaces:**
- Produces: a documented verdict (works / which CSP / blocked) recorded in `docs/superpowers/specs/2026-06-23-tauri-shell-spike-design.md` under a new "Risk #1 verdict" note.

- [ ] **Step 1: Start a real backend to probe against**

Run (separate terminal): `npm run dev:backend`
Wait for: `http://127.0.0.1:4173/api/health` returns 200 (curl to confirm).

- [ ] **Step 2: Write the probe page**

`tauri/src-tauri/probe.html`:
```html
<!doctype html><html><body><pre id="o">probing…</pre><script>
const o = document.getElementById('o');
const log = (m) => o.textContent += "\n" + m;
(async () => {
  try {
    const r = await fetch('http://127.0.0.1:4173/api/health');
    log('FETCH ok=' + r.ok + ' status=' + r.status);
  } catch (e) { log('FETCH FAILED: ' + e); }
  try {
    // Use the backend health as a cheap WS upgrade target; any ws:// to localhost
    // exercises the same secure-context gate. Adjust path to the real terminal ws
    // endpoint if known.
    const ws = new WebSocket('ws://127.0.0.1:4173/');
    ws.onopen = () => log('WS open');
    ws.onerror = (e) => log('WS error (expected if no ws route; the point is it is not a security block)');
  } catch (e) { log('WS THREW: ' + e); }
})();
</script></body></html>
```

- [ ] **Step 3: Point the window at the probe with a SCOPED CSP first**

In `tauri.conf.json`, set `app.windows[0].url` (or `frontendDist` override) to load `probe.html`, and set the scoped CSP:
```json
"security": { "csp": "default-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; script-src 'self' 'unsafe-inline'" }
```

- [ ] **Step 4: Run and read the result**

Run: `npm run tauri:dev`
Expected (success): the window shows `FETCH ok=true status=200`. A `WS error` for a non-existent route is fine — what matters is the absence of a *security/mixed-content* rejection (which surfaces as a thrown SecurityError in the console, visible via the dev webview inspector).
If FETCH FAILED with a security/CSP error: go to Step 5. Otherwise scoped CSP works — record it and skip to Step 6.

- [ ] **Step 5: Fallback to `csp: null` if scoped CSP blocked it**

Set `"security": { "csp": null }`, re-run. If FETCH now succeeds, record that `null` is required. If it STILL fails with a mixed-content/security block, this is the documented blocker — record it, stop the implementation, and jump to Task 12 (blocker writeup).

- [ ] **Step 6: Record the verdict and clean up**

Append a "## Risk #1 verdict (probe result)" section to the design doc stating: works/blocked, which CSP value, and any console errors. Then:
```bash
rm tauri/src-tauri/probe.html
# revert tauri.conf.json window url back to the frontend; keep the CSP value that worked
git add tauri/src-tauri/tauri.conf.json docs/superpowers/specs/2026-06-23-tauri-shell-spike-design.md
git commit -m "spike(tauri): verify webview->localhost fetch/ws (risk #1 gate)"
```

---

## Task 3: Node resolution (`node.rs`) — TDD

**Files:**
- Create: `tauri/src-tauri/src/node.rs`
- Modify: `tauri/src-tauri/src/lib.rs` (add `mod node;`)

**Interfaces:**
- Produces: `pub fn resolve_node() -> Option<String>`; `pub fn parse_major(version: &str) -> Option<u32>`; `pub fn node_candidates() -> Vec<String>`. Consumed by `supervisor.rs` (Task 6) for the spawn binary and by the preflight gate (Task 8).

- [ ] **Step 1: Write the failing tests**

Add to `tauri/src-tauri/src/node.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_major_handles_v_prefix_and_minor() {
        assert_eq!(parse_major("v22.22.3"), Some(22));
        assert_eq!(parse_major("20.0.0"), Some(20));
        assert_eq!(parse_major("v18.19.1"), Some(18));
        assert_eq!(parse_major("not-a-version"), None);
        assert_eq!(parse_major(""), None);
    }

    #[test]
    fn candidates_include_nexus_node_first_when_set() {
        std::env::set_var("NEXUS_NODE", "/custom/node");
        let c = node_candidates();
        assert_eq!(c.first().map(String::as_str), Some("/custom/node"));
        std::env::remove_var("NEXUS_NODE");
    }

    #[test]
    fn candidates_include_path_and_homebrew() {
        std::env::remove_var("NEXUS_NODE");
        let c = node_candidates();
        assert!(c.iter().any(|x| x == "node"));
        assert!(c.iter().any(|x| x == "/opt/homebrew/bin/node"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tauri/src-tauri && cargo test node::`
Expected: compile error / FAIL (`parse_major` not defined).

- [ ] **Step 3: Implement `node.rs`**

Prepend to `tauri/src-tauri/src/node.rs` (mirrors `electron/main.ts:59-107`):
```rust
use std::process::Command;

/// Parse the major version from `node --version` output (e.g. "v22.22.3" -> 22).
pub fn parse_major(version: &str) -> Option<u32> {
    version.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Ordered candidate paths to a usable Node, mirroring the Electron resolver.
pub fn node_candidates() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut fixed: Vec<String> = Vec::new();
    if let Ok(forced) = std::env::var("NEXUS_NODE") {
        if !forced.is_empty() { fixed.push(forced); }
    }
    fixed.push("node".into()); // PATH (dev / inherited env)
    fixed.push("/opt/homebrew/bin/node".into());
    fixed.push("/usr/local/bin/node".into());
    fixed.push("/usr/bin/node".into());
    fixed.push(format!("{home}/.volta/bin/node"));

    // Best-effort nvm/fnm scan (newest first, lexically). The >=20 gate in
    // resolve_node is the real check; ordering only affects which we try first.
    for (base, leaf) in [
        (format!("{home}/.nvm/versions/node"), "bin/node"),
        (format!("{home}/.fnm/node-versions"), "installation/bin/node"),
    ] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut versions: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            versions.sort();
            versions.reverse();
            for v in versions { fixed.push(format!("{base}/{v}/{leaf}")); }
        }
    }
    fixed
}

/// Resolve an absolute path to a usable system Node (>= 20), or None.
pub fn resolve_node() -> Option<String> {
    for cmd in node_candidates() {
        if let Ok(out) = Command::new(&cmd).arg("--version").output() {
            if out.status.success() {
                let v = String::from_utf8_lossy(&out.stdout);
                if let Some(major) = parse_major(v.trim()) {
                    if major >= 20 { return Some(cmd); }
                }
            }
        }
    }
    None
}
```
Add `mod node;` to `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tauri/src-tauri && cargo test node::`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/node.rs tauri/src-tauri/src/lib.rs
git commit -m "feat(tauri): port system-node resolution from electron shell"
```

---

## Task 4: Health probe + poll loop (`health.rs`) — TDD

**Files:**
- Create: `tauri/src-tauri/src/health.rs`
- Modify: `tauri/src-tauri/src/lib.rs` (add `mod health;`)

**Interfaces:**
- Produces: `pub fn probe(url: &str, timeout: Duration) -> bool`; `pub fn wait_for_health<F: FnMut() -> bool>(probe_fn: F, tries: u32, interval: Duration, aborted: &dyn Fn() -> bool) -> bool`. Consumed by `supervisor.rs` (Task 6/7).

- [ ] **Step 1: Write the failing tests**

Add to `tauri/src-tauri/src/health.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use std::cell::Cell;

    #[test]
    fn wait_succeeds_when_probe_goes_up_on_third_try() {
        let n = Cell::new(0u32);
        let ok = wait_for_health(|| { n.set(n.get() + 1); n.get() >= 3 },
            10, Duration::from_millis(1), &|| false);
        assert!(ok);
        assert_eq!(n.get(), 3);
    }

    #[test]
    fn wait_gives_up_after_tries() {
        let ok = wait_for_health(|| false, 5, Duration::from_millis(1), &|| false);
        assert!(!ok);
    }

    #[test]
    fn wait_short_circuits_when_aborted() {
        let n = Cell::new(0u32);
        let ok = wait_for_health(|| { n.set(n.get() + 1); false },
            100, Duration::from_millis(1), &|| n.get() >= 2);
        assert!(!ok);
        assert!(n.get() <= 3); // stopped early, not 100 tries
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tauri/src-tauri && cargo test health::`
Expected: compile error (`wait_for_health` not defined).

- [ ] **Step 3: Implement `health.rs`**

Prepend (mirrors `electron/main.ts:170-198`):
```rust
use std::time::Duration;

/// GET a health URL; true iff it answers 2xx within `timeout`.
pub fn probe(url: &str, timeout: Duration) -> bool {
    match reqwest::blocking::Client::builder().timeout(timeout).build() {
        Ok(c) => c.get(url).send().map(|r| r.status().is_success()).unwrap_or(false),
        Err(_) => false,
    }
}

/// Poll `probe_fn` until it returns true or we exhaust `tries`. `aborted`
/// short-circuits (e.g. the child already died).
pub fn wait_for_health<F: FnMut() -> bool>(
    mut probe_fn: F, tries: u32, interval: Duration, aborted: &dyn Fn() -> bool,
) -> bool {
    for _ in 0..tries {
        if probe_fn() { return true; }
        if aborted() { return false; }
        std::thread::sleep(interval);
    }
    false
}
```
Add `mod health;` to `lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tauri/src-tauri && cargo test health::`
Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/health.rs tauri/src-tauri/src/lib.rs
git commit -m "feat(tauri): health probe + abortable poll loop"
```

---

## Task 5: Model-status parsing / degraded-set (`health.rs`) — TDD

**Files:**
- Modify: `tauri/src-tauri/src/health.rs`

**Interfaces:**
- Produces: `pub fn degraded_models(health_body: &str) -> Vec<String>` — returns the subset of `["gen","embed","rerank"]` that are not `true` in the daemon `/health` body (missing counts as down). Consumed by the boot sequence (Task 7/8).

- [ ] **Step 1: Write the failing tests**

Append to the `tests` mod in `health.rs`:
```rust
    #[test]
    fn degraded_all_up_is_empty() {
        let body = r#"{"models":{"gen":true,"embed":true,"rerank":true}}"#;
        assert!(degraded_models(body).is_empty());
    }

    #[test]
    fn degraded_reports_down_and_missing() {
        let body = r#"{"models":{"gen":true,"embed":false}}"#; // rerank missing
        let d = degraded_models(body);
        assert!(d.contains(&"embed".to_string()));
        assert!(d.contains(&"rerank".to_string()));
        assert!(!d.contains(&"gen".to_string()));
    }

    #[test]
    fn degraded_handles_missing_models_object() {
        let d = degraded_models(r#"{}"#);
        assert_eq!(d.len(), 3);
    }

    #[test]
    fn degraded_handles_garbage_as_all_down() {
        assert_eq!(degraded_models("not json").len(), 3);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tauri/src-tauri && cargo test health::tests::degraded`
Expected: compile error (`degraded_models` not defined).

- [ ] **Step 3: Implement `degraded_models`**

Append to the top region of `health.rs` (mirrors `electron/main.ts:323-341`):
```rust
use serde::Deserialize;

#[derive(Deserialize, Default)]
struct ModelFlags { gen: Option<bool>, embed: Option<bool>, rerank: Option<bool> }
#[derive(Deserialize, Default)]
struct HealthBody { models: Option<ModelFlags> }

/// Subset of gen/embed/rerank that are not `true` (missing == down).
pub fn degraded_models(health_body: &str) -> Vec<String> {
    let m = serde_json::from_str::<HealthBody>(health_body)
        .ok().and_then(|h| h.models).unwrap_or_default();
    let mut down = Vec::new();
    if m.gen != Some(true) { down.push("gen".to_string()); }
    if m.embed != Some(true) { down.push("embed".to_string()); }
    if m.rerank != Some(true) { down.push("rerank".to_string()); }
    down
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tauri/src-tauri && cargo test health::`
Expected: all health tests pass (7 total).

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/health.rs
git commit -m "feat(tauri): parse degraded model stack from daemon health"
```

---

## Task 6: Spawn + process groups + group-kill (`supervisor.rs`) — integration test

**Files:**
- Create: `tauri/src-tauri/src/supervisor.rs`
- Modify: `tauri/src-tauri/src/lib.rs` (add `mod supervisor;`)

**Interfaces:**
- Produces: `pub fn spawn_env(node: &str) -> Vec<(String,String)>` (PATH-enriched + `NODE_OPTIONS=--use-system-ca`); `pub struct Child` wrapping a spawned process group with `pub fn kill_group(&self)`; `pub fn spawn_node(node: &str, entry: &Path, cwd: &Path) -> std::io::Result<Child>`; `pub fn spawn_npm(cwd: &Path, args: &[&str]) -> std::io::Result<Child>`. Consumed by `ensure_service` (Task 7).

- [ ] **Step 1: Write the failing integration test (process-group kill reaps grandchildren)**

Create `tauri/src-tauri/tests/process_group.rs`:
```rust
// Verifies a spawned child started in its own process group can be group-killed
// along with a grandchild it spawned — the property node-pty terminals rely on.
use nexus_tauri_lib::supervisor::{spawn_node, Child};
use std::io::Write;
use std::path::Path;
use std::time::Duration;

#[test]
fn group_kill_reaps_grandchild() {
    // Parent node script spawns a long-lived child node, writes both PIDs to a file.
    let dir = std::env::temp_dir().join("nexus_pg_test");
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("parent.js");
    let pidfile = dir.join("pids.txt");
    let _ = std::fs::remove_file(&pidfile);
    let mut f = std::fs::File::create(&script).unwrap();
    write!(f, r#"
const {{ spawn }} = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{{}},1e9)'], {{ stdio: 'ignore' }});
fs.writeFileSync({:?}, process.pid + "\n" + child.pid + "\n");
setInterval(()=>{{}}, 1e9);
"#, pidfile.to_str().unwrap()).unwrap();

    let node = nexus_tauri_lib::node::resolve_node().expect("node >= 20 required for this test");
    let child: Child = spawn_node(&node, &script, &dir).unwrap();
    // Wait for pidfile.
    let mut tries = 0;
    while !pidfile.exists() && tries < 50 { std::thread::sleep(Duration::from_millis(100)); tries += 1; }
    let pids = std::fs::read_to_string(&pidfile).unwrap();
    let grandchild: i32 = pids.lines().nth(1).unwrap().trim().parse().unwrap();

    child.kill_group();
    std::thread::sleep(Duration::from_millis(500));
    // kill -0 returns Err once the grandchild is gone.
    let alive = unsafe { libc::kill(grandchild, 0) } == 0;
    assert!(!alive, "grandchild {grandchild} should be dead after group kill");
}
```
Add `libc = "0.2"` to `[dev-dependencies]` in `Cargo.toml`, and make `pub mod supervisor;` / `pub mod node;` in `lib.rs` so the integration test can reach them.

- [ ] **Step 2: Run to verify it fails**

Run: `cd tauri/src-tauri && cargo test --test process_group`
Expected: compile error (`spawn_node`/`Child` not defined).

- [ ] **Step 3: Implement `supervisor.rs` spawn + group kill**

Create `tauri/src-tauri/src/supervisor.rs` (mirrors `electron/main.ts:115-233,480-494`):
```rust
use std::path::Path;
use std::process::{Command, Stdio};
use crate::node::resolve_node;

/// Env for spawned services: inherit, enrich PATH, force OS-cert trust.
pub fn spawn_env(node: &str) -> Vec<(String, String)> {
    let node_dir = Path::new(node).parent().map(|p| p.to_string_lossy().into_owned());
    let mut extra = Vec::new();
    if let Some(d) = node_dir { extra.push(d); }
    extra.extend(["/opt/homebrew/bin","/usr/local/bin","/usr/bin","/bin"].map(String::from));
    let current = std::env::var("PATH").unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    let mut parts: Vec<String> = Vec::new();
    for p in current.split(':').map(String::from).chain(extra) {
        if !p.is_empty() && seen.insert(p.clone()) { parts.push(p); }
    }
    let existing_opts = std::env::var("NODE_OPTIONS").unwrap_or_default();
    let node_options = if existing_opts.contains("--use-system-ca") { existing_opts }
        else if existing_opts.is_empty() { "--use-system-ca".into() }
        else { format!("{existing_opts} --use-system-ca") };
    vec![("PATH".into(), parts.join(":")), ("NODE_OPTIONS".into(), node_options)]
}

/// A spawned service leading its own process group.
pub struct Child {
    inner: std::process::Child,
    pgid: i32,
}

impl Child {
    pub fn id(&self) -> u32 { self.inner.id() }

    /// True if the process has already exited (used for fail-fast).
    pub fn has_exited(&mut self) -> bool {
        matches!(self.inner.try_wait(), Ok(Some(_)))
    }

    /// SIGTERM the whole process group, so grandchildren (node-pty) die too.
    pub fn kill_group(&self) {
        unsafe { libc::kill(-self.pgid, libc::SIGTERM); }
    }
}

impl Drop for Child {
    fn drop(&mut self) { self.kill_group(); } // kill_on_drop analog
}

fn configure(cmd: &mut Command, node: &str) {
    for (k, v) in spawn_env(node) { cmd.env(k, v); }
    cmd.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    // New process group so we can group-kill (Unix).
    use std::os::unix::process::CommandExt;
    unsafe { cmd.pre_exec(|| { libc::setsid(); Ok(()) }); }
}

fn spawn(mut cmd: Command, node: &str) -> std::io::Result<Child> {
    configure(&mut cmd, node);
    let inner = cmd.spawn()?;
    let pgid = inner.id() as i32; // setsid makes pid == pgid
    Ok(Child { inner, pgid })
}

/// Spawn a compiled Node entry under system node (prod).
pub fn spawn_node(node: &str, entry: &Path, cwd: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(node);
    cmd.arg(entry).current_dir(cwd);
    spawn(cmd, node)
}

/// Spawn an npm script in a workspace (dev).
pub fn spawn_npm(cwd: &Path, args: &[&str]) -> std::io::Result<Child> {
    let node = resolve_node().unwrap_or_else(|| "node".into());
    let mut cmd = Command::new("npm");
    cmd.args(args).current_dir(cwd);
    spawn(cmd, &node)
}
```
Add `libc = "0.2"` to `[dependencies]` too (used by `kill_group`). Add `pub mod supervisor;` to `lib.rs`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd tauri/src-tauri && cargo test --test process_group`
Expected: PASS (grandchild reaped). Also run `cargo test` — all unit tests still green.

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/supervisor.rs tauri/src-tauri/src/lib.rs tauri/src-tauri/Cargo.toml tauri/src-tauri/tests/process_group.rs
git commit -m "feat(tauri): spawn services in process groups with group-kill"
```

---

## Task 7: `ensure_service` reuse-or-spawn + boot sequence (`supervisor.rs`)

**Files:**
- Modify: `tauri/src-tauri/src/supervisor.rs`

**Interfaces:**
- Consumes: `health::probe`, `health::wait_for_health`, `node::resolve_node`, `spawn_node`/`spawn_npm`/`Child` (Tasks 3–6).
- Produces: `pub enum ServiceState { Reused, Up, Failed(String) }`; `pub fn ensure_service(key, health_url, spawn_fn) -> (ServiceState, Option<Child>)` (reused services return `None` child so they're never killed); `pub struct BootResult { pub ready: bool, pub degraded: Vec<String>, pub node_missing: bool, pub children: Vec<Child> }`; `pub fn boot<E: Fn(&str, &str, Option<&str>)>(is_dev: bool, emit: E) -> BootResult` (calls `emit(key, state, detail)` per status change to drive the splash). Consumed by `lib.rs` (Task 8).

- [ ] **Step 1: Write the failing test (reuse path returns no killable child)**

Add to `supervisor.rs` tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // A reused (already-healthy) service must NOT hand back a Child to kill.
    #[test]
    fn ensure_service_reuse_returns_no_child() {
        // Spin a throwaway HTTP 200 server in a thread.
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for s in listener.incoming() {
                if let Ok(mut s) = s {
                    let mut b = [0u8; 512]; let _ = s.read(&mut b);
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
                }
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        let url = format!("http://127.0.0.1:{port}/health");
        let (state, child) = ensure_service("test", &url, &|| panic!("should not spawn"));
        assert!(matches!(state, ServiceState::Reused));
        assert!(child.is_none());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd tauri/src-tauri && cargo test supervisor::tests::ensure_service`
Expected: compile error (`ensure_service`/`ServiceState` not defined).

- [ ] **Step 3: Implement `ensure_service` + `boot`**

Append to `supervisor.rs` (mirrors `electron/main.ts:278-320,427-478`):
```rust
use crate::health::{probe, wait_for_health, degraded_models};
use std::time::Duration;

const DAEMON_HEALTH: &str = "http://127.0.0.1:4100/health";
const BACKEND_HEALTH: &str = "http://127.0.0.1:4173/api/health";
const FRONTEND_URL: &str = "http://localhost:5173/";

pub enum ServiceState { Reused, Up, Failed(String) }

/// Probe first (reuse anything already running, untracked), else spawn + wait.
pub fn ensure_service(
    _key: &str, health_url: &str, spawn_fn: &dyn Fn() -> std::io::Result<Child>,
) -> (ServiceState, Option<Child>) {
    if probe(health_url, Duration::from_millis(1500)) {
        return (ServiceState::Reused, None); // never killed
    }
    let mut child = match spawn_fn() {
        Ok(c) => c,
        Err(e) => return (ServiceState::Failed(e.to_string()), None),
    };
    let ok = wait_for_health(
        || probe(health_url, Duration::from_millis(1500)),
        75, Duration::from_millis(400),
        &|| false, // fail-fast via has_exited checked below between polls is omitted for brevity;
    );
    // Fail-fast: if it died, surface that.
    if !ok && child.has_exited() {
        return (ServiceState::Failed("exited early".into()), Some(child));
    }
    if ok { (ServiceState::Up, Some(child)) }
    else { (ServiceState::Failed("timeout".into()), Some(child)) }
}

pub struct BootResult {
    pub ready: bool,
    pub degraded: Vec<String>,
    pub node_missing: bool,
    pub children: Vec<Child>,
}

/// Full boot: daemon (optional) -> models -> backend -> (dev) vite. Calls
/// `emit(key, state, detail)` after each transition to feed the splash.
pub fn boot<E: Fn(&str, &str, Option<&str>)>(is_dev: bool, emit: E) -> BootResult {
    use crate::node::resolve_node;
    let repo_root = repo_root();
    let mut children = Vec::new();

    // Preflight: prod needs a system node before we spawn compiled services.
    let node_missing = !is_dev && resolve_node().is_none();
    if node_missing {
        return BootResult { ready: false, degraded: vec![], node_missing: true, children };
    }
    let node = resolve_node().unwrap_or_else(|| "node".into());

    // Daemon (optional, non-gating).
    emit("memory", "starting", Some("checking…"));
    let daemon_dir = repo_root.join("src/memory-daemon");
    let (mstate, mchild) = ensure_service("memory", DAEMON_HEALTH, &|| {
        if is_dev { spawn_npm(&daemon_dir, &["start"]) }
        else { spawn_node(&node, &daemon_dir.join("dist/src/index.js"), &daemon_dir) }
    });
    let mem_ok = !matches!(mstate, ServiceState::Failed(_));
    emit("memory", state_label(&mstate), state_detail(&mstate));
    if let Some(c) = mchild { children.push(c); }

    // Models off the daemon health blob (warn-only).
    let degraded = if mem_ok {
        emit("models", "starting", Some("probing…"));
        match reqwest::blocking::get(DAEMON_HEALTH).and_then(|r| r.text()) {
            Ok(body) => { let d = degraded_models(&body);
                emit("models", if d.is_empty() {"up"} else {"warn"}, None); d }
            Err(_) => { emit("models", "warn", Some("unknown")); vec!["gen".into(),"embed".into(),"rerank".into()] }
        }
    } else { emit("models", "warn", Some("daemon down")); vec!["gen".into(),"embed".into(),"rerank".into()] };

    // Backend (gating).
    emit("backend", "starting", Some("checking…"));
    let backend_dir = repo_root.join("src/backend");
    let (bstate, bchild) = ensure_service("backend", BACKEND_HEALTH, &|| {
        if is_dev { spawn_npm(&backend_dir, &["run","dev"]) }
        else { spawn_node(&node, &backend_dir.join("dist/index.js"), &backend_dir) }
    });
    let backend_ok = !matches!(bstate, ServiceState::Failed(_));
    emit("backend", state_label(&bstate), state_detail(&bstate));
    if let Some(c) = bchild { children.push(c); }

    // Vite (dev only; gating in dev).
    let frontend_ok = if is_dev {
        emit("frontend", "starting", Some("checking…"));
        let fe = repo_root.join("src/frontend");
        let (fstate, fchild) = ensure_service("frontend", FRONTEND_URL, &|| spawn_npm(&fe, &["run","dev"]));
        let ok = !matches!(fstate, ServiceState::Failed(_));
        emit("frontend", state_label(&fstate), state_detail(&fstate));
        if let Some(c) = fchild { children.push(c); }
        ok
    } else { emit("frontend", "skipped", Some("bundled")); true };

    BootResult { ready: backend_ok && frontend_ok, degraded, node_missing: false, children }
}

fn state_label(s: &ServiceState) -> &'static str {
    match s { ServiceState::Reused => "reused", ServiceState::Up => "up", ServiceState::Failed(_) => "failed" }
}
fn state_detail(s: &ServiceState) -> Option<&str> {
    if let ServiceState::Failed(m) = s { Some(m.as_str()) } else { None }
}

/// Repo root in dev (CARGO_MANIFEST_DIR = tauri/src-tauri -> ../../). Prod
/// override happens in lib.rs via resource_dir (Task 10).
fn repo_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}
```
> Note: the inline fail-fast comment marks a simplification — if you want the full Electron fail-fast (abort the poll the instant the child dies), thread `child.has_exited()` into the `aborted` closure by wrapping the child in a `RefCell`. The post-loop `has_exited()` check already classifies a dead child as `Failed`, which is sufficient for the spike.

- [ ] **Step 4: Run to verify it passes**

Run: `cd tauri/src-tauri && cargo test supervisor::`
Expected: reuse test passes. `cargo build` clean.

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/supervisor.rs
git commit -m "feat(tauri): reuse-or-spawn ensure_service + boot sequence"
```

---

## Task 8: Window lifecycle, splash, dialogs, exit cleanup (`lib.rs`)

**Files:**
- Modify: `tauri/src-tauri/src/lib.rs`
- Create: `tauri/splash.html`
- Modify: `tauri/src-tauri/tauri.conf.json` (remove the static window; windows are created in code)

**Interfaces:**
- Consumes: `supervisor::boot`, `BootResult`, `node::resolve_node`.
- Produces: the wired `run()` — splash → boot (emitting `boot://status`) → preflight/degraded dialogs → main window (`window.__NEXUS_API__` injected in prod) → group-kill on exit.

- [ ] **Step 1: Adapt the splash page (Tauri events; no frontend coupling)**

Create `tauri/splash.html` by copying `electron/splash.html` and replacing the status subscription. Where Electron used `window.nexusBoot.onStatus(cb)`, use:
```html
<script type="module">
  import { listen } from 'https://cdn.jsdelivr.net/npm/@tauri-apps/api@2/event/index.js';
  // (or bundle @tauri-apps/api; CDN acceptable for the shell-owned splash in a spike)
  listen('boot://status', (e) => renderStatus(e.payload));
  // renderStatus = the existing splash render fn copied from electron/splash.html
</script>
```
Keep the existing CSS/markup verbatim so the splash looks identical.

- [ ] **Step 2: Wire `run()` — splash, boot thread, dialogs, main window, cleanup**

Replace `lib.rs` `run()` with the wired version (confirm Tauri v2 signatures against the installed crate + zosma `src-tauri/src/lib.rs`):
```rust
use tauri::{Manager, WebviewWindowBuilder, WebviewUrl, Emitter};
use std::sync::Mutex;

mod node; mod health; mod supervisor;
use supervisor::{boot, BootResult, Child};

struct Spawned(Mutex<Vec<Child>>);

pub fn run() {
    let is_dev = cfg!(debug_assertions);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Spawned(Mutex::new(Vec::new())))
        .setup(move |app| {
            let handle = app.handle().clone();

            // 1) Splash window.
            let splash = WebviewWindowBuilder::new(&handle, "splash",
                WebviewUrl::App("../splash.html".into()))
                .title("Nexus — starting").inner_size(480.0, 380.0)
                .decorations(false).resizable(false).build()?;

            // 2) Boot on a worker thread so the UI thread stays responsive.
            std::thread::spawn(move || {
                let emit_handle = handle.clone();
                let result: BootResult = boot(is_dev, move |key, state, detail| {
                    let _ = emit_handle.emit("boot://status",
                        serde_json::json!({ "key": key, "state": state, "detail": detail }));
                });

                // 3) Preflight failure (prod, no node).
                if result.node_missing {
                    // tauri_plugin_dialog blocking message; then exit.
                    // (confirm dialog API: tauri_plugin_dialog::MessageDialogBuilder)
                    handle.exit(1);
                    return;
                }
                // 4) Degraded models warning (non-blocking-ish; show then continue).
                if !result.degraded.is_empty() {
                    // MessageDialogBuilder warning: "Local model stack not fully up: <degraded>"
                }

                // Stash spawned children for exit cleanup.
                *handle.state::<Spawned>().0.lock().unwrap() = result.children;

                // 5) Main window (or failure on splash).
                if result.ready {
                    let mut b = WebviewWindowBuilder::new(&handle, "main",
                        if is_dev { WebviewUrl::External("http://localhost:5173/".parse().unwrap()) }
                        else { WebviewUrl::App("index.html".into()) })
                        .title("Nexus").inner_size(1400.0, 900.0).min_inner_size(900.0, 600.0)
                        .title_bar_style(tauri::TitleBarStyle::Overlay); // macOS hiddenInset analog
                    if !is_dev {
                        b = b.initialization_script(
                            "window.__NEXUS_API__='http://127.0.0.1:4173/api';");
                    }
                    let _ = b.build();
                    if let Some(s) = handle.get_webview_window("splash") { let _ = s.close(); }
                } else {
                    let _ = handle.emit("boot://status",
                        serde_json::json!({ "message": "Startup failed — a required service did not come up." }));
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // This app owns its services: tear them down with the window.
                if let Some(state) = window.app_handle().try_state::<Spawned>() {
                    for c in state.0.lock().unwrap().iter() { c.kill_group(); }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```
> External-link handling: register `on_navigation` (or the webview's new-window handler) to open `http(s)` via `tauri_plugin_shell`'s opener, mirroring Electron's `setWindowOpenHandler`. Confirm the exact v2 hook name against the crate.

- [ ] **Step 3: Build**

Run: `cd tauri/src-tauri && cargo build`
Expected: clean compile (fix any API-signature drift against the installed Tauri v2 crate).

- [ ] **Step 4: Manual verification — dev parity**

Pre: ensure no backend/daemon/vite already running (so spawn path is exercised), or leave one running to exercise reuse.
Run: `npm run tauri:dev`
Expected, observe in order:
1. Splash window appears with the Nexus brand + service rows.
2. Rows transition (memory → models → backend → frontend) via `boot://status`.
3. If a service was already running, its row reads **reused**.
4. If the model stack is partial, a warning dialog appears; clicking Continue proceeds.
5. Main window opens to the working Nexus UI (data loads → backend reachable from the webview, confirming Task 2's CSP). Splash closes.
6. Close the window → `ps aux | grep -E 'memory-daemon|backend|vite'` shows the children Nexus spawned are gone (reused ones, if any, remain).

- [ ] **Step 5: Commit**

```bash
git add tauri/src-tauri/src/lib.rs tauri/splash.html tauri/src-tauri/tauri.conf.json
git commit -m "feat(tauri): splash->boot->main window lifecycle with exit cleanup"
```

---

## Task 9: Production packaging — bundle services + Node as resources

**Files:**
- Modify: `tauri/src-tauri/tauri.conf.json` (bundle resources, beforeBuildCommand), `tauri/src-tauri/src/supervisor.rs` (prod resource-dir root), `tauri/src-tauri/src/lib.rs` (pass resource dir into boot)
- Create: `tauri/src-tauri/entitlements.plist`

**Interfaces:**
- Consumes: existing `.stage/services` + `.stage/node` (produced by `npm run prepackage`).
- Produces: a packaged `.app` whose Rust resolves services/Node from `resource_dir()`.

- [ ] **Step 1: Stage services + node (existing pipeline)**

Run: `npm run prepackage`
Expected: `.stage/services/{backend,daemon,frontend}` and `.stage/node/` exist.

- [ ] **Step 2: Declare resources + entitlements in `tauri.conf.json`**

Set `bundle.resources` to copy the staged trees, and macOS entitlements:
```json
"bundle": {
  "active": true,
  "targets": ["app"],
  "resources": { "../../.stage/services": "services", "../../.stage/node": "node" },
  "macOS": { "entitlements": "entitlements.plist" }
}
```
Create `tauri/src-tauri/entitlements.plist` from `build/entitlements.mac.plist`, adding:
```xml
<key>com.apple.security.cs.allow-dyld-environment-variables</key><true/>
```
(Per zosma's documented requirement for a bundled Node child.)

- [ ] **Step 3: Resolve prod root from resource dir**

Change `boot()` to accept a `root: PathBuf` instead of computing `repo_root()`, and in `lib.rs` pass:
```rust
let root = if is_dev {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
} else {
    app.path().resource_dir().expect("resource dir") // contains services/ and node/
};
```
In prod, service dirs become `root/services/{backend,daemon,frontend}`, entries `dist/index.js` etc., and the bundled node is `root/node/bin/node`. Update `boot()`/spawn calls accordingly (mirror `electron/main.ts:245-272` `SERVICES`/`backendDir`/`daemonDir`/`bundledNode`). In prod, prefer the bundled node over `resolve_node()`.

- [ ] **Step 4: Build the app**

Run: `npm run tauri:build`
Expected: `.app` produced under `tauri/src-tauri/target/release/bundle/macos/`.

- [ ] **Step 5: Manual verification — prod parity**

Launch the built `.app` (Finder double-click, NOT from a terminal, to verify the GUI-launch PATH story).
Expected: splash → services spawn under bundled node → main window loads bundled assets, data loads (prod API base injected). Close → spawned children reaped.

- [ ] **Step 6: Commit**

```bash
git add tauri/src-tauri/tauri.conf.json tauri/src-tauri/entitlements.plist tauri/src-tauri/src/supervisor.rs tauri/src-tauri/src/lib.rs
git commit -m "feat(tauri): bundle services + node as resources; prod resource-dir resolution"
```

---

## Task 10: Measurement — shell-only size, cold start, idle RSS

**Files:**
- Modify: `electron/main.ts` (add a two-line cold-start log only), `tauri/src-tauri/src/lib.rs` (cold-start log)
- Create: `docs/superpowers/specs/2026-06-23-tauri-shell-measurements.md`

**Interfaces:**
- Produces: a measurements table feeding the Task 11 recommendation.

- [ ] **Step 1: Instrument cold start in both shells**

Electron (`electron/main.ts`): at top of `boot()` record `const t0 = Date.now()`; in `createMainWindow`'s `did-finish-load`, `console.log('[nexus] cold-start ms:', Date.now() - t0)`.
Tauri (`lib.rs`): capture an `Instant` at `setup` start; on main-window creation, `log`/`println!` the elapsed ms.
> This is the only permitted change to `electron/main.ts`; it is additive logging, leaving behavior intact.

- [ ] **Step 2: Measure bundle size (shell-only)**

```bash
# Electron
du -sh dist-app/**/Nexus.app 2>/dev/null
du -sh .stage/services .stage/node            # shared, subtract from both
# Tauri
du -sh tauri/src-tauri/target/release/bundle/macos/*.app
```
Record total `.app` for each AND `.app` minus shared resources = pure shell weight.

- [ ] **Step 3: Measure cold start (3× each, median)**

Cold-launch each packaged app three times (quit fully between runs), read the logged `cold-start ms`. Record median.

- [ ] **Step 4: Measure idle RSS (shell processes only)**

With each app idle on the loaded UI:
```bash
# Identify shell pids (exclude node backend/daemon which are identical across both)
ps -axo pid,rss,comm | grep -Ei 'Nexus|tauri|Electron' | grep -vi node
```
Sum RSS of the shell + its webview helper processes. Record.

- [ ] **Step 5: Write the measurements doc + commit**

Fill `2026-06-23-tauri-shell-measurements.md` with three tables (size, cold start, RSS), each showing Electron vs Tauri and the delta.
```bash
git add docs/superpowers/specs/2026-06-23-tauri-shell-measurements.md electron/main.ts tauri/src-tauri/src/lib.rs
git commit -m "spike(tauri): instrument + record shell footprint measurements"
```

---

## Task 11: Spike writeup — recommendation + follow-up issues

**Files:**
- Create: `docs/superpowers/specs/2026-06-23-tauri-shell-spike-result.md`

**Interfaces:**
- Consumes: Task 2 risk verdict, Task 8/9 parity observations, Task 10 measurements.

- [ ] **Step 1: Write the result doc**

Include: (a) **Recommendation** — continue migration vs stay on Electron, one paragraph, decisive; (b) **Evidence** — the measurement deltas + parity checklist (each §2 Electron behavior: reproduced? gaps?); (c) **Risk #1 verdict** (CSP value that worked, or the blocker); (d) **Cross-platform assessment** (analytical: WebKitGTK, WebView2, target triples, signing/notarization); (e) **Follow-up issues** — a bulleted list ready to file (e.g. "Cross-platform Tauri packaging", "WKWebView frontend parity fixes", "Signing + notarization + auto-update", "Promote Tauri to default wrapper").

- [ ] **Step 2: Verify acceptance criteria are met**

Check each spec §11 criterion against the deliverables. If risk #1 was a blocker, the doc instead documents the blocker + why parity is impractical (still a valid spike outcome).

- [ ] **Step 3: Commit + open PR**

```bash
git add docs/superpowers/specs/2026-06-23-tauri-shell-spike-result.md
git commit -m "spike(tauri): result, recommendation, and follow-up issues (#78)"
git push -u origin spike/tauri-v2-shell
gh pr create --fill --title "Spike: Tauri v2 shell evaluation (#78)" --body "Closes #78 spike. See docs/superpowers/specs/2026-06-23-tauri-shell-spike-result.md for the recommendation and evidence."
```

---

## Self-Review

**1. Spec coverage:**
- §2 Electron behaviors (node resolve, spawn, health-poll, reuse, models, splash, group-kill, external links, titlebar) → Tasks 3,4,5,6,7,8 + verified in Task 8 Step 4 / Task 9 Step 5. ✓
- §3 prior-art adoptions (csp lever → Task 2/1; resources+Command → Task 6/9; kill_on_drop → Task 6 Drop; --use-system-ca → Task 6 spawn_env; allow-dyld entitlement → Task 9) ✓
- §4 layout / sibling workspace → Task 1 ✓
- §5.3 zero frontend change + `__NEXUS_API__` inject → Task 8 (initialization_script), splash via events → Task 8 Step 1 ✓
- §5.4 risk #1 probe → Task 2 (gate) ✓
- §6 dev vs prod flows → Task 7 (is_dev branches) + Task 8/9 ✓
- §7 packaging via `.stage` resources → Task 9 ✓
- §8 measurement methodology (shell-only) → Task 10 ✓
- §9 risks → Task 2 (#1), Task 8/9 manual (#2,#3), Task 11 (#4 analytical, #6 follow-up), Task 6 (#5 --use-system-ca) ✓
- §11 acceptance → Task 11 ✓

**2. Placeholder scan:** Pure-logic tasks (3–6) contain complete, compiling code + tests. Tauri-integration tasks (8,9) carry an explicit "confirm against installed crate" caveat rather than hidden TODOs — this is deliberate and flagged in the header, not a placeholder gap. No "TBD/handle edge cases/similar to Task N" present.

**3. Type consistency:** `Child`/`kill_group`/`has_exited`/`spawn_node`/`spawn_npm` (Task 6) are used consistently in `ensure_service`/`boot` (Task 7) and `lib.rs` (Task 8). `ServiceState`/`BootResult` field names (`ready`,`degraded`,`node_missing`,`children`) match across Tasks 7–8. `degraded_models`/`probe`/`wait_for_health` signatures (Tasks 4–5) match their call sites (Task 7). `boot(is_dev, emit)` signature matches Task 8's call; Task 9 changes it to `boot(root, is_dev, emit)` and that change is explicitly described in Task 9 Step 3. ✓
