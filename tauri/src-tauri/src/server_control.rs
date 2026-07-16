use serde::Deserialize;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const LABEL: &str = "com.k-sym.nexus-backend";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HealthState {
    Healthy,
    Unavailable,
}

impl HealthState {
    pub fn label(self) -> &'static str {
        match self {
            Self::Healthy => "Healthy",
            Self::Unavailable => "Unavailable",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ServerStatus {
    pub backend: HealthState,
    pub memory: HealthState,
    pub generation: HealthState,
    pub embedding: HealthState,
    pub reranking: HealthState,
    pub local_chat: HealthState,
}

#[derive(Deserialize, Default)]
struct ModelFlags {
    gen: Option<bool>,
    embed: Option<bool>,
    rerank: Option<bool>,
}
#[derive(Deserialize, Default)]
struct MemoryHealth {
    models: Option<ModelFlags>,
}

fn state(value: bool) -> HealthState {
    if value {
        HealthState::Healthy
    } else {
        HealthState::Unavailable
    }
}

pub fn sample_status() -> ServerStatus {
    let timeout = Duration::from_millis(1500);
    let backend = std::thread::spawn(move || {
        super::health::probe("http://127.0.0.1:4173/api/health", timeout)
    });
    let chat =
        std::thread::spawn(move || super::health::probe("http://127.0.0.1:8081/health", timeout));

    let memory_response = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .ok()
        .and_then(|client| client.get("http://127.0.0.1:4100/health").send().ok())
        .filter(|response| response.status().is_success())
        .and_then(|response| response.text().ok())
        .and_then(|body| serde_json::from_str::<MemoryHealth>(&body).ok());
    let memory_ok = memory_response.is_some();
    let models = memory_response
        .and_then(|health| health.models)
        .unwrap_or_default();

    ServerStatus {
        backend: state(backend.join().unwrap_or(false)),
        memory: state(memory_ok),
        generation: state(models.gen == Some(true)),
        embedding: state(models.embed == Some(true)),
        reranking: state(models.rerank == Some(true)),
        local_chat: state(chat.join().unwrap_or(false)),
    }
}

#[derive(Clone, Copy)]
pub enum Action {
    Start,
    Stop,
    Restart,
}

pub trait CommandRunner: Send + Sync {
    fn run(&self, args: &[String]) -> Result<(), String>;
}

pub struct SystemRunner;
impl CommandRunner for SystemRunner {
    fn run(&self, args: &[String]) -> Result<(), String> {
        let mut child = Command::new("/bin/launchctl")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not run launchctl: {e}"))?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("launchctl timed out after 5 seconds".into());
                }
                Err(error) => return Err(format!("could not wait for launchctl: {error}")),
            }
        }
        let output = child
            .wait_with_output()
            .map_err(|e| format!("could not read launchctl result: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        let detail = String::from_utf8_lossy(&output.stderr);
        Err(detail.trim().chars().take(500).collect())
    }
}

pub struct LaunchdController<R: CommandRunner> {
    runner: R,
    uid: u32,
    plist: PathBuf,
}

impl LaunchdController<SystemRunner> {
    pub fn system() -> Result<Self, String> {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
        Ok(Self {
            runner: SystemRunner,
            uid: unsafe { libc::getuid() },
            plist: PathBuf::from(home)
                .join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
        })
    }
}

impl<R: CommandRunner> LaunchdController<R> {
    #[cfg(test)]
    fn new(runner: R, uid: u32, plist: PathBuf) -> Self {
        Self { runner, uid, plist }
    }

    fn domain(&self) -> String {
        format!("gui/{}", self.uid)
    }
    fn service(&self) -> String {
        format!("{}/{}", self.domain(), LABEL)
    }

    pub fn perform(&self, action: Action) -> Result<(), String> {
        match action {
            Action::Stop => {
                self.runner.run(&["disable".into(), self.service()])?;
                // An already-unloaded service is the desired stopped state.
                let _ = self.runner.run(&["bootout".into(), self.service()]);
                Ok(())
            }
            Action::Start | Action::Restart => {
                if !self.plist.is_file() {
                    return Err(format!(
                        "Server agent is not installed at {}",
                        self.plist.display()
                    ));
                }
                self.runner.run(&["enable".into(), self.service()])?;
                // Bootstrap is needed only when unloaded; failure commonly means it is already loaded.
                let _ = self.runner.run(&[
                    "bootstrap".into(),
                    self.domain(),
                    self.plist.to_string_lossy().into_owned(),
                ]);
                let mut kickstart = vec!["kickstart".into()];
                if matches!(action, Action::Restart) {
                    kickstart.push("-k".into());
                }
                kickstart.push(self.service());
                self.runner.run(&kickstart)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Fake(Mutex<Vec<Vec<String>>>);
    impl CommandRunner for Fake {
        fn run(&self, args: &[String]) -> Result<(), String> {
            self.0.lock().unwrap().push(args.to_vec());
            Ok(())
        }
    }

    #[test]
    fn stop_disables_before_bootout() {
        let fake = Fake(Mutex::new(vec![]));
        let controller = LaunchdController::new(fake, 501, PathBuf::from("unused"));
        controller.perform(Action::Stop).unwrap();
        let calls = controller.runner.0.lock().unwrap();
        assert_eq!(calls[0][0], "disable");
        assert_eq!(calls[1][0], "bootout");
        assert_eq!(calls[0][1], "gui/501/com.k-sym.nexus-backend");
    }

    #[test]
    fn start_requires_installed_plist() {
        let controller = LaunchdController::new(
            Fake(Mutex::new(vec![])),
            501,
            PathBuf::from("/definitely/missing.plist"),
        );
        assert!(controller
            .perform(Action::Start)
            .unwrap_err()
            .contains("not installed"));
    }
}
