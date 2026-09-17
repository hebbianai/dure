//! Host operations shared by GUI actions and the connected-client command path.
use super::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

fn key(target: &Target) -> String {
    format!("{:?}:{}", target.platform, target.id)
}
fn operations() -> &'static Mutex<HashSet<String>> {
    static VALUE: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    VALUE.get_or_init(Mutex::default)
}
pub(super) struct DeviceOperation(String);
impl DeviceOperation {
    pub(super) fn acquire(target: &Target) -> Result<Self, String> {
        validate_target(target)?;
        let key = key(target);
        if !operations()
            .lock()
            .map_err(|_| "Device operation lock unavailable")?
            .insert(key.clone())
        {
            return Err("This device is busy in another operation. Wait for it to finish before issuing a new command".into());
        }
        Ok(Self(key))
    }
}
impl Drop for DeviceOperation {
    fn drop(&mut self) {
        if let Ok(mut active) = operations().lock() {
            active.remove(&self.0);
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentAction {
    at_ms: u128,
    kind: String,
    succeeded: bool,
}
fn history() -> &'static Mutex<HashMap<String, VecDeque<RecentAction>>> {
    static VALUE: OnceLock<Mutex<HashMap<String, VecDeque<RecentAction>>>> = OnceLock::new();
    VALUE.get_or_init(Mutex::default)
}
pub(super) fn record(target: &Target, kind: &str, result: &Result<(), String>) {
    if let Ok(mut history) = history().lock() {
        if history.len() >= 128 && !history.contains_key(&key(target)) {
            return;
        }
        let actions = history.entry(key(target)).or_default();
        if actions.len() == 20 {
            actions.pop_front();
        }
        actions.push_back(RecentAction {
            at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            kind: kind.into(),
            succeeded: result.is_ok(),
        });
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProfile {
    pub project_path: String,
    pub build_command: String,
    pub artifact_path: String,
    pub app_id: String,
    pub url: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub build_output: String,
}

fn build(profile: &RunProfile) -> Result<String, String> {
    app_identifier(&profile.app_id)?;
    let cwd = std::fs::canonicalize(&profile.project_path).map_err(|e| e.to_string())?;
    if !cwd.is_dir() || profile.build_command.len() > 8192 {
        return Err("Choose a project directory and a bounded build command".into());
    }
    if profile.build_command.trim().is_empty() {
        return Ok(String::new());
    }
    let mut command = if cfg!(windows) {
        CommandSpec::new("cmd.exe")
    } else {
        login_command("sh", &cwd)?
    };
    command
        .args([
            if cfg!(windows) { "/C" } else { "-c" },
            &profile.build_command,
        ])
        .current_dir(cwd)
        .capture_stderr(true)
        .on_output_limit(OutputLimitAction::TerminateProcessTree);
    let output = hebbian_bounded_process::run(&command, Duration::from_secs(300), 1024 * 1024)
        .map_err(|e| format!("Build failed: {}", e.stage()))?;
    let log = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.exceeded_limit {
        return Err("Build output exceeded 1 MiB; reduce build verbosity and retry".into());
    }
    if !output.status.success() {
        return Err(format!(
            "Build failed; app was not installed:\n{}",
            tail(&log, 16000)
        ));
    }
    Ok(tail(&log, 16000))
}
fn tail(value: &str, limit: usize) -> String {
    let mut start = value.len().saturating_sub(limit);
    while !value.is_char_boundary(start) {
        start += 1;
    }
    value[start..].into()
}

#[tauri::command]
pub async fn mobile_simulator_run(
    target: Target,
    profile: RunProfile,
) -> Result<RunResult, String> {
    background(move || run(target, profile)).await
}

fn run(target: Target, profile: RunProfile) -> Result<RunResult, String> {
    let _guard = DeviceOperation::acquire(&target)?;
    let result = (|| {
        // Observe identity before building; installation re-observes readiness.
        observe_target(&target)?;
        let build_output = build(&profile)?;
        if target.platform == Platform::Ios {
            perform(&target, Action::Boot)?;
        }
        if !profile.artifact_path.trim().is_empty() {
            let path = PathBuf::from(&profile.project_path).join(&profile.artifact_path);
            perform(
                &target,
                Action::Install {
                    path: path.to_string_lossy().into_owned(),
                },
            )?;
        }
        perform(
            &target,
            Action::Launch {
                app_id: profile.app_id,
            },
        )?;
        if !profile.url.trim().is_empty() {
            perform(&target, Action::OpenUrl { url: profile.url })?;
        }
        Ok(RunResult { build_output })
    })();
    record(
        &target,
        "run_profile",
        &result.as_ref().map(|_| ()).map_err(Clone::clone),
    );
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticReport {
    device: Device,
    app_id: String,
    logs: String,
    log_error: Option<String>,
    recent_actions: Vec<RecentAction>,
}
#[tauri::command]
pub async fn mobile_simulator_report(
    target: Target,
    app_id: String,
) -> Result<DiagnosticReport, String> {
    background(move || report(target, app_id)).await
}

fn report(target: Target, app_id: String) -> Result<DiagnosticReport, String> {
    app_identifier(&app_id)?;
    let device = observe_target(&target)?;
    let logs = match target.platform {
        Platform::Android => (|| {
            let pid = execute(
                &adb(),
                &["-s", &target.id, "shell", "pidof", &app_id],
                10,
                8192,
            )?;
            let pid = String::from_utf8_lossy(&pid).trim().to_string();
            if pid.is_empty() || !pid.bytes().all(|c| c.is_ascii_digit()) {
                return Err("App is not running or has multiple processes; select its main process in Android Studio".into());
            }
            execute(
                &adb(),
                &["-s", &target.id, "logcat", "-d", "-t", "200", "--pid", &pid],
                15,
                256 * 1024,
            )
        })(),
        Platform::Ios => execute(
            "/usr/bin/xcrun",
            &[
                "simctl",
                "spawn",
                &target.id,
                "log",
                "show",
                "--last",
                "2m",
                "--style",
                "compact",
                "--predicate",
                &format!("subsystem == '{app_id}'"),
            ],
            15,
            256 * 1024,
        ),
    };
    let (logs, log_error) = match logs {
        Ok(bytes) => (tail(&String::from_utf8_lossy(&bytes), 16000), None),
        Err(error) => (String::new(), Some(error)),
    };
    let recent_actions = history()
        .lock()
        .map_err(|_| "Action history unavailable")?
        .get(&key(&target))
        .map(|actions| actions.iter().cloned().collect())
        .unwrap_or_default();
    Ok(DiagnosticReport {
        device,
        app_id,
        logs,
        log_error,
        recent_actions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn device_operations_exclude_other_callers_until_completion() {
        let target = Target {
            platform: Platform::Android,
            id: "qa-locked-device".into(),
        };
        let first = DeviceOperation::acquire(&target).unwrap();
        assert!(DeviceOperation::acquire(&target).is_err());
        drop(first);
        assert!(DeviceOperation::acquire(&target).is_ok());
    }
    #[test]
    fn failed_build_returns_its_output() {
        let root = tempfile::tempdir().unwrap();
        let profile = RunProfile {
            project_path: root.path().to_string_lossy().into(),
            build_command: if cfg!(windows) {
                "echo build-reproduction & exit /b 7"
            } else {
                "echo build-reproduction; exit 7"
            }
            .into(),
            artifact_path: String::new(),
            app_id: "com.dure.qa".into(),
            url: String::new(),
        };
        assert!(build(&profile).unwrap_err().contains("build-reproduction"));
    }
    #[test]
    fn diagnostic_tail_never_splits_utf8() {
        assert_eq!(tail("한글abc", 5), "abc");
    }
}
