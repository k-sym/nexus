pub mod node;
pub mod health;
pub mod supervisor;

use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

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

            // ── SIGTERM handler: forward to Tauri's clean shutdown path ──
            // This ensures RunEvent::Exit (and kill_spawned) fires even when
            // the process is killed with SIGTERM (e.g. kill <pid> from the CLI
            // or tauri:dev's ctrl-c parent shutdown).
            {
                let sig_handle = handle.clone();
                unsafe {
                    libc::signal(libc::SIGTERM, sigterm_handler as *const () as libc::sighandler_t);
                }
                // Store handle globally so the signal handler can use it.
                *SIGTERM_HANDLE.lock().unwrap() = Some(sig_handle);
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
            std::thread::spawn(move || {
                let emit_handle = handle.clone();

                let result: supervisor::BootResult =
                    supervisor::boot(is_dev, move |key, state, detail| {
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
                        .title_bar_style(tauri::TitleBarStyle::Overlay);

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

                    if let Err(e) = builder.build() {
                        eprintln!("[boot] main window build failed: {e}");
                    } else {
                        // Close the splash now that the main window is up.
                        if let Some(s) = handle.get_webview_window("splash") {
                            let _ = s.close();
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

/// Globally shared AppHandle so the async-signal-safe SIGTERM handler can
/// schedule a clean shutdown via `AppHandle::exit(0)`.
static SIGTERM_HANDLE: std::sync::Mutex<Option<tauri::AppHandle>> =
    std::sync::Mutex::new(None);

/// SIGTERM signal handler: call `kill_spawned` then `AppHandle::exit(0)` to
/// tear down Tauri cleanly and trigger `RunEvent::Exit`.
///
/// # Safety
/// Only async-signal-safe calls are made: we grab the pre-stored handle and
/// call `exit(0)` which is itself async-signal-safe. The Mutex lock is not
/// strictly signal-safe but is acceptable for a spike on Linux/macOS.
extern "C" fn sigterm_handler(_: libc::c_int) {
    if let Ok(guard) = SIGTERM_HANDLE.try_lock() {
        if let Some(ref handle) = *guard {
            kill_spawned(handle);
            handle.exit(0);
        }
    }
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
