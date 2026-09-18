//! Explicit, backend-owned installation. Requests start or observe one task;
//! a lost response never starts another download or creates a browser resource.
use super::*;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::os::unix::fs::PermissionsExt;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::task::JoinHandle;

#[cfg(test)]
mod tests;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Installation {
    engine_executable: PathBuf,
    chromium_executable: PathBuf,
}

#[derive(Clone, Deserialize)]
struct Download {
    url: String,
    size: u64,
    sha256: String,
    #[serde(default)]
    executable: String,
}

#[derive(Default)]
struct State {
    task: Option<JoinHandle<Result<(), &'static str>>>,
    failure: Option<&'static str>,
}

impl Drop for State {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[derive(Default)]
pub(super) struct Installer(Mutex<State>);

pub(super) fn config(path: &Path) -> Result<NativeBrowserEngineConfig, BackendDispatchError> {
    let source = crate::private_record::read_bounded(path, 16 * 1024)
        .map_err(|_| BackendDispatchError::terminal("browser_installation_invalid"))?
        .ok_or_else(|| BackendDispatchError::terminal("browser_engine_not_installed"))?;
    let installation: Installation = serde_json::from_slice(&source)
        .map_err(|_| BackendDispatchError::terminal("browser_installation_invalid"))?;
    NativeBrowserEngineConfig::pinned(
        &installation.engine_executable,
        &installation.chromium_executable,
    )
    .map_err(|error| BackendDispatchError::terminal(error.code))
}

impl Installer {
    pub(super) async fn status(&self, path: &Path, start: bool) -> Value {
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            return json!({"state":"unsupported"});
        }
        let mut state = self.0.lock().await;
        if state.task.as_ref().is_some_and(|task| task.is_finished()) {
            state.failure = state
                .task
                .take()
                .unwrap()
                .await
                .unwrap_or(Err("browser_installation_interrupted"))
                .err();
        }
        if state.task.is_some() {
            return json!({"state":"installing"});
        }
        if config(path).is_ok() {
            return json!({"state":"ready"});
        }
        if start {
            state.failure = None;
            let path = path.to_owned();
            state.task = Some(tokio::spawn(async move { install(&path).await }));
            return json!({"state":"installing"});
        }
        match state.failure {
            Some(code) => json!({"state":"failed","code":code}),
            None => json!({"state":"missing"}),
        }
    }

    pub(super) async fn stop(&self) {
        if let Some(task) = self.0.lock().await.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

fn pin(source: &str) -> Download {
    let metadata: Value = serde_json::from_str(source).expect("embedded runtime metadata");
    serde_json::from_value(metadata["platforms"]["darwin-arm64"].clone())
        .expect("embedded macOS runtime pin")
}

async fn install(path: &Path) -> Result<(), &'static str> {
    let parent = path.parent().ok_or("browser_installation_invalid")?;
    let home = parent.parent().ok_or("browser_installation_invalid")?;
    let root = crate::ensure_owner_subdirectory(home, "browser")
        .map_err(|_| "browser_installation_storage_failed")?;
    let versions = crate::ensure_owner_subdirectory(&root, "versions")
        .map_err(|_| "browser_installation_storage_failed")?;
    let staging = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&versions)
        .map_err(|_| "browser_installation_storage_failed")?;
    let engine = pin(include_str!("../../resources/browser-engine.json"));
    let chromium = pin(include_str!("../../resources/browser-chromium.json"));
    let executable = staging.path().join("engine");
    let archive = staging.path().join("chromium.zip");
    download(&engine, &executable).await?;
    download(&chromium, &archive).await?;
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))
        .map_err(|_| "browser_installation_storage_failed")?;
    let mut extract = Command::new("/usr/bin/ditto");
    extract.args(["-x", "-k"]).arg(&archive).arg(staging.path());
    run(
        extract,
        Duration::from_secs(120),
        "browser_installation_extract_failed",
    )
    .await?;
    let chromium_path = staging.path().join(&chromium.executable);
    let canonical =
        std::fs::canonicalize(&chromium_path).map_err(|_| "browser_installation_invalid")?;
    let canonical_root =
        std::fs::canonicalize(staging.path()).map_err(|_| "browser_installation_invalid")?;
    if !canonical.starts_with(canonical_root) {
        return Err("browser_installation_invalid");
    }
    NativeBrowserEngineConfig::pinned(&executable, &chromium_path)
        .map_err(|_| "browser_installation_invalid")?;
    // Keep upstream archive contents, including Chromium's notices. Record the
    // exact upstream downloads with each immutable installed generation.
    std::fs::write(
        staging.path().join("engine-source.json"),
        include_str!("../../resources/browser-engine.json"),
    )
    .map_err(|_| "browser_installation_storage_failed")?;
    std::fs::write(
        staging.path().join("chromium-source.json"),
        include_str!("../../resources/browser-chromium.json"),
    )
    .map_err(|_| "browser_installation_storage_failed")?;
    std::fs::remove_file(archive).map_err(|_| "browser_installation_storage_failed")?;
    let generation = staging
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .replace(".install-", "runtime-");
    let destination = versions.join(generation);
    std::fs::rename(staging.path(), &destination)
        .map_err(|_| "browser_installation_storage_failed")?;
    let installed = Installation {
        engine_executable: destination.join("engine"),
        chromium_executable: destination.join(chromium.executable),
    };
    crate::private_record::write(path, &installed)
        .map_err(|_| "browser_installation_storage_failed")?;
    Ok(())
}

async fn download(pin: &Download, path: &Path) -> Result<(), &'static str> {
    let mut command = Command::new("/usr/bin/curl");
    command
        .args([
            "--disable",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "30",
            "--max-time",
            "300",
            "--max-filesize",
        ])
        .arg(pin.size.to_string())
        .arg("--output")
        .arg(path)
        .arg(&pin.url);
    run(
        command,
        Duration::from_secs(310),
        "browser_installation_download_failed",
    )
    .await?;
    verify_download(pin, path)
}

fn verify_download(pin: &Download, path: &Path) -> Result<(), &'static str> {
    let mut file = std::fs::File::open(path).map_err(|_| "browser_installation_download_failed")?;
    if file
        .metadata()
        .map_err(|_| "browser_installation_download_failed")?
        .len()
        != pin.size
    {
        return Err("browser_installation_pin_mismatch");
    }
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|_| "browser_installation_download_failed")?;
        if size == 0 {
            break;
        }
        digest.update(&buffer[..size]);
    }
    if format!("{:x}", digest.finalize()) != pin.sha256 {
        return Err("browser_installation_pin_mismatch");
    }
    Ok(())
}

async fn run(
    mut command: Command,
    deadline: Duration,
    code: &'static str,
) -> Result<(), &'static str> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(deadline, command.status())
        .await
        .map_err(|_| code)?
        .map_err(|_| code)?;
    if status.success() { Ok(()) } else { Err(code) }
}
