use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use crate::node::resolve_node;
use crate::health::{probe, wait_for_health, degraded_models};

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

/// Spawn an npm script in a workspace. DEV ONLY — `boot()` calls this exclusively
/// behind `is_dev`. It deliberately uses `resolve_node()` (the developer's system
/// Node) because the bundled Node ships only in packaged builds; in prod, `boot()`
/// uses `spawn_node` with the bundled Node instead. Do not call this on a prod path.
pub fn spawn_npm(cwd: &Path, args: &[&str]) -> std::io::Result<Child> {
    let node = resolve_node().unwrap_or_else(|| "node".into());
    let mut cmd = Command::new("npm");
    cmd.args(args).current_dir(cwd);
    spawn(cmd, &node)
}

const DEFAULT_DAEMON_URL: &str = "http://127.0.0.1:4100";
const DEFAULT_BACKEND_URL: &str = "http://127.0.0.1:4173";
const BACKEND_HEALTH: &str = "http://127.0.0.1:4173/api/health";
const FRONTEND_URL: &str = "http://localhost:5173/";

/// Strip one layer of matching surrounding quotes. Users commonly quote
/// `server.url` / `server.token` (and `daemon_url`) in YAML; this launcher's
/// light scanner would otherwise keep the quotes and inject a broken value
/// (malformed API base / a token that never matches).
fn unquote(s: &str) -> &str {
    let b = s.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &s[1..s.len() - 1]
    } else {
        s
    }
}

/// Extract `daemon_url:` from the (YAML) config text via a light line-scan —
/// deliberately avoids pulling a YAML crate into the launcher for one string.
/// Takes the first whitespace-delimited token so a trailing comment is ignored.
fn parse_daemon_url(config_text: &str) -> Option<String> {
    for line in config_text.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("daemon_url:") {
            if let Some(tok) = rest.split_whitespace().next() {
                return Some(unquote(tok).to_string());
            }
        }
    }
    None
}

/// Resolve the daemon URL with the same precedence as the backend client:
/// env override → config → loopback default.
fn resolve_daemon_url(env_override: Option<&str>, config_text: Option<&str>) -> String {
    if let Some(e) = env_override {
        if !e.trim().is_empty() { return e.trim().to_string(); }
    }
    if let Some(c) = config_text {
        if let Some(u) = parse_daemon_url(c) { return u; }
    }
    DEFAULT_DAEMON_URL.to_string()
}

/// A daemon URL is "remote" unless it points at this machine's loopback.
fn is_remote(url: &str) -> bool {
    !(url.contains("127.0.0.1") || url.contains("localhost") || url.contains("::1"))
}

/// Read `MEMORY_DAEMON_URL` / `~/.nexus/config.yaml` to find where the daemon
/// lives. Untested glue over the tested `resolve_daemon_url`.
fn daemon_url() -> String {
    resolve_daemon_url(std::env::var("MEMORY_DAEMON_URL").ok().as_deref(), read_config_text().as_deref())
}

/// Load `~/.nexus/config.yaml` text, if present.
fn read_config_text() -> Option<String> {
    std::env::var("HOME").ok().and_then(|h| {
        std::fs::read_to_string(std::path::Path::new(&h).join(".nexus/config.yaml")).ok()
    })
}

/// Read a nested `section:` → `key: value` from YAML-ish config text via a light
/// indentation scan — deliberately avoids pulling a YAML crate into the launcher
/// for two strings (`server.url`, `server.token`). A flat scan won't do here:
/// `url:`/`token:` are not unique keys (cf. `gateway.token`), so we must find the
/// `server:` block first. Returns the first whitespace-delimited value token
/// (trailing comments ignored).
fn parse_nested_value(config_text: &str, section: &str, key: &str) -> Option<String> {
    let section_header = format!("{section}:");
    let key_prefix = format!("{key}:");
    let mut in_section = false;
    let mut section_indent = 0usize;
    for line in config_text.lines() {
        let trimmed = line.trim_start();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = line.len() - trimmed.len();
        if in_section && indent <= section_indent {
            in_section = false; // dedented out of the section
        }
        if !in_section {
            if indent == 0 && trimmed.starts_with(&section_header) {
                in_section = true;
                section_indent = indent;
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix(&key_prefix) {
            return rest.split_whitespace().next().map(|t| unquote(t).to_string());
        }
    }
    None
}

/// Resolve the backend base URL: `NEXUS_BACKEND_URL` env → config `server.url` →
/// loopback default. A non-loopback result puts the shell in thin-client mode.
fn resolve_backend_url(env_override: Option<&str>, config_text: Option<&str>) -> String {
    if let Some(e) = env_override {
        if !e.trim().is_empty() {
            return e.trim().to_string();
        }
    }
    if let Some(c) = config_text {
        if let Some(u) = parse_nested_value(c, "server", "url") {
            if !u.is_empty() {
                return u;
            }
        }
    }
    DEFAULT_BACKEND_URL.to_string()
}

/// Resolve the backend bearer token: `NEXUS_BACKEND_TOKEN` env → config
/// `server.token` literal. An unexpanded `${...}` placeholder (a copied default)
/// is treated as unset — the launcher does not do env interpolation.
fn resolve_backend_token(env_override: Option<&str>, config_text: Option<&str>) -> String {
    if let Some(e) = env_override {
        if !e.trim().is_empty() {
            return e.trim().to_string();
        }
    }
    if let Some(c) = config_text {
        if let Some(t) = parse_nested_value(c, "server", "token") {
            if !t.is_empty() && !t.starts_with("${") {
                return t;
            }
        }
    }
    String::new()
}

fn backend_url() -> String {
    resolve_backend_url(std::env::var("NEXUS_BACKEND_URL").ok().as_deref(), read_config_text().as_deref())
}

fn backend_token() -> String {
    resolve_backend_token(std::env::var("NEXUS_BACKEND_TOKEN").ok().as_deref(), read_config_text().as_deref())
}

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
    /// Resolved backend base URL (loopback in full-stack mode, the remote host in
    /// thin-client mode). `lib.rs` injects `{backend_url}/api` as window.__NEXUS_API__.
    pub backend_url: String,
    /// True when the backend is remote — the shell spawned no local services.
    pub backend_remote: bool,
    /// Resolved backend bearer token; injected as window.__NEXUS_TOKEN__ when set.
    pub token: String,
}

/// Full boot: daemon (optional) -> models -> backend -> (dev) vite. Calls
/// `emit(key, state, detail)` after each transition to feed the splash.
///
/// `root` is the path from which service directories are resolved:
/// - dev:  repo root (`CARGO_MANIFEST_DIR/../..`)
/// - prod: Tauri resource dir (contains `services/` and `node/`)
pub fn boot<E: Fn(&str, &str, Option<&str>)>(root: std::path::PathBuf, is_dev: bool, emit: E) -> BootResult {
    let mut children = Vec::new();

    // In prod, use the bundled node. In dev, fall back to resolve_node().
    let (node, node_missing) = if is_dev {
        let n = resolve_node().unwrap_or_else(|| "node".into());
        (n, false)
    } else {
        // Prod: prefer bundled node from resources; fall back to resolve_node().
        let bundled = root.join("node/bin/node");
        if bundled.exists() {
            (bundled.to_string_lossy().into_owned(), false)
        } else {
            match resolve_node() {
                Some(n) => (n, false),
                None => (String::new(), true),
            }
        }
    };

    if node_missing {
        return BootResult {
            ready: false,
            degraded: vec![],
            node_missing: true,
            children,
            backend_url: DEFAULT_BACKEND_URL.to_string(),
            backend_remote: false,
            token: String::new(),
        };
    }

    // In prod: services/{backend,daemon} under resource dir.
    // In dev:  src/{backend,memory-daemon} under repo root.
    let (daemon_dir, backend_dir) = if is_dev {
        (root.join("src/memory-daemon"), root.join("src/backend"))
    } else {
        (root.join("services/daemon"), root.join("services/backend"))
    };

    // Thin-client mode: a remote backend (server.url / NEXUS_BACKEND_URL) owns the
    // daemon, models, sessions and DB — the single source of truth. Spawn NOTHING
    // local except the dev-only Vite that serves the UI; just probe the remote
    // backend and gate readiness on it. Mirrors the remote-daemon path below.
    let backend = backend_url();
    let token = backend_token();
    if is_remote(&backend) {
        emit("memory", "skipped", Some("remote backend"));
        emit("models", "skipped", Some("remote backend"));
        emit("backend", "starting", Some("probing remote…"));
        let health = format!("{}/api/health", backend.trim_end_matches('/'));
        let backend_ok = probe(&health, std::time::Duration::from_millis(2500));
        emit(
            "backend",
            if backend_ok { "up" } else { "warn" },
            Some(if backend_ok { "remote" } else { "remote unreachable" }),
        );
        // The UI is the client and stays local: prod loads the bundled bundle,
        // dev still needs Vite to serve it.
        let frontend_ok = if is_dev {
            emit("frontend", "starting", Some("checking…"));
            let fe = root.join("src/frontend");
            let (fstate, fchild) = ensure_service("frontend", FRONTEND_URL, &|| spawn_npm(&fe, &["run", "dev"]));
            let ok = !matches!(fstate, ServiceState::Failed(_));
            emit("frontend", state_label(&fstate), state_detail(&fstate));
            if let Some(c) = fchild {
                children.push(c);
            }
            ok
        } else {
            emit("frontend", "skipped", Some("bundled"));
            true
        };
        return BootResult {
            ready: backend_ok && frontend_ok,
            degraded: vec![],
            node_missing: false,
            children,
            backend_url: backend,
            backend_remote: true,
            token,
        };
    }

    // Daemon (optional, non-gating). A remote daemon (e.g. a central brain over
    // Tailscale, via memory.daemon_url) is a thin-client target — probe it, never
    // spawn a local one. A loopback URL keeps the spawn-if-down behaviour.
    let daemon = daemon_url();
    let daemon_health = format!("{}/health", daemon.trim_end_matches('/'));
    let remote = is_remote(&daemon);
    emit("memory", "starting", Some(if remote { "probing remote…" } else { "checking…" }));
    let mem_ok = if remote {
        if probe(&daemon_health, std::time::Duration::from_millis(2500)) {
            emit("memory", "up", Some("remote"));
            true
        } else {
            emit("memory", "warn", Some("remote unreachable"));
            false
        }
    } else {
        let (mstate, mchild) = ensure_service("memory", &daemon_health, &|| {
            if is_dev { spawn_npm(&daemon_dir, &["start"]) }
            else { spawn_node(&node, &daemon_dir.join("dist/src/index.js"), &daemon_dir) }
        });
        emit("memory", state_label(&mstate), state_detail(&mstate));
        if let Some(c) = mchild { children.push(c); }
        !matches!(mstate, ServiceState::Failed(_))
    };

    // Models off the daemon health blob (warn-only).
    let degraded = if mem_ok {
        emit("models", "starting", Some("probing…"));
        match reqwest::blocking::get(&daemon_health).and_then(|r| r.text()) {
            Ok(body) => { let d = degraded_models(&body);
                emit("models", if d.is_empty() {"up"} else {"warn"}, None); d }
            Err(_) => { emit("models", "warn", Some("unknown")); vec!["gen".into(),"embed".into(),"rerank".into()] }
        }
    } else { emit("models", "warn", Some("daemon down")); vec!["gen".into(),"embed".into(),"rerank".into()] };

    // Backend (gating).
    emit("backend", "starting", Some("checking…"));
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
        let fe = root.join("src/frontend");
        let (fstate, fchild) = ensure_service("frontend", FRONTEND_URL, &|| spawn_npm(&fe, &["run","dev"]));
        let ok = !matches!(fstate, ServiceState::Failed(_));
        emit("frontend", state_label(&fstate), state_detail(&fstate));
        if let Some(c) = fchild { children.push(c); }
        ok
    } else { emit("frontend", "skipped", Some("bundled")); true };

    BootResult {
        ready: backend_ok && frontend_ok,
        degraded,
        node_missing: false,
        children,
        // Full-stack: backend is local. `token` (from env/config) is still
        // injected so this machine's own UI authenticates when a token is set.
        backend_url: backend,
        backend_remote: false,
        token,
    }
}

fn state_label(s: &ServiceState) -> &'static str {
    match s { ServiceState::Reused => "reused", ServiceState::Up => "up", ServiceState::Failed(_) => "failed" }
}
fn state_detail(s: &ServiceState) -> Option<&str> {
    if let ServiceState::Failed(m) = s { Some(m.as_str()) } else { None }
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

    #[test]
    fn parse_daemon_url_reads_the_key() {
        let cfg = "memory:\n  daemon_url: https://baker-pro.taileea629.ts.net:8443\n  auto_inject:\n    enabled: true\n";
        assert_eq!(parse_daemon_url(cfg).as_deref(), Some("https://baker-pro.taileea629.ts.net:8443"));
    }

    #[test]
    fn parse_daemon_url_absent_is_none() {
        assert_eq!(parse_daemon_url("server:\n  port: 4173\n"), None);
    }

    #[test]
    fn resolve_prefers_env_over_config() {
        let r = resolve_daemon_url(Some("http://env:9999"), Some("memory:\n  daemon_url: http://cfg:4100\n"));
        assert_eq!(r, "http://env:9999");
    }

    #[test]
    fn resolve_uses_config_when_no_env() {
        let r = resolve_daemon_url(None, Some("memory:\n  daemon_url: https://baker-pro.taileea629.ts.net:8443\n"));
        assert_eq!(r, "https://baker-pro.taileea629.ts.net:8443");
    }

    #[test]
    fn resolve_falls_back_to_default() {
        assert_eq!(resolve_daemon_url(None, None), "http://127.0.0.1:4100");
    }

    #[test]
    fn is_remote_localhost_variants_are_false() {
        assert!(!is_remote("http://127.0.0.1:4100"));
        assert!(!is_remote("http://localhost:4100/health"));
        assert!(!is_remote("http://[::1]:4100"));
    }

    #[test]
    fn is_remote_tailscale_host_is_true() {
        assert!(is_remote("https://baker-pro.taileea629.ts.net:8443"));
    }

    // A config with BOTH server.token and gateway.token — the nested scan must
    // return the server one, not the first `token:` it happens to see.
    const CFG: &str = "server:\n  port: 4173\n  url: https://baker-pro.taileea629.ts.net:8444\n  token: server-secret\ngateway:\n  enabled: true\n  token: gateway-secret\n";

    #[test]
    fn parse_nested_value_reads_server_url_and_token() {
        assert_eq!(
            parse_nested_value(CFG, "server", "url").as_deref(),
            Some("https://baker-pro.taileea629.ts.net:8444")
        );
        assert_eq!(parse_nested_value(CFG, "server", "token").as_deref(), Some("server-secret"));
        // Not confused by gateway.token appearing later.
        assert_eq!(parse_nested_value(CFG, "gateway", "token").as_deref(), Some("gateway-secret"));
    }

    #[test]
    fn parse_strips_surrounding_quotes() {
        // Users often quote these in YAML (and the README once showed them quoted);
        // the launcher must not keep the quotes, else the injected value breaks.
        let dq = "server:\n  url: \"https://baker-pro.example.ts.net:8444\"\n  token: \"deadbeef00\"\n";
        assert_eq!(
            parse_nested_value(dq, "server", "url").as_deref(),
            Some("https://baker-pro.example.ts.net:8444"),
        );
        assert_eq!(parse_nested_value(dq, "server", "token").as_deref(), Some("deadbeef00"));
        // Single quotes and daemon_url too.
        let sq = "memory:\n  daemon_url: 'https://baker-pro.example.ts.net:8443'\n";
        assert_eq!(parse_daemon_url(sq).as_deref(), Some("https://baker-pro.example.ts.net:8443"));
        // Unquoted still works (no accidental stripping).
        assert_eq!(parse_daemon_url("memory:\n  daemon_url: http://127.0.0.1:4100\n").as_deref(), Some("http://127.0.0.1:4100"));
    }

    #[test]
    fn parse_nested_value_absent_key_is_none() {
        // server block has no `token` here, so it must NOT fall through to gateway.token.
        let cfg = "server:\n  port: 4173\ngateway:\n  token: gateway-secret\n";
        assert_eq!(parse_nested_value(cfg, "server", "token"), None);
    }

    #[test]
    fn resolve_backend_url_precedence() {
        assert_eq!(resolve_backend_url(Some("https://env:8444"), Some(CFG)), "https://env:8444");
        assert_eq!(resolve_backend_url(None, Some(CFG)), "https://baker-pro.taileea629.ts.net:8444");
        assert_eq!(resolve_backend_url(None, None), "http://127.0.0.1:4173");
    }

    #[test]
    fn resolve_backend_token_precedence_and_placeholder() {
        assert_eq!(resolve_backend_token(Some("envtok"), Some(CFG)), "envtok");
        assert_eq!(resolve_backend_token(None, Some(CFG)), "server-secret");
        // An unexpanded ${...} default (copied from DEFAULT_CONFIG) is treated as unset.
        let cfg = "server:\n  token: ${NEXUS_BACKEND_TOKEN}\n";
        assert_eq!(resolve_backend_token(None, Some(cfg)), "");
        assert_eq!(resolve_backend_token(None, None), "");
    }
}
