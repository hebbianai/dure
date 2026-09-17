//! Process/socket adapter for the pinned native browser engine. Browser input
//! admission belongs to BrowserResourceHost, not this transport.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use hmux_session_protocol::browser_resource::BrowserTargetId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::{Instant, sleep, timeout};

mod cdp;
mod chromium;
pub(crate) use chromium::profile::retire_storage as retire_profile_storage;
pub mod runtime;
#[cfg(test)]
mod tests;

const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const ENGINE_DEADLINE: Duration = Duration::from_secs(20);
const STARTUP_DEADLINE: Duration = Duration::from_secs(10);
const ENGINE_DISTRIBUTION: &str = include_str!("../resources/browser-engine.json");

#[derive(Clone)]
pub struct NativeBrowserEngineConfig {
    executable: PathBuf,
    chromium: PathBuf,
}

impl NativeBrowserEngineConfig {
    /// Resolve explicit or generation-installed development executables against
    /// the same engine pin used by the installer. No personal profile discovery.
    pub fn pinned(executable: &Path, chromium: &Path) -> Result<Self, BrowserEngineError> {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return Err(BrowserEngineError::before(
                "browser_engine_platform_unavailable",
            ));
        }
        let executable = fs::canonicalize(executable)
            .map_err(|_| BrowserEngineError::before("browser_engine_not_installed"))?;
        let chromium = fs::canonicalize(chromium)
            .map_err(|_| BrowserEngineError::before("browser_chromium_not_installed"))?;
        if !executable.is_file() || !chromium.is_file() {
            return Err(BrowserEngineError::before(
                "browser_engine_installation_invalid",
            ));
        }
        let bytes = fs::read(&executable)
            .map_err(|_| BrowserEngineError::before("browser_engine_unreadable"))?;
        let distribution: Value = serde_json::from_str(ENGINE_DISTRIBUTION)
            .expect("embedded browser engine distribution metadata");
        let digest = distribution["platforms"]["darwin-arm64"]["sha256"]
            .as_str()
            .expect("embedded macOS ARM64 browser engine pin");
        if format!("{:x}", Sha256::digest(bytes)) != digest {
            return Err(BrowserEngineError::before("browser_engine_pin_mismatch"));
        }
        Ok(Self {
            executable,
            chromium,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserEngineError {
    pub code: &'static str,
    /// True means bytes may have reached the engine. It never permits retry.
    pub outcome_unknown: bool,
}

impl BrowserEngineError {
    fn before(code: &'static str) -> Self {
        Self {
            code,
            outcome_unknown: false,
        }
    }

    fn after(code: &'static str) -> Self {
        Self {
            code,
            outcome_unknown: true,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
pub struct NativeBrowserResponse {
    pub id: String,
    pub success: bool,
    #[serde(default)]
    pub data: Value,
    #[serde(default)]
    pub error: Option<String>,
}

pub struct NativeBrowserEngine {
    child: Child,
    chromium: chromium::ChromiumConnection,
    config: NativeBrowserEngineConfig,
    runtime_parent: PathBuf,
    socket: PathBuf,
    root: PathBuf,
    next_request: u64,
    state: WorkerState,
}

#[derive(Clone, Copy, PartialEq)]
enum WorkerState {
    Starting,
    Ready,
    Disconnected,
    Retiring,
    Exited,
}

impl NativeBrowserEngine {
    async fn attach(
        config: &NativeBrowserEngineConfig,
        runtime_root: &Path,
        chromium: chromium::ChromiumConnection,
        target: &BrowserTargetId,
    ) -> Result<Self, BrowserEngineError> {
        let mut engine = Self::spawn(config, runtime_root, chromium)?;
        if let Err(error) = engine.initialize(target).await {
            let _ = engine.close().await;
            return Err(error);
        }
        Ok(engine)
    }

    fn spawn(
        config: &NativeBrowserEngineConfig,
        runtime_root: &Path,
        chromium: chromium::ChromiumConnection,
    ) -> Result<Self, BrowserEngineError> {
        let directory = tempfile::Builder::new()
            .prefix("browser-")
            .tempdir_in(runtime_root)
            .map_err(|_| BrowserEngineError::before("browser_engine_directory_failed"))?;
        fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| BrowserEngineError::before("browser_engine_directory_failed"))?;
        let socket = directory.path().join("worker.sock");
        if socket.as_os_str().len() > 100 {
            return Err(BrowserEngineError::before(
                "browser_engine_socket_path_too_long",
            ));
        }
        let configuration = directory.path().join("config.json");
        fs::write(&configuration, b"{}\n")
            .map_err(|_| BrowserEngineError::before("browser_engine_configuration_failed"))?;
        fs::set_permissions(&configuration, fs::Permissions::from_mode(0o600))
            .map_err(|_| BrowserEngineError::before("browser_engine_configuration_failed"))?;
        // Worker scratch and configuration never contain the browser profile.
        let root = directory.keep();
        let child = Command::new(&config.executable)
            .current_dir(&root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "en_US.UTF-8")
            .env("TMPDIR", &root)
            .env("AGENT_BROWSER_DAEMON", "1")
            .env("AGENT_BROWSER_SESSION", "worker")
            .env("AGENT_BROWSER_SOCKET_DIR", &root)
            .env("AGENT_BROWSER_CONFIG", &configuration)
            .env("AGENT_BROWSER_CDP", chromium.endpoint())
            .env("AGENT_BROWSER_NO_WEBMCP", "1")
            .env("AGENT_BROWSER_NO_AUTO_DIALOG", "1")
            .env("AGENT_BROWSER_DEFAULT_TIMEOUT", "5000")
            .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let child = child.map_err(|_| BrowserEngineError::before("browser_engine_spawn_failed"))?;
        // Preserve worker evidence paths until explicit resource retirement.
        // A dropped request must not delete files underneath a running worker.
        Ok(Self {
            child,
            chromium,
            config: config.clone(),
            runtime_parent: runtime_root.to_owned(),
            socket,
            root,
            next_request: 1,
            state: WorkerState::Starting,
        })
    }

    async fn initialize(&mut self, target: &BrowserTargetId) -> Result<(), BrowserEngineError> {
        let engine = self;
        {
            let deadline = Instant::now() + STARTUP_DEADLINE;
            loop {
                match UnixStream::connect(&engine.socket).await {
                    Ok(stream) => {
                        drop(stream);
                        break;
                    }
                    Err(_) if Instant::now() < deadline => sleep(Duration::from_millis(25)).await,
                    Err(_) => {
                        return Err(BrowserEngineError::before("browser_engine_startup_timeout"));
                    }
                }
            }
            engine.require(json!({"action":"stream_disable"})).await?;
            let state = engine.require(json!({"action":"stream_status"})).await?;
            if state["enabled"] != false || !state["port"].is_null() {
                return Err(BrowserEngineError::before(
                    "browser_engine_input_listener_enabled",
                ));
            }
            // Startup must never navigate an existing page. Resolve the exact
            // owner-supplied target and pin it before exposing this worker.
            let tabs = engine.require(json!({"action":"tab_list"})).await?;
            let tab = tabs["tabs"]
                .as_array()
                .and_then(|tabs| {
                    tabs.iter()
                        .find(|tab| tab["targetId"].as_str() == Some(target.as_str()))
                })
                .and_then(|tab| tab["tabId"].as_str())
                .ok_or_else(|| BrowserEngineError::before("browser_engine_target_missing"))?;
            engine
                .require(json!({"action":"tab_switch","tabId":tab,"pinTab":true}))
                .await?;
            let tabs = engine.require(json!({"action":"tab_list"})).await?;
            if !tabs["tabs"].as_array().is_some_and(|tabs| {
                tabs.iter().any(|tab| {
                    tab["active"] == true && tab["targetId"].as_str() == Some(target.as_str())
                })
            }) {
                return Err(BrowserEngineError::before("browser_engine_target_mismatch"));
            }
            engine.state = WorkerState::Ready;
            Ok(())
        }
    }

    pub fn runtime_root(&self) -> &Path {
        &self.root
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }

    fn disconnected(&self) -> bool {
        self.state == WorkerState::Disconnected
    }

    // The containing instance holds its worker lock across these transitions.
    // Reconnection stores the replacement child before its first async wait.
    fn start_reconnect(&mut self) -> Result<(), BrowserEngineError> {
        if !self.disconnected() {
            return Err(BrowserEngineError::before(
                "browser_engine_not_disconnected",
            ));
        }
        *self = Self::spawn(&self.config, &self.runtime_parent, self.chromium.clone())?;
        Ok(())
    }

    async fn finish_reconnect(
        &mut self,
        target: &BrowserTargetId,
    ) -> Result<(), BrowserEngineError> {
        if let Err(error) = self.initialize(target).await {
            self.close().await?;
            return Err(error);
        }
        Ok(())
    }

    async fn disconnect(&mut self) -> Result<(), BrowserEngineError> {
        self.close().await?;
        self.state = WorkerState::Disconnected;
        Ok(())
    }

    // Only the containing product adapter constructs engine commands. Public
    // clients never submit engine setup, global shutdown or arbitrary JSON.
    pub(super) async fn request(
        &mut self,
        mut command: Value,
    ) -> Result<NativeBrowserResponse, BrowserEngineError> {
        if !matches!(self.state, WorkerState::Starting | WorkerState::Ready)
            && !(self.state == WorkerState::Retiring && command["action"] == "close")
        {
            return Err(BrowserEngineError::before("browser_engine_exited"));
        }
        let id = format!("request:{}", self.next_request);
        self.next_request = self
            .next_request
            .checked_add(1)
            .ok_or_else(|| BrowserEngineError::before("browser_engine_request_exhausted"))?;
        let object = command
            .as_object_mut()
            .ok_or_else(|| BrowserEngineError::before("browser_engine_request_invalid"))?;
        object.insert("id".into(), Value::String(id.clone()));
        let mut bytes = serde_json::to_vec(&command)
            .map_err(|_| BrowserEngineError::before("browser_engine_request_invalid"))?;
        bytes.push(b'\n');
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(BrowserEngineError::before(
                "browser_engine_request_too_large",
            ));
        }
        let mut stream = timeout(ENGINE_DEADLINE, UnixStream::connect(&self.socket))
            .await
            .map_err(|_| BrowserEngineError::before("browser_engine_connect_timeout"))?
            .map_err(|_| BrowserEngineError::before("browser_engine_unavailable"))?;
        timeout(ENGINE_DEADLINE, async {
            stream
                .write_all(&bytes)
                .await
                .map_err(|_| BrowserEngineError::after("browser_engine_write_failed"))?;
            let mut source = Vec::new();
            let mut reader = BufReader::new(stream.take(MAX_RESPONSE_BYTES + 1));
            reader
                .read_until(b'\n', &mut source)
                .await
                .map_err(|_| BrowserEngineError::after("browser_engine_read_failed"))?;
            if source.len() as u64 > MAX_RESPONSE_BYTES || !source.ends_with(b"\n") {
                return Err(BrowserEngineError::after(
                    "browser_engine_response_incomplete",
                ));
            }
            let response: NativeBrowserResponse = serde_json::from_slice(&source)
                .map_err(|_| BrowserEngineError::after("browser_engine_response_invalid"))?;
            if response.id != id {
                return Err(BrowserEngineError::after(
                    "browser_engine_response_mismatch",
                ));
            }
            Ok(response)
        })
        .await
        .map_err(|_| BrowserEngineError::after("browser_engine_response_timeout"))?
    }

    pub(super) async fn require(&mut self, command: Value) -> Result<Value, BrowserEngineError> {
        let response = self.request(command).await?;
        if !response.success {
            // A negative response can follow a partial effect. Never classify
            // it as proof that dispatch did not happen.
            return Err(BrowserEngineError::after("browser_engine_rejected"));
        }
        Ok(response.data)
    }

    pub async fn close(&mut self) -> Result<(), BrowserEngineError> {
        if matches!(self.state, WorkerState::Exited | WorkerState::Disconnected) {
            self.state = WorkerState::Exited;
            return Ok(());
        }
        self.state = WorkerState::Retiring;
        let response = self.request(json!({"action":"close"})).await;
        let deadline = Instant::now() + STARTUP_DEADLINE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => {
                    self.state = WorkerState::Exited;
                    return Ok(());
                }
                Ok(None) if Instant::now() < deadline => sleep(Duration::from_millis(25)).await,
                _ => break,
            }
        }
        response?;
        Err(BrowserEngineError::after(
            "browser_engine_retirement_unconfirmed",
        ))
    }
}

// Only an explicit, confirmed disconnection permits a replacement worker.
// Unexpected exits and ambiguous retirements never trigger browser relaunch.
