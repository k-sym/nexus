pub mod node;
pub mod health;
pub mod supervisor;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

/// Set to `true` by the SIGTERM handler; a watcher thread polls this and calls
/// `AppHandle::exit(0)` in normal context so the real teardown runs via `RunEvent::Exit`.
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Managed state: children spawned by `supervisor::boot`.
/// Stored here so the exit handler and `on_window_event` can group-kill on close.
struct Spawned(Mutex<Vec<supervisor::Child>>);

pub fn run() {
    let is_dev = cfg!(debug_assertions);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Spawned(Mutex::new(Vec::new())))
        .setup(move |app| {
            let handle = app.handle().clone();

            // ── SIGTERM handler + watcher thread ─────────────────────────
            // The signal handler only sets an atomic flag (async-signal-safe).
            // A watcher thread polls the flag and calls AppHandle::exit(0) in
            // normal thread context, which triggers RunEvent::Exit → kill_spawned.
            unsafe {
                libc::signal(libc::SIGTERM, sigterm_handler as *const () as libc::sighandler_t);
            }
            {
                let shutdown_handle = handle.clone();
                std::thread::spawn(move || loop {
                    if SHUTDOWN_REQUESTED.load(Ordering::SeqCst) {
                        shutdown_handle.exit(0); // normal context → RunEvent::Exit → kill_spawned
                        break;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                });
            }

            // ── 1) Splash window ──────────────────────────────────────────
            // splash.html lives in tauri/splash.html (source of truth) and is
            // copied to src/frontend/dist/splash.html so it is served by
            // Tauri's secure asset protocol at App("splash.html").
            // This keeps the CSP origin consistent with the main window.
            let _splash = WebviewWindowBuilder::new(
                &handle,
                "splash",
                WebviewUrl::App("splash.html".into()),
            )
            .title("Nexus — starting")
            .inner_size(480.0, 380.0)
            .decorations(false)
            .resizable(false)
            .build()?;

            // ── 2) Boot on a worker thread so the UI stays responsive ─────
            // Resolve the root from which service dirs are found:
            // - dev:  repo root (CARGO_MANIFEST_DIR/../..)
            // - prod: Tauri resource dir (contains services/ and node/)
            let root: std::path::PathBuf = if is_dev {
                // CARGO_MANIFEST_DIR is tauri/src-tauri; ../.. is the repo root.
                // Prefer the canonical path, but fall back to the lexical one (still
                // correct) rather than "." — "." would silently break service resolution.
                let lexical = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
                lexical.canonicalize().unwrap_or(lexical)
            } else {
                app.path().resource_dir().expect("Tauri resource_dir unavailable")
            };

            std::thread::spawn(move || {
                let emit_handle = handle.clone();

                let result: supervisor::BootResult =
                    supervisor::boot(root, is_dev, move |key, state, detail| {
                        eprintln!("[boot] {} {} {:?}", key, state, detail);
                        let _ = emit_handle.emit(
                            "boot://status",
                            serde_json::json!({ "key": key, "state": state, "detail": detail }),
                        );
                    });

                // ── 3) Preflight failure: prod, no node ───────────────────
                if result.node_missing {
                    handle
                        .dialog()
                        .message(
                            "Node.js was not found on this system.\n\
                             Nexus requires Node.js to run its backend services.\n\n\
                             Please install Node.js and restart Nexus.",
                        )
                        .title("Nexus — Missing Dependency")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .blocking_show();
                    handle.exit(1);
                    return;
                }

                // ── 4) Degraded models warning ────────────────────────────
                if !result.degraded.is_empty() {
                    let names = result.degraded.join(", ");
                    handle
                        .dialog()
                        .message(format!(
                            "Some local model services are not responding: {names}\n\n\
                             Nexus will continue without them. AI features may be limited."
                        ))
                        .title("Nexus — Degraded Models")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                        .blocking_show();
                }

                // Stash spawned children for exit cleanup.
                *handle.state::<Spawned>().0.lock().unwrap() = result.children;

                // ── 5) Main window (or keep splash on failure) ────────────
                if result.ready {
                    let url = if is_dev {
                        WebviewUrl::External("http://localhost:5173/".parse().unwrap())
                    } else {
                        WebviewUrl::App("index.html".into())
                    };

                    let mut builder = WebviewWindowBuilder::new(&handle, "main", url)
                        .title("Nexus")
                        .inner_size(1400.0, 900.0)
                        .min_inner_size(900.0, 600.0)
                        // macOS hiddenInset / traffic-light overlay title bar.
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        // Hide the window title text so it doesn't show through
                        // the overlay title bar over the in-app TopBar.
                        .hidden_title(true)
                        // The Kanban board uses native HTML5 drag-and-drop
                        // (draggable + dataTransfer). Tauri's OS-level drag-drop
                        // handler is ON by default and swallows those DOM events,
                        // so disable it to let in-page HTML5 DnD work.
                        .disable_drag_drop_handler();

                    if !is_dev {
                        // Prod only: inject the API base-URL so the bundled
                        // frontend knows which port the backend is on.
                        // In dev, Vite's proxy handles this; do NOT inject.
                        builder = builder.initialization_script(
                            "window.__NEXUS_API__='http://127.0.0.1:4173/api';",
                        );
                    }

                    // Navigation guard: external http(s) links open in the
                    // system browser (mirrors Electron's setWindowOpenHandler).
                    // Returns true = allow navigation, false = block + open externally.
                    builder = builder.on_navigation(move |url| {
                        let scheme = url.scheme();
                        if scheme == "http" || scheme == "https" {
                            let host = url.host_str().unwrap_or("");
                            let is_local = host == "localhost"
                                || host == "127.0.0.1"
                                || host.is_empty();
                            if !is_local {
                                #[cfg(target_os = "macos")]
                                let _ = std::process::Command::new("open")
                                    .arg(url.as_str())
                                    .spawn();
                                #[cfg(target_os = "linux")]
                                let _ = std::process::Command::new("xdg-open")
                                    .arg(url.as_str())
                                    .spawn();
                                return false;
                            }
                        }
                        true
                    });

                    match builder.build() {
                        Err(e) => eprintln!("[boot] main window build failed: {e}"),
                        Ok(main_window) => {
                            // Dev convenience: pop the webview devtools (debug builds
                            // include them; release does not).
                            #[cfg(debug_assertions)]
                            main_window.open_devtools();
                            // Close the splash now that the main window is up.
                            if let Some(s) = handle.get_webview_window("splash") {
                                let _ = s.close();
                            }
                        }
                    }
                } else {
                    let _ = handle.emit(
                        "boot://status",
                        serde_json::json!({
                            "message": "Startup failed — a required service did not come up. \
                                        Check the terminal for details."
                        }),
                    );
                    eprintln!("[boot] FAILED — keeping splash open");
                }
            });

            Ok(())
        })
        // ── Window close: kill spawned children ───────────────────────────
        // Fires when the user clicks the main window's close button.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    kill_spawned(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // ── App exit: final kill sweep ────────────────────────────────────────
    // RunEvent::Exit fires when the Tauri event loop winds down (window close,
    // AppHandle::exit(), or our SIGTERM → AppHandle::exit() path above).
    // This is the authoritative teardown point.
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            eprintln!("[boot] RunEvent::Exit — killing spawned children");
            kill_spawned(handle);
        }
    });
}

/// SIGTERM signal handler: sets `SHUTDOWN_REQUESTED` so the watcher thread
/// (spawned in `setup`) can call `AppHandle::exit(0)` in normal thread context,
/// which triggers `RunEvent::Exit` → `kill_spawned`.
///
/// # Safety
/// This handler performs ONLY an atomic store, which is async-signal-safe.
/// All blocking work (Mutex lock, process-group kill, `waitpid`) is deferred
/// to the watcher thread that polls `SHUTDOWN_REQUESTED` in normal context.
extern "C" fn sigterm_handler(_: libc::c_int) {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

/// Kill every spawned service group. Safe to call multiple times (Vec is cleared).
fn kill_spawned(handle: &tauri::AppHandle) {
    if let Some(state) = handle.try_state::<Spawned>() {
        let mut children = state.0.lock().unwrap();
        eprintln!("[boot] killing {} spawned child(ren)", children.len());
        for c in children.iter() {
            c.kill_group();
        }
        children.clear(); // clear so Drop impls don't double-kill
    }
}
