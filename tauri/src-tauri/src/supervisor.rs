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
