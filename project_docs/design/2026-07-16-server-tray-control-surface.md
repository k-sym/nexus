# Server tray control surface

Issue: [#169](https://github.com/k-sym/nexus/issues/169)

## Goal

Give a headless Nexus server operator an at-a-glance macOS menu-bar status and safe Start, Stop, and Restart controls without opening the main Nexus window.

This surface is enabled when the resolved `server.url` is local (empty in configuration, with no remote `NEXUS_BACKEND_URL` override). Thin clients retain the current splash-to-main-window flow.

## Product decisions

### First release: launchd owns the backend

The first release is a status and launchd-control surface. It must not make the Tauri process a second persistence mechanism.

- `com.k-sym.nexus-backend` remains the authoritative backend owner.
- Start and Restart act through `launchctl` for that exact label.
- Stop disables the job before stopping it; merely terminating a `KeepAlive` process would cause launchd to start it again.
- The existing Rust supervisor may probe services, but server tray mode must not call its current `boot()` function because that function can spawn local services and stores them as Tauri-owned children.
- Memory and model services are health/status rows in the first release. They are not individually controlled unless their launchd ownership and labels are made explicit in a later issue.

This avoids ambiguous ownership: a reused process is never killed through the supervisor, and a launchd-owned process is never mistaken for a Tauri child.

### Tray mode selection

Add a small, tested configuration resolver that distinguishes:

- `Client`: resolved backend URL is non-loopback; preserve current application behavior.
- `Server`: `server.url` is empty or resolves to loopback; create a tray icon without a splash or main window.

For development, support `NEXUS_APP_MODE=client|server` as an explicit override so both flows can be exercised without rewriting the user's configuration. Invalid values should be logged and ignored.

### Main-window access

The tray menu includes **Open Nexus**. It lazily creates or focuses the existing main webview and injects the same API base and token as the current startup flow. Closing that window hides/destroys only the UI; it must not exit the tray process or stop services.

## Menu design

The menu is deliberately native and compact:

```text
Nexus Server          ● Running
Backend               Healthy · :4173
Memory                Healthy · :4100
Generation            Healthy · :4001
Embedding             Healthy · :4002
Reranking             Healthy · :4003
Local chat             Healthy · :8081
─────────────────────────────────
Open Nexus
Start Server
Stop Server…
Restart Server
Refresh Status
─────────────────────────────────
Quit Nexus Control
```

Status wording:

- **Healthy**: the endpoint returned a successful response within the timeout.
- **Unavailable**: the endpoint failed or timed out.
- **Starting** / **Stopping** / **Restarting**: a control action is in progress.
- **Unknown**: the status has not yet been sampled.

The menu-bar icon communicates aggregate state:

- normal template icon: backend healthy;
- warning variant: backend healthy but one or more optional services unavailable;
- unavailable variant: backend unhealthy;
- subtle activity variant while an action is running.

The backend determines aggregate availability. Model failures are degraded, not server-down.

## Health model

Create a side-effect-free `status` module rather than overloading `supervisor::boot()`.

```rust
struct ServerStatus {
    sampled_at: SystemTime,
    backend: HealthState,
    memory: HealthState,
    generation: HealthState,
    embedding: HealthState,
    reranking: HealthState,
    local_chat: HealthState,
    launchd: LaunchdState,
}
```

Use bounded concurrent probes so one slow service does not serially delay the menu. The backend and memory daemon use their existing health endpoints. Model endpoints must be confirmed from the model-stack configuration before implementation; do not assume that every port exposes the same path. Where the memory daemon health payload already reports generation, embedding, and reranking, prefer that single authoritative response. Local chat is probed separately on `:8081`.

Sampling policy:

- sample immediately when the tray is created;
- refresh every 10 seconds while idle;
- refresh immediately after the menu opens and after every control action;
- use a 1.5 second per-request timeout;
- perform all probes and `launchctl` calls off the Tauri UI thread;
- discard an older sample if a newer refresh has already completed.

No bearer token, process environment, or command output containing secrets may be shown in the menu.

## launchd control contract

Wrap command execution behind a `ServerController` trait so command construction and state transitions can be unit-tested without manipulating the developer's login session.

Target domain and label:

```text
gui/<uid>/com.k-sym.nexus-backend
```

Actions:

- **Start**: enable the service, bootstrap its installed plist if it is not loaded, then kickstart it.
- **Restart**: enable if needed, then `kickstart -k` the loaded service; bootstrap first if absent.
- **Stop**: show a confirmation explaining that the server will remain off, disable the service, then boot it out. Treat “not loaded” as success.

The installed plist path must be discovered from the installation contract rather than hard-coded from the repository checkout. If no plist is installed, Start/Restart returns an actionable error telling the operator how to install the server agent.

Only fixed arguments are passed to `launchctl`; no shell command string is constructed. Capture exit status and bounded stderr for diagnostics.

## Update and rebuild behavior

Restart does not pull source or rebuild artifacts. The menu must make this explicit: **Restart Server** restarts the currently installed build.

An **Update Server…** action is intentionally deferred. Updating requires a separately specified, transactional helper that can pull or install an artifact, build into a temporary location, validate it, switch the active build, and roll back on failure. Combining that workflow with Restart would make a routine recovery action unexpectedly destructive.

## Tauri lifecycle changes

Refactor `tauri/src-tauri/src/lib.rs` into shared setup plus two entry flows:

1. Resolve app mode before creating any window.
2. In client mode, run the existing splash, supervisor boot, and main-window flow.
3. In server mode, create the tray, start the status sampler, and create no window.
4. Extract main-window construction into a reusable function for **Open Nexus**.
5. Keep the app alive after the optional main window closes.
6. On quit, stop only children explicitly owned by this Tauri instance. In the first release, server tray mode owns none.

Add Tauri's tray/menu support to the crate features as required by the version currently locked in the project. Use a macOS template image so the icon follows light/dark menu-bar appearance.

## Control-state behavior

Only one control action may run at a time. While one is running, Start/Stop/Restart are disabled. Each action has a bounded timeout and ends with a fresh status sample.

- Success is reflected by the updated status; no success dialog is needed.
- Failure shows a concise native error dialog with the action, service label, and safe diagnostic text.
- If launchd reports success but health remains unavailable, show `Started · health check pending` for up to 30 seconds before reporting a failure.
- **Stop Server…** always requires confirmation because it deliberately defeats `KeepAlive` until Start is chosen.

## Accessibility and interaction

- Do not rely on icon colour alone; every state has text.
- Keep stable menu item ordering so status changes do not move controls.
- Use verbs and service names in control labels.
- Make unavailable controls disabled, not hidden.
- Ensure the menu remains usable with VoiceOver and keyboard navigation through native Tauri menu items.

## Implementation sequence

1. Extract and test app-mode resolution, including environment override precedence.
2. Add side-effect-free status types and concurrent probes.
3. Add the mockable launchd controller and unit tests for loaded, unloaded, disabled, failure, and timeout cases.
4. Extract reusable main-window creation.
5. Add server-mode tray creation, status refresh, and aggregate icon state.
6. Wire Start, Stop confirmation, Restart, Refresh, Open Nexus, and Quit.
7. Add packaged template icon assets and verify signed release behavior.
8. Update the server installation guide with the installed plist contract and recovery commands.

## Acceptance criteria

- With an empty/local `server.url`, launching Nexus creates a menu-bar item and no splash or main window.
- With a remote `server.url`, startup behavior is unchanged.
- The tray reports backend, memory, model, and local-chat health without spawning a process.
- Start, Stop, and Restart target only `com.k-sym.nexus-backend` through launchd.
- Stop leaves the backend stopped despite its plist using `KeepAlive`; Start restores normal launchd ownership.
- Repeated clicks cannot overlap control actions.
- A missing/unloaded plist, command failure, probe timeout, and unhealthy post-start state each produce actionable feedback.
- Opening and closing the main Nexus window does not stop the server or exit the tray.
- Quitting the tray does not stop launchd-owned services.
- No thin-client regression occurs and existing supervisor/process-group tests remain green.

## Testing notes for the implementation agent

- Unit-test configuration resolution without reading the real home directory.
- Unit-test controller command plans through a fake command runner; tests must never invoke the real `launchctl` domain.
- Unit-test aggregate status independently from menu rendering.
- Exercise status refresh races with delayed fake probes.
- On a disposable macOS account, verify the full loaded/unloaded/disabled lifecycle with a harmless fixture launch agent before targeting the Nexus label.
- Package the release app and verify the template icon, login launch, native dialogs, and **Open Nexus** behavior outside `cargo tauri dev`.

## Current implementation status

Implemented on `codex/issue-169-server-tray`:

- Added tested app-mode resolution with `NEXUS_APP_MODE=client|server` overrides.
- Added side-effect-free backend, memory/model, and local-chat health sampling.
- Added a bounded, fixed-argument launchd controller for `com.k-sym.nexus-backend`.
- Added the native tray menu, aggregate status, ten-second refresh, guarded actions, Stop confirmation, and lazy **Open Nexus** window.
- Preserved the existing thin-client supervisor flow.

Implementation deviations and follow-ups:

- The repository does not yet contain a `com.k-sym.nexus-backend.plist` or server installation helper. Start and Restart therefore discover the standard `~/Library/LaunchAgents/com.k-sym.nexus-backend.plist` and show an actionable error if it is missing.
- The packaged application icon is currently reused as a macOS template image. A purpose-built monochrome status icon set can replace it without changing the control logic.
- Model status is sourced from the memory daemon's existing health response instead of issuing redundant requests to ports 4001–4003.
- An update/rebuild action remains intentionally out of scope, as specified.
