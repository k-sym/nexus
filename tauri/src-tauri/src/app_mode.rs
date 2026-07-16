#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AppMode {
    Client,
    Server,
}

pub fn resolve(backend_url: &str, override_value: Option<&str>) -> AppMode {
    match override_value
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("client") => return AppMode::Client,
        Some("server") => return AppMode::Server,
        Some(value) if !value.is_empty() => {
            eprintln!("[mode] ignoring invalid NEXUS_APP_MODE={value:?}; expected client or server")
        }
        _ => {}
    }

    if super::supervisor::is_remote_url(backend_url) {
        AppMode::Client
    } else {
        AppMode::Server
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_server_and_remote_is_client() {
        assert_eq!(resolve("http://127.0.0.1:4173", None), AppMode::Server);
        assert_eq!(
            resolve("https://baker-pro.example:8444", None),
            AppMode::Client
        );
    }

    #[test]
    fn explicit_override_wins() {
        assert_eq!(
            resolve("https://remote.example", Some("server")),
            AppMode::Server
        );
        assert_eq!(
            resolve("http://localhost:4173", Some("CLIENT")),
            AppMode::Client
        );
    }

    #[test]
    fn invalid_override_is_ignored() {
        assert_eq!(
            resolve("https://remote.example", Some("desktop")),
            AppMode::Client
        );
    }
}
