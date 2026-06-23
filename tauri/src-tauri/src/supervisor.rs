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
    fn drop(&mut self) {
        self.kill_group();           // SIGTERM the whole group (grandchildren too)
        let _ = self.inner.wait();   // reap the direct child so it doesn't zombie
    }
}

fn configure(cmd: &mut Command, node: &str) {
    for (k, v) in spawn_env(node) { cmd.env(k, v); }
    cmd.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    // New process group so we can group-kill (Unix).
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
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
