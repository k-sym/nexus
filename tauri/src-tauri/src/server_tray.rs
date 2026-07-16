use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::server_control::{Action, HealthState, LaunchdController, ServerStatus};

const OPEN: &str = "open";
const START: &str = "start";
const STOP: &str = "stop";
const RESTART: &str = "restart";
const REFRESH: &str = "refresh";
const QUIT: &str = "quit";

#[derive(Clone)]
struct StatusItems {
    summary: MenuItem<tauri::Wry>,
    backend: MenuItem<tauri::Wry>,
    memory: MenuItem<tauri::Wry>,
    generation: MenuItem<tauri::Wry>,
    embedding: MenuItem<tauri::Wry>,
    reranking: MenuItem<tauri::Wry>,
    local_chat: MenuItem<tauri::Wry>,
}

fn status_item(app: &tauri::App, id: &str, text: &str) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItemBuilder::with_id(id, text).enabled(false).build(app)
}

fn update(items: &StatusItems, status: &ServerStatus) {
    let degraded = status.backend == HealthState::Healthy
        && [
            status.memory,
            status.generation,
            status.embedding,
            status.reranking,
            status.local_chat,
        ]
        .contains(&HealthState::Unavailable);
    let summary = match status.backend {
        HealthState::Unavailable => "Nexus Server — Unavailable",
        HealthState::Healthy if degraded => "Nexus Server — Running (degraded)",
        HealthState::Healthy => "Nexus Server — Running",
    };
    let _ = items.summary.set_text(summary);
    let _ = items
        .backend
        .set_text(format!("Backend — {} · :4173", status.backend.label()));
    let _ = items
        .memory
        .set_text(format!("Memory — {} · :4100", status.memory.label()));
    let _ = items.generation.set_text(format!(
        "Generation — {} · :4001",
        status.generation.label()
    ));
    let _ = items
        .embedding
        .set_text(format!("Embedding — {} · :4002", status.embedding.label()));
    let _ = items
        .reranking
        .set_text(format!("Reranking — {} · :4003", status.reranking.label()));
    let _ = items.local_chat.set_text(format!(
        "Local chat — {} · :8081",
        status.local_chat.label()
    ));
}

fn refresh(handle: tauri::AppHandle, items: StatusItems, busy: Arc<AtomicBool>) {
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let status = crate::server_control::sample_status();
        let ui_items = items.clone();
        let _ = handle.run_on_main_thread(move || update(&ui_items, &status));
        busy.store(false, Ordering::SeqCst);
    });
}

fn open_nexus(handle: &tauri::AppHandle, is_dev: bool) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let url = if is_dev {
        WebviewUrl::External("http://localhost:5173/".parse().unwrap())
    } else {
        WebviewUrl::App("index.html".into())
    };
    let api = format!(
        "{}/api",
        crate::supervisor::configured_backend_url().trim_end_matches('/')
    );
    let token = crate::supervisor::configured_backend_token();
    let mut init = format!(
        "window.__NEXUS_API__={};",
        serde_json::to_string(&api).unwrap()
    );
    if !token.is_empty() {
        init.push_str(&format!(
            "window.__NEXUS_TOKEN__={};",
            serde_json::to_string(&token).unwrap()
        ));
    }
    if let Err(error) = WebviewWindowBuilder::new(handle, "main", url)
        .title("Nexus")
        .inner_size(1400.0, 900.0)
        .min_inner_size(900.0, 600.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .disable_drag_drop_handler()
        .initialization_script(&init)
        .build()
    {
        handle
            .dialog()
            .message(format!("Could not open Nexus: {error}"))
            .title("Nexus Server")
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}

fn perform(handle: tauri::AppHandle, action: Action, items: StatusItems, busy: Arc<AtomicBool>) {
    if busy.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let result = LaunchdController::system().and_then(|controller| controller.perform(action));
        if let Err(error) = result {
            let dialog_handle = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                dialog_handle
                    .dialog()
                    .message(error)
                    .title("Nexus Server")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            });
        }
        std::thread::sleep(Duration::from_millis(600));
        let status = crate::server_control::sample_status();
        let ui_items = items.clone();
        let _ = handle.run_on_main_thread(move || update(&ui_items, &status));
        busy.store(false, Ordering::SeqCst);
    });
}

pub fn setup(app: &tauri::App, is_dev: bool) -> tauri::Result<()> {
    let items = StatusItems {
        summary: status_item(app, "summary", "Nexus Server — Checking…")?,
        backend: status_item(app, "backend", "Backend — Checking… · :4173")?,
        memory: status_item(app, "memory", "Memory — Checking… · :4100")?,
        generation: status_item(app, "generation", "Generation — Checking… · :4001")?,
        embedding: status_item(app, "embedding", "Embedding — Checking… · :4002")?,
        reranking: status_item(app, "reranking", "Reranking — Checking… · :4003")?,
        local_chat: status_item(app, "local-chat", "Local chat — Checking… · :8081")?,
    };
    let open = MenuItemBuilder::with_id(OPEN, "Open Nexus").build(app)?;
    let start = MenuItemBuilder::with_id(START, "Start Server").build(app)?;
    let stop = MenuItemBuilder::with_id(STOP, "Stop Server…").build(app)?;
    let restart = MenuItemBuilder::with_id(RESTART, "Restart Server").build(app)?;
    let refresh_item = MenuItemBuilder::with_id(REFRESH, "Refresh Status").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT, "Quit Nexus Control").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&items.summary)
        .item(&items.backend)
        .item(&items.memory)
        .item(&items.generation)
        .item(&items.embedding)
        .item(&items.reranking)
        .item(&items.local_chat)
        .separator()
        .item(&open)
        .item(&start)
        .item(&stop)
        .item(&restart)
        .item(&refresh_item)
        .separator()
        .item(&quit)
        .build()?;

    let busy = Arc::new(AtomicBool::new(false));
    let handler_items = items.clone();
    let handler_busy = busy.clone();
    let mut builder = TrayIconBuilder::with_id("nexus-server")
        .menu(&menu)
        .tooltip("Nexus Server")
        .icon_as_template(true)
        .on_menu_event(move |handle, event| match event.id().as_ref() {
            OPEN => open_nexus(handle, is_dev),
            START => perform(
                handle.clone(),
                Action::Start,
                handler_items.clone(),
                handler_busy.clone(),
            ),
            RESTART => perform(
                handle.clone(),
                Action::Restart,
                handler_items.clone(),
                handler_busy.clone(),
            ),
            STOP => {
                let action_handle = handle.clone();
                let action_items = handler_items.clone();
                let action_busy = handler_busy.clone();
                handle
                    .dialog()
                    .message("Stop the Nexus server and keep it off until Start Server is chosen?")
                    .title("Stop Nexus Server")
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Stop Server".into(),
                        "Cancel".into(),
                    ))
                    .kind(MessageDialogKind::Warning)
                    .show(move |confirmed| {
                        if confirmed {
                            perform(action_handle, Action::Stop, action_items, action_busy)
                        }
                    });
            }
            REFRESH => refresh(handle.clone(), handler_items.clone(), handler_busy.clone()),
            QUIT => handle.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    refresh(app.handle().clone(), items.clone(), busy.clone());
    let periodic_handle = app.handle().clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        refresh(periodic_handle.clone(), items.clone(), busy.clone());
    });
    Ok(())
}
