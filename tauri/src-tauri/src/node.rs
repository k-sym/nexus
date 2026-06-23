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
